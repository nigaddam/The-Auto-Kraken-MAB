"""SQLite persistence: candles, signals (+ audit trail), manual positions,
runtime arm state, and the kill switch.

This is the single source of truth shared between the signal engine and the
(future) execution engine, so the two layers stay decoupled: the signal
engine writes rows here, the executor reads and updates them.
"""

from __future__ import annotations

import sqlite3
import uuid
from collections.abc import Iterable
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

from kraken_guard.models import (
    Candle,
    PositionRegistration,
    Side,
    Signal,
    SignalStatus,
    StrategyMode,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS candles (
    symbol TEXT NOT NULL,
    interval_minutes INTEGER NOT NULL,
    ts TEXT NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL,
    PRIMARY KEY (symbol, interval_minutes, ts)
);

CREATE TABLE IF NOT EXISTS signals (
    id TEXT PRIMARY KEY,
    asset TEXT NOT NULL,
    strategy_mode TEXT NOT NULL,
    candle_interval_minutes INTEGER NOT NULL,
    trigger_candle_ts TEXT NOT NULL,
    trigger_close REAL NOT NULL,
    sma_fast REAL NOT NULL,
    sma_slow REAL NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    data_source TEXT NOT NULL,
    status TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    executed_at TEXT
);

CREATE TABLE IF NOT EXISTS signal_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (signal_id) REFERENCES signals (id)
);

CREATE TABLE IF NOT EXISTS positions (
    symbol TEXT PRIMARY KEY,
    expected_side TEXT NOT NULL,
    approx_entry_price REAL NOT NULL,
    expected_value_min_usd REAL NOT NULL,
    expected_value_max_usd REAL NOT NULL,
    registered_at TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    max_age_minutes INTEGER,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS close_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    executed_at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    before_screenshot TEXT,
    after_screenshot TEXT
);

