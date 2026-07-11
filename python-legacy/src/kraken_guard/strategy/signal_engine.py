"""Orchestrates market data -> validation -> SMA -> strategy -> persisted Signal.

This module never touches a browser. It writes Signal rows to SQLite; the
(future) execution engine reads those rows and decides whether to act. That
persistent record is the decoupling point between the two layers.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from kraken_guard.config import AssetConfig, Settings
from kraken_guard.database import Database, new_signal_id
from kraken_guard.market_data.base import MarketDataError, MarketDataProvider
from kraken_guard.models import Signal, SignalStatus
from kraken_guard.services.notifications import Notifier
from kraken_guard.strategy.sma_strategy import (
    compute_sma_series,
    evaluate_strategy,
    validate_candles,
)

logger = logging.getLogger(__name__)


def build_idempotency_key(
    asset_key: str, strategy_mode: str, candle_interval_minutes: int, trigger_ts: datetime
) -> str:
    return f"{asset_key}:{strategy_mode}:{candle_interval_minutes}:{trigger_ts.isoformat()}"


class SignalEngine:
    def __init__(
        self,
        db: Database,
        settings: Settings,
        provider: MarketDataProvider,
        notifier: Notifier | None = None,
    ):
        self.db = db
        self.settings = settings
        self.provider = provider
        self.notifier = notifier or Notifier(settings.notifications)

    def expire_stale_signals(self, now: datetime | None = None) -> int:
        now = now or datetime.now(UTC)
        expiry_minutes = self.settings.execution.signal_expiry_minutes
        expired = 0
        for sig in self.db.list_pending_signals():
            if sig.is_expired(now, expiry_minutes):
                self.db.update_signal_status(
                    sig.id, SignalStatus.EXPIRED, detail="expired before execution"
                )
                expired += 1
        return expired

    async def evaluate_asset(self, asset_key: str) -> Signal | None:
        cfg = self.settings.assets.get(asset_key)
        if cfg is None or not cfg.enabled:
            return None

        try:
            fresh_candles = await self.provider.fetch_completed_candles(
                cfg.data_symbol,
                cfg.candle_interval_minutes,
                self.settings.market_data.candle_history_size,
            )
        except MarketDataError as exc:
            logger.warning("market_data_error", extra={"asset": asset_key, "error": str(exc)})
            self.notifier.notify("Data source error", f"{asset_key}: {exc}")
            return None

        self.db.upsert_candles(fresh_candles)
        self.db.prune_old_candles(
            cfg.data_symbol,
            cfg.candle_interval_minutes,
            self.settings.market_data.candle_history_size,
        )
        candles = self.db.get_recent_candles(
            cfg.data_symbol,
            cfg.candle_interval_minutes,
            self.settings.market_data.candle_history_size,
        )

        validation = validate_candles(
            candles,
            expected_symbol=cfg.data_symbol,
            min_required=self.settings.market_data.min_candles_required,
            interval_minutes=cfg.candle_interval_minutes,
            max_data_age_minutes=self.settings.market_data.max_data_age_minutes,
        )
        if not validation.ok:
            logger.warning(
                "candle_validation_failed",
                extra={"asset": asset_key, "errors": [e.value for e in validation.errors]},
            )
            self.notifier.notify(
                "Stale or invalid market data", f"{asset_key}: {validation.detail}"
            )
            return None

        sma_results = compute_sma_series(candles, cfg.fast_sma, cfg.slow_sma)
        triggered, reason = evaluate_strategy(
            cfg.strategy_mode, sma_results, cfg.confirmation_candles
        )
        if not triggered:
            return None

        if self._in_cooldown(asset_key, cfg):
            logger.info("signal_suppressed_cooldown", extra={"asset": asset_key})
            return None

        curr = sma_results[-1]
        # guaranteed non-None by evaluate_strategy having triggered
        assert curr.sma_fast is not None
        assert curr.sma_slow is not None
        idempotency_key = build_idempotency_key(
            asset_key, cfg.strategy_mode.value, cfg.candle_interval_minutes, curr.ts
        )
        if self.db.get_signal_by_idempotency_key(idempotency_key) is not None:
            return None

        status = (
            SignalStatus.DRY_RUN_RECORDED if self.settings.app.dry_run else SignalStatus.DETECTED
        )
        signal = Signal(
            id=new_signal_id(),
            asset=asset_key,
            strategy_mode=cfg.strategy_mode,
            candle_interval_minutes=cfg.candle_interval_minutes,
            trigger_candle_ts=curr.ts,
            trigger_close=curr.close,
            sma_fast=curr.sma_fast,
            sma_slow=curr.sma_slow,
            reason=reason,
            created_at=datetime.now(UTC),
            data_source=self.provider.name,
            status=status,
            idempotency_key=idempotency_key,
        )

        inserted = self.db.insert_signal(signal)
        if not inserted:
            return None

        logger.info(
            "signal_detected",
            extra={"asset": asset_key, "signal_id": signal.id, "reason": reason},
        )
        title = "Dry-run sell signal" if self.settings.app.dry_run else "Sell signal detected"
        self.notifier.notify(
            title,
            f"{asset_key}: {reason} (close={curr.close}, SMA_fast={curr.sma_fast:.6f}, "
            f"SMA_slow={curr.sma_slow:.6f})",
        )
        return signal

    def _in_cooldown(self, asset_key: str, cfg: AssetConfig) -> bool:
        last = self.db.get_last_signal_for_asset(asset_key)
        if last is None:
            return False
        age_minutes = (datetime.now(UTC) - last.created_at).total_seconds() / 60.0
        return age_minutes < cfg.cooldown_minutes
