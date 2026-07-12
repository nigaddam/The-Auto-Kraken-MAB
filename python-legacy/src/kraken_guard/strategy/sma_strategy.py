"""SMA calculation and candle validation.

Only completed candles must ever be passed in here. SMA at index i is
computed strictly from candles[i-period+1 : i+1] (pandas rolling mean over
data already in ascending time order) — there is no look-ahead into future
candles.

A word of caution on naming: with N-period SMAs on 5-minute candles,
SMA7 covers 35 minutes and SMA30 covers 150 minutes — NOT "7 days" or
"30 days". The same fast/slow periods on 4-hour or daily candles cover a
completely different span of real time. See the README for the full table.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pandas as pd

from kraken_guard.models import (
    IMPLEMENTED_STRATEGY_MODES,
    Candle,
    DataValidationError,
    SMAResult,
    StrategyMode,
    ValidationResult,
)


def validate_candles(
    candles: list[Candle],
    expected_symbol: str,
    min_required: int,
    interval_minutes: int,
    max_data_age_minutes: int,
    now: datetime | None = None,
) -> ValidationResult:
    now = now or datetime.now(UTC)
    errors: list[DataValidationError] = []

    if not candles:
        return ValidationResult(
            ok=False,
            errors=[DataValidationError.INSUFFICIENT_CANDLES],
            detail="no candles available",
        )

    mismatched = [c for c in candles if c.symbol != expected_symbol]
    if mismatched:
        errors.append(DataValidationError.SYMBOL_MISMATCH)

    if len(candles) < min_required:
        errors.append(DataValidationError.INSUFFICIENT_CANDLES)

    timestamps = [c.ts for c in candles]
    if len(set(timestamps)) != len(timestamps) or timestamps != sorted(timestamps):
        errors.append(DataValidationError.DUPLICATE_OR_OUT_OF_ORDER_TIMESTAMPS)
    else:
        expected_gap = pd.Timedelta(minutes=interval_minutes)
        for prev, curr in zip(candles, candles[1:], strict=False):
            if (curr.ts - prev.ts) > expected_gap:
                errors.append(DataValidationError.MISSING_CANDLES)
                break

    if any(not c.is_valid() for c in candles):
        errors.append(DataValidationError.MALFORMED_PRICE)

    latest = candles[-1]
    candle_close_time = latest.ts + pd.Timedelta(minutes=interval_minutes)
    age_minutes = (now - candle_close_time).total_seconds() / 60.0
    if age_minutes > max_data_age_minutes:
        errors.append(DataValidationError.STALE_DATA)

    detail = "; ".join(e.value for e in errors)
    return ValidationResult(ok=not errors, errors=errors, detail=detail)


def compute_sma_series(candles: list[Candle], fast: int, slow: int) -> list[SMAResult]:
    """Compute SMA(fast) and SMA(slow) aligned to each candle, ascending order.
    Values before a window is filled are None (never backfilled/estimated)."""
    if not candles:
        return []
    closes = pd.Series([c.close for c in candles], dtype="float64")
    sma_fast = closes.rolling(window=fast, min_periods=fast).mean()
    sma_slow = closes.rolling(window=slow, min_periods=slow).mean()

    results: list[SMAResult] = []
    for i, c in enumerate(candles):
        f = sma_fast.iloc[i]
        s = sma_slow.iloc[i]
        results.append(
            SMAResult(
                ts=c.ts,
                close=c.close,
                sma_fast=None if pd.isna(f) else float(f),
                sma_slow=None if pd.isna(s) else float(s),
            )
        )
    return results


def evaluate_confirmed_bearish_cross(sma_results: list[SMAResult]) -> tuple[bool, str]:
    """previous close >= previous SMA7, current close < current SMA7, and
    current SMA7 < current SMA30. Compares only the two most recent completed
    candles; never looks at the forming candle."""
    if len(sma_results) < 2:
        return False, "insufficient completed SMA points"
    prev, curr = sma_results[-2], sma_results[-1]
    if prev.sma_fast is None or curr.sma_fast is None or curr.sma_slow is None:
        return False, "SMA not yet available (not enough history)"
    condition = (
        prev.close >= prev.sma_fast
        and curr.close < curr.sma_fast
        and curr.sma_fast < curr.sma_slow
    )
    if condition:
        reason = (
            f"close {curr.close} crossed below SMA_fast {curr.sma_fast:.6f} "
            f"(prev close {prev.close} >= prev SMA_fast {prev.sma_fast:.6f}); "
            f"SMA_fast {curr.sma_fast:.6f} < SMA_slow {curr.sma_slow:.6f}"
        )
        return True, reason
    return False, "condition not met"


def evaluate_strategy(
    mode: StrategyMode, sma_results: list[SMAResult], confirmation_candles: int
) -> tuple[bool, str]:
    if mode not in IMPLEMENTED_STRATEGY_MODES:
        raise NotImplementedError(
            f"Strategy mode {mode.value} is not implemented in this stage of the rollout. "
            f"Implemented modes: {sorted(m.value for m in IMPLEMENTED_STRATEGY_MODES)}"
        )
    if mode == StrategyMode.CONFIRMED_BEARISH_CROSS:
        return evaluate_confirmed_bearish_cross(sma_results)
    raise NotImplementedError(mode.value)  # pragma: no cover — unreachable given the guard above