CREATE TABLE IF NOT EXISTS arm_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    armed_until TEXT,
    token_hash TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS kill_switch (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    active INTEGER NOT NULL DEFAULT 0,
    activated_at TEXT,
    reason TEXT
);
"""


def _to_iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).isoformat()


def _from_iso(s: str) -> datetime:
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


class Database:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> Database:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ---------------------------------------------------------------- candles
    def upsert_candles(self, candles: Iterable[Candle]) -> None:
        with closing(self._conn.cursor()) as cur:
            for c in candles:
                cur.execute(
                    """
                    INSERT INTO candles
                        (symbol, interval_minutes, ts, open, high, low, close, volume)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(symbol, interval_minutes, ts) DO UPDATE SET
                        open=excluded.open, high=excluded.high, low=excluded.low,
                        close=excluded.close, volume=excluded.volume
                    """,
                    (
                        c.symbol,
                        c.interval_minutes,
                        _to_iso(c.ts),
                        c.open,
                        c.high,
                        c.low,
                        c.close,
                        c.volume,
                    ),
                )
        self._conn.commit()

    def get_recent_candles(self, symbol: str, interval_minutes: int, limit: int) -> list[Candle]:
        cur = self._conn.execute(
            """
            SELECT * FROM candles WHERE symbol = ? AND interval_minutes = ?
            ORDER BY ts DESC LIMIT ?
            """,
            (symbol, interval_minutes, limit),
        )
        rows = cur.fetchall()
        candles = [
            Candle(
                symbol=r["symbol"],
                interval_minutes=r["interval_minutes"],
                ts=_from_iso(r["ts"]),
                open=r["open"],
                high=r["high"],
                low=r["low"],
                close=r["close"],
                volume=r["volume"],
            )
            for r in rows
        ]
        candles.reverse()  # ascending by ts
        return candles

    def prune_old_candles(self, symbol: str, interval_minutes: int, keep: int) -> None:
        cur = self._conn.execute(
            """
            SELECT ts FROM candles WHERE symbol = ? AND interval_minutes = ?
            ORDER BY ts DESC LIMIT 1 OFFSET ?
            """,
            (symbol, interval_minutes, keep),
        )
        row = cur.fetchone()
        if row is None:
            return
        cutoff = row["ts"]
        self._conn.execute(
            "DELETE FROM candles WHERE symbol = ? AND interval_minutes = ? AND ts < ?",
            (symbol, interval_minutes, cutoff),
        )
        self._conn.commit()

    # ---------------------------------------------------------------- signals
    def insert_signal(self, signal: Signal) -> bool:
        """Returns False (no insert) if idempotency_key already exists."""
        try:
            self._conn.execute(
                """
                INSERT INTO signals (
                    id, asset, strategy_mode, candle_interval_minutes, trigger_candle_ts,
                    trigger_close, sma_fast, sma_slow, reason, created_at, data_source,
                    status, idempotency_key, executed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    signal.id,
                    signal.asset,
                    signal.strategy_mode.value,
                    signal.candle_interval_minutes,
                    _to_iso(signal.trigger_candle_ts),
                    signal.trigger_close,
                    signal.sma_fast,
                    signal.sma_slow,
                    signal.reason,
                    _to_iso(signal.created_at),
                    signal.data_source,
                    signal.status.value,
                    signal.idempotency_key,
                    _to_iso(signal.executed_at) if signal.executed_at else None,
                ),
            )
        except sqlite3.IntegrityError:
            return False
        self._record_event(signal.id, None, signal.status, "created")
        self._conn.commit()
        return True

    def _row_to_signal(self, r: sqlite3.Row) -> Signal:
        return Signal(
            id=r["id"],
            asset=r["asset"],
            strategy_mode=StrategyMode(r["strategy_mode"]),
            candle_interval_minutes=r["candle_interval_minutes"],
            trigger_candle_ts=_from_iso(r["trigger_candle_ts"]),
            trigger_close=r["trigger_close"],
            sma_fast=r["sma_fast"],
            sma_slow=r["sma_slow"],
            reason=r["reason"],
            created_at=_from_iso(r["created_at"]),
            data_source=r["data_source"],
            status=SignalStatus(r["status"]),
            idempotency_key=r["idempotency_key"],
            executed_at=_from_iso(r["executed_at"]) if r["executed_at"] else None,
        )

    def get_signal(self, signal_id: str) -> Signal | None:
        cur = self._conn.execute("SELECT * FROM signals WHERE id = ?", (signal_id,))
        row = cur.fetchone()
        return self._row_to_signal(row) if row else None

    def get_signal_by_idempotency_key(self, key: str) -> Signal | None:
        cur = self._conn.execute("SELECT * FROM signals WHERE idempotency_key = ?", (key,))
        row = cur.fetchone()
        return self._row_to_signal(row) if row else None

    def get_last_signal_for_asset(self, asset: str) -> Signal | None:
        cur = self._conn.execute(
            "SELECT * FROM signals WHERE asset = ? ORDER BY created_at DESC LIMIT 1",
            (asset,),
        )
        row = cur.fetchone()
        return self._row_to_signal(row) if row else None

    def count_executed_since(self, since: datetime) -> int:
        cur = self._conn.execute(
            "SELECT COUNT(*) AS n FROM signals WHERE status IN (?, ?) AND executed_at >= ?",
            (SignalStatus.EXECUTED.value, SignalStatus.VERIFIED.value, _to_iso(since)),
        )
        return int(cur.fetchone()["n"])

    def update_signal_status(
        self, signal_id: str, new_status: SignalStatus, detail: str = ""
    ) -> None:
        current = self.get_signal(signal_id)
        old_status = current.status if current else None
        executed_at = _to_iso(datetime.now(UTC)) if new_status == SignalStatus.EXECUTED else None
        if new_status == SignalStatus.EXECUTED:
            self._conn.execute(
                "UPDATE signals SET status = ?, executed_at = ? WHERE id = ?",
                (new_status.value, executed_at, signal_id),
            )
        else:
            self._conn.execute(
                "UPDATE signals SET status = ? WHERE id = ?",
                (new_status.value, signal_id),
            )
        self._record_event(signal_id, old_status, new_status, detail)
        self._conn.commit()

    def _record_event(
        self,
        signal_id: str,
        from_status: SignalStatus | None,
        to_status: SignalStatus,
        detail: str,
    ) -> None:
        self._conn.execute(
            "INSERT INTO signal_events (signal_id, ts, from_status, to_status, detail) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                signal_id,
                _to_iso(datetime.now(UTC)),
                from_status.value if from_status else None,
                to_status.value,
                detail,
            ),
        )

    def list_signals(
        self, asset: str | None = None, status: SignalStatus | None = None, limit: int = 50
    ) -> list[Signal]:
        query = "SELECT * FROM signals WHERE 1=1"
        params: list[object] = []
        if asset is not None:
            query += " AND asset = ?"
            params.append(asset)
        if status is not None:
            query += " AND status = ?"
            params.append(status.value)
        query += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        cur = self._conn.execute(query, params)
        return [self._row_to_signal(r) for r in cur.fetchall()]

    def list_pending_signals(self) -> list[Signal]:
        pending_statuses = (
            SignalStatus.DETECTED.value,
            SignalStatus.DRY_RUN_RECORDED.value,
            SignalStatus.WAITING_FOR_ARM.value,
            SignalStatus.EXECUTION_STARTED.value,
        )
        placeholders = ",".join("?" for _ in pending_statuses)
        cur = self._conn.execute(
            f"SELECT * FROM signals WHERE status IN ({placeholders}) ORDER BY created_at DESC",
            pending_statuses,
        )
        return [self._row_to_signal(r) for r in cur.fetchall()]

    # -------------------------------------------------------------- positions
    def upsert_position(self, pos: PositionRegistration) -> None:
        self._conn.execute(
            """
            INSERT INTO positions (
                symbol, expected_side, approx_entry_price, expected_value_min_usd,
                expected_value_max_usd, registered_at, enabled, max_age_minutes, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol) DO UPDATE SET
                expected_side=excluded.expected_side,
                approx_entry_price=excluded.approx_entry_price,
                expected_value_min_usd=excluded.expected_value_min_usd,
                expected_value_max_usd=excluded.expected_value_max_usd,
                registered_at=excluded.registered_at,
                enabled=excluded.enabled,
                max_age_minutes=excluded.max_age_minutes,
                notes=excluded.notes
            """,
            (
                pos.symbol,
                pos.expected_side.value,
                pos.approx_entry_price,
                pos.expected_value_min_usd,
                pos.expected_value_max_usd,
                _to_iso(pos.registered_at),
                1 if pos.enabled else 0,
                pos.max_age_minutes,
                pos.notes,
            ),
        )
        self._conn.commit()

    def _row_to_position(self, r: sqlite3.Row) -> PositionRegistration:
        return PositionRegistration(
            symbol=r["symbol"],
            expected_side=Side(r["expected_side"]),
            approx_entry_price=r["approx_entry_price"],
            expected_value_min_usd=r["expected_value_min_usd"],
            expected_value_max_usd=r["expected_value_max_usd"],
            registered_at=_from_iso(r["registered_at"]),
            enabled=bool(r["enabled"]),
            max_age_minutes=r["max_age_minutes"],
            notes=r["notes"],
        )

    def get_position(self, symbol: str) -> PositionRegistration | None:
        cur = self._conn.execute("SELECT * FROM positions WHERE symbol = ?", (symbol,))
        row = cur.fetchone()
        return self._row_to_position(row) if row else None

    def list_positions(self, enabled_only: bool = False) -> list[PositionRegistration]:
        query = "SELECT * FROM positions"
        if enabled_only:
            query += " WHERE enabled = 1"
        cur = self._conn.execute(query + " ORDER BY symbol")
        return [self._row_to_position(r) for r in cur.fetchall()]

    def set_position_enabled(self, symbol: str, enabled: bool) -> bool:
        cur = self._conn.execute(
            "UPDATE positions SET enabled = ? WHERE symbol = ?", (1 if enabled else 0, symbol)
        )
        self._conn.commit()
        return cur.rowcount > 0

    def remove_position(self, symbol: str) -> bool:
        cur = self._conn.execute("DELETE FROM positions WHERE symbol = ?", (symbol,))
        self._conn.commit()
        return cur.rowcount > 0

    # -------------------------------------------------------------- arm state
    def set_armed(self, armed_until: datetime, token_hash: str) -> None:
        now = _to_iso(datetime.now(UTC))
        self._conn.execute(
            """
            INSERT INTO arm_state (id, armed_until, token_hash, created_at) VALUES (1, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET armed_until=excluded.armed_until,
                token_hash=excluded.token_hash, created_at=excluded.created_at
            """,
            (_to_iso(armed_until), token_hash, now),
        )
        self._conn.commit()

    def get_arm_state(self) -> tuple[datetime, str] | None:
        cur = self._conn.execute("SELECT armed_until, token_hash FROM arm_state WHERE id = 1")
        row = cur.fetchone()
        if row is None or row["armed_until"] is None:
            return None
        return _from_iso(row["armed_until"]), row["token_hash"]

    def clear_arm(self) -> None:
        self._conn.execute("DELETE FROM arm_state WHERE id = 1")
        self._conn.commit()

    # ------------------------------------------------------------ kill switch
    def set_killed(self, reason: str) -> None:
        self._conn.execute(
            """
            INSERT INTO kill_switch (id, active, activated_at, reason) VALUES (1, 1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET active=1, activated_at=excluded.activated_at,
                reason=excluded.reason
            """,
            (_to_iso(datetime.now(UTC)), reason),
        )
        self._conn.commit()

    def clear_killed(self) -> None:
        self._conn.execute(
            "INSERT INTO kill_switch (id, active, activated_at, reason) VALUES (1, 0, NULL, NULL) "
            "ON CONFLICT(id) DO UPDATE SET active=0, activated_at=NULL, reason=NULL"
        )
        self._conn.commit()

    def is_killed(self) -> tuple[bool, str | None]:
        cur = self._conn.execute("SELECT active, reason FROM kill_switch WHERE id = 1")
        row = cur.fetchone()
        if row is None:
            return False, None
        return bool(row["active"]), row["reason"]


def new_signal_id() -> str:
    return str(uuid.uuid4())
