"""Shared data models for kraken_guard.

These are plain, storage-agnostic representations. Persistence lives in
database.py; these models are what strategy/, execution/, and cli.py pass
around in memory.
"""

from __future__ import annotations

import enum
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class Side(enum.StrEnum):
    LONG = "LONG"
    SHORT = "SHORT"


class StrategyMode(enum.StrEnum):
    CONFIRMED_BEARISH_CROSS = "CONFIRMED_BEARISH_CROSS"
    PRICE_BELOW_SMA7 = "PRICE_BELOW_SMA7"
    SMA7_CROSSES_BELOW_SMA30 = "SMA7_CROSSES_BELOW_SMA30"
    PRICE_AND_SMA_CONFIRMATION = "PRICE_AND_SMA_CONFIRMATION"
    TRAILING_PEAK_PROTECTION = "TRAILING_PEAK_PROTECTION"


IMPLEMENTED_STRATEGY_MODES = frozenset({StrategyMode.CONFIRMED_BEARISH_CROSS})


class SignalStatus(enum.StrEnum):
    DETECTED = "DETECTED"
    DRY_RUN_RECORDED = "DRY_RUN_RECORDED"
    WAITING_FOR_ARM = "WAITING_FOR_ARM"
    EXECUTION_STARTED = "EXECUTION_STARTED"
    EXECUTED = "EXECUTED"
    VERIFIED = "VERIFIED"
    FAILED = "FAILED"
    BLOCKED_BY_SAFETY = "BLOCKED_BY_SAFETY"
    EXPIRED = "EXPIRED"


TERMINAL_SIGNAL_STATUSES = frozenset(
    {
        SignalStatus.VERIFIED,
        SignalStatus.FAILED,
        SignalStatus.BLOCKED_BY_SAFETY,
        SignalStatus.EXPIRED,
    }
)


class Candle(BaseModel):
    model_config = ConfigDict(frozen=True)

    symbol: str
    interval_minutes: int
    ts: datetime  # candle open time, UTC
    open: float
    high: float
    low: float
    close: float
    volume: float

    def is_valid(self) -> bool:
        values = (self.open, self.high, self.low, self.close, self.volume)
        if any(v != v for v in values):  # NaN check
            return False
        if any(v <= 0 for v in (self.open, self.high, self.low, self.close)):
            return False
        return not self.volume < 0


class Signal(BaseModel):
    model_config = ConfigDict(frozen=False)

    id: str
    asset: str
    strategy_mode: StrategyMode
    candle_interval_minutes: int
    trigger_candle_ts: datetime
    trigger_close: float
    sma_fast: float
    sma_slow: float
    reason: str
    created_at: datetime
    data_source: str
    status: SignalStatus = SignalStatus.DETECTED
    idempotency_key: str
    executed_at: datetime | None = None

    def is_expired(self, now: datetime, expiry_minutes: int) -> bool:
        age = (now - self.created_at).total_seconds() / 60.0
        return age > expiry_minutes


class PositionRegistration(BaseModel):
    """What the user tells the safety system to expect. Never places a trade."""

    symbol: str
    expected_side: Side = Side.LONG
    approx_entry_price: float
    expected_value_min_usd: float
    expected_value_max_usd: float
    registered_at: datetime
    enabled: bool = True
    max_age_minutes: int | None = None
    notes: str | None = None


class SMAResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    ts: datetime
    close: float
    sma_fast: float | None
    sma_slow: float | None


class DataValidationError(enum.StrEnum):
    STALE_DATA = "STALE_DATA"
    INSUFFICIENT_CANDLES = "INSUFFICIENT_CANDLES"
    DUPLICATE_OR_OUT_OF_ORDER_TIMESTAMPS = "DUPLICATE_OR_OUT_OF_ORDER_TIMESTAMPS"
    MALFORMED_PRICE = "MALFORMED_PRICE"
    SYMBOL_MISMATCH = "SYMBOL_MISMATCH"
    MISSING_CANDLES = "MISSING_CANDLES"


class ValidationResult(BaseModel):
    ok: bool
    errors: list[DataValidationError] = Field(default_factory=list)
    detail: str = ""
