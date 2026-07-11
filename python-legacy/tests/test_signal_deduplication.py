from datetime import UTC, datetime, timedelta

import pytest

from kraken_guard.config import (
    AppConfig,
    AssetConfig,
    ExecutionConfig,
    MarketDataConfig,
    NotificationsConfig,
    Settings,
)
from kraken_guard.database import Database, new_signal_id
from kraken_guard.market_data.base import MarketDataProvider
from kraken_guard.models import Candle, Signal, SignalStatus, StrategyMode
from kraken_guard.services.notifications import Notifier
from kraken_guard.strategy.signal_engine import SignalEngine, build_idempotency_key

SYMBOL = "JTO/USD"
INTERVAL = 5


class FakeProvider(MarketDataProvider):
    name = "fake"

    def __init__(self, candles: list[Candle]):
        self._candles = candles

    async def fetch_completed_candles(
        self, data_symbol: str, interval_minutes: int, count: int
    ) -> list[Candle]:
        return self._candles[-count:]


def make_recent_candles(closes: list[float]) -> list[Candle]:
    now = datetime.now(UTC)
    last_open = now - timedelta(minutes=INTERVAL)
    last_open = last_open.replace(second=0, microsecond=0)
    start = last_open - timedelta(minutes=INTERVAL * (len(closes) - 1))
    candles = []
    for i, close in enumerate(closes):
        ts = start + timedelta(minutes=INTERVAL * i)
        candles.append(
            Candle(
                symbol=SYMBOL,
                interval_minutes=INTERVAL,
                ts=ts,
                open=close,
                high=close + 0.01,
                low=close - 0.01,
                close=close,
                volume=100.0,
            )
        )
    return candles


def make_settings(db_path: str, cooldown_minutes: int = 60) -> Settings:
    return Settings(
        app=AppConfig(dry_run=True, live_execution_enabled=False, database_path=db_path),
        market_data=MarketDataConfig(
            min_candles_required=5,
            max_data_age_minutes=15,
            candle_history_size=100,
            poll_seconds=30,
        ),
        execution=ExecutionConfig(
            signal_expiry_minutes=10, max_closes_per_hour=1, max_closes_per_day=2
        ),
        assets={
            "JTO": AssetConfig(
                data_symbol=SYMBOL,
                ui_symbol="JTO",
                route_symbol="jto-usd",
                expected_value_min_usd=400,
                expected_value_max_usd=650,
                candle_interval_minutes=INTERVAL,
                fast_sma=3,
                slow_sma=7,
                strategy_mode=StrategyMode.CONFIRMED_BEARISH_CROSS,
                cooldown_minutes=cooldown_minutes,
            )
        },
        notifications=NotificationsConfig(macos=False, telegram=False),
    )


def make_signal(asset: str = "JTO", **overrides: object) -> Signal:
    defaults: dict[str, object] = dict(
        id=new_signal_id(),
        asset=asset,
        strategy_mode=StrategyMode.CONFIRMED_BEARISH_CROSS,
        candle_interval_minutes=INTERVAL,
        trigger_candle_ts=datetime.now(UTC),
        trigger_close=1.0,
        sma_fast=1.1,
        sma_slow=1.2,
        reason="test",
        created_at=datetime.now(UTC),
        data_source="fake",
        status=SignalStatus.DETECTED,
        idempotency_key=build_idempotency_key(
            asset, "CONFIRMED_BEARISH_CROSS", INTERVAL, datetime.now(UTC)
        ),
    )
    defaults.update(overrides)
    return Signal(**defaults)  # type: ignore[arg-type]


def test_duplicate_idempotency_key_rejected(tmp_path: object) -> None:
    db = Database(str(tmp_path) + "/db.sqlite")
    sig = make_signal()
    assert db.insert_signal(sig) is True
    duplicate = make_signal(id=new_signal_id())
    duplicate.idempotency_key = sig.idempotency_key
    assert db.insert_signal(duplicate) is False
    db.close()


def test_signal_persists_across_restart(tmp_path: object) -> None:
    path = str(tmp_path) + "/db.sqlite"
    db1 = Database(path)
    sig = make_signal()
    db1.insert_signal(sig)
    db1.close()

    db2 = Database(path)
    fetched = db2.get_signal(sig.id)
    assert fetched is not None
    assert fetched.idempotency_key == sig.idempotency_key
    db2.close()


def test_expired_signal_marked_expired(tmp_path: object) -> None:
    settings = make_settings(str(tmp_path) + "/db.sqlite")
    db = Database(settings.app.database_path)
    old_signal = make_signal(created_at=datetime.now(UTC) - timedelta(minutes=30))
    db.insert_signal(old_signal)

    provider = FakeProvider([])
    engine = SignalEngine(db, settings, provider, Notifier(settings.notifications))
    expired_count = engine.expire_stale_signals()

    assert expired_count == 1
    assert db.get_signal(old_signal.id).status == SignalStatus.EXPIRED
    db.close()


def test_cooldown_suppresses_repeat_signal(tmp_path: object) -> None:
    settings = make_settings(str(tmp_path) + "/db.sqlite", cooldown_minutes=60)
    db = Database(settings.app.database_path)
    cfg = settings.assets["JTO"]
    engine = SignalEngine(db, settings, FakeProvider([]), Notifier(settings.notifications))

    assert engine._in_cooldown("JTO", cfg) is False

    db.insert_signal(make_signal(asset="JTO", created_at=datetime.now(UTC)))
    assert engine._in_cooldown("JTO", cfg) is True
    db.close()


def test_cooldown_expires_after_configured_minutes(tmp_path: object) -> None:
    settings = make_settings(str(tmp_path) + "/db.sqlite", cooldown_minutes=30)
    db = Database(settings.app.database_path)
    cfg = settings.assets["JTO"]
    engine = SignalEngine(db, settings, FakeProvider([]), Notifier(settings.notifications))

    db.insert_signal(
        make_signal(asset="JTO", created_at=datetime.now(UTC) - timedelta(minutes=31))
    )
    assert engine._in_cooldown("JTO", cfg) is False
    db.close()


@pytest.mark.asyncio
async def test_no_duplicate_signal_for_same_candle(tmp_path: object) -> None:
    settings = make_settings(str(tmp_path) + "/db.sqlite", cooldown_minutes=0)
    db = Database(settings.app.database_path)
    notifier = Notifier(settings.notifications)

    closes = [10.0] * 7 + [5.0]
    candles = make_recent_candles(closes)
    provider = FakeProvider(candles)
    engine = SignalEngine(db, settings, provider, notifier)

    first_signal = await engine.evaluate_asset("JTO")
    assert first_signal is not None

    # Same exact candle data again (e.g. re-poll before the next candle closes).
    second_signal = await engine.evaluate_asset("JTO")
    assert second_signal is None
    db.close()
