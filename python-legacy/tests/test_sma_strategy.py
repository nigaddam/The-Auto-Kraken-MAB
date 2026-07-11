from datetime import UTC, datetime, timedelta

import pytest

from kraken_guard.models import Candle, DataValidationError, StrategyMode
from kraken_guard.strategy.sma_strategy import (
    compute_sma_series,
    evaluate_confirmed_bearish_cross,
    evaluate_strategy,
    validate_candles,
)

SYMBOL = "JTO/USD"
INTERVAL = 5


def make_candles(closes: list[float], start: datetime | None = None) -> list[Candle]:
    start = start or datetime(2026, 1, 1, tzinfo=UTC)
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


def test_sma_matches_manual_average() -> None:
    closes = [1, 2, 3, 4, 5, 6, 7]
    candles = make_candles(closes)
    results = compute_sma_series(candles, fast=3, slow=7)
    # SMA3 at the last candle = avg(5,6,7)
    assert results[-1].sma_fast == pytest.approx(6.0)
    # SMA7 at the last candle = avg(1..7)
    assert results[-1].sma_slow == pytest.approx(4.0)


def test_sma_none_until_window_filled() -> None:
    candles = make_candles([1, 2, 3])
    results = compute_sma_series(candles, fast=5, slow=10)
    assert all(r.sma_fast is None for r in results)
    assert all(r.sma_slow is None for r in results)


def test_no_look_ahead_bias() -> None:
    closes = [1, 2, 3, 4, 5, 6, 7]
    candles = make_candles(closes)
    results_full = compute_sma_series(candles, fast=3, slow=7)
    sma_at_index_4_full = results_full[4].sma_fast

    # Truncate to only the candles available "at the time" (index 0..4)
    truncated = candles[:5]
    results_truncated = compute_sma_series(truncated, fast=3, slow=7)
    sma_at_index_4_truncated = results_truncated[4].sma_fast

    assert sma_at_index_4_full == sma_at_index_4_truncated

    # Changing a future close must not change a past SMA value.
    closes_future_changed = [1, 2, 3, 4, 5, 999, 7]
    candles_changed = make_candles(closes_future_changed)
    results_changed = compute_sma_series(candles_changed, fast=3, slow=7)
    assert results_changed[4].sma_fast == sma_at_index_4_full


def test_confirmed_bearish_cross_triggers() -> None:
    # Build closes so that at the second-to-last candle close >= SMA_fast,
    # and at the last candle close < SMA_fast < SMA_slow.
    closes = [10, 10, 10, 10, 10, 10, 10, 10, 5]
    candles = make_candles(closes)
    results = compute_sma_series(candles, fast=3, slow=7)
    triggered, reason = evaluate_confirmed_bearish_cross(results)
    assert triggered
    assert "crossed below" in reason


def test_confirmed_bearish_cross_does_not_trigger_on_uptrend() -> None:
    closes = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    candles = make_candles(closes)
    results = compute_sma_series(candles, fast=3, slow=7)
    triggered, _ = evaluate_confirmed_bearish_cross(results)
    assert not triggered


def test_evaluate_strategy_rejects_unimplemented_modes() -> None:
    candles = make_candles([1, 2, 3, 4, 5, 6, 7])
    results = compute_sma_series(candles, fast=3, slow=7)
    with pytest.raises(NotImplementedError):
        evaluate_strategy(StrategyMode.PRICE_BELOW_SMA7, results, confirmation_candles=1)


def test_validate_candles_detects_insufficient_history() -> None:
    candles = make_candles([1, 2, 3])
    result = validate_candles(
        candles,
        expected_symbol=SYMBOL,
        min_required=31,
        interval_minutes=INTERVAL,
        max_data_age_minutes=8,
        now=candles[-1].ts + timedelta(minutes=INTERVAL),
    )
    assert not result.ok
    assert DataValidationError.INSUFFICIENT_CANDLES in result.errors


def test_validate_candles_detects_stale_data() -> None:
    candles = make_candles(list(range(1, 40)))
    stale_now = candles[-1].ts + timedelta(minutes=60)
    result = validate_candles(
        candles,
        expected_symbol=SYMBOL,
        min_required=31,
        interval_minutes=INTERVAL,
        max_data_age_minutes=8,
        now=stale_now,
    )
    assert not result.ok
    assert DataValidationError.STALE_DATA in result.errors


def test_validate_candles_detects_symbol_mismatch() -> None:
    candles = make_candles(list(range(1, 40)))
    candles[0] = candles[0].model_copy(update={"symbol": "XPL/USD"})
    result = validate_candles(
        candles,
        expected_symbol=SYMBOL,
        min_required=31,
        interval_minutes=INTERVAL,
        max_data_age_minutes=8,
        now=candles[-1].ts + timedelta(minutes=INTERVAL),
    )
    assert not result.ok
    assert DataValidationError.SYMBOL_MISMATCH in result.errors


def test_validate_candles_detects_missing_candles() -> None:
    candles = make_candles(list(range(1, 40)))
    # Remove one candle in the middle to create a gap.
    del candles[20]
    result = validate_candles(
        candles,
        expected_symbol=SYMBOL,
        min_required=31,
        interval_minutes=INTERVAL,
        max_data_age_minutes=8,
        now=candles[-1].ts + timedelta(minutes=INTERVAL),
    )
    assert not result.ok
    assert DataValidationError.MISSING_CANDLES in result.errors


def test_validate_candles_detects_duplicate_timestamps() -> None:
    candles = make_candles(list(range(1, 40)))
    candles[5] = candles[5].model_copy(update={"ts": candles[4].ts})
    result = validate_candles(
        candles,
        expected_symbol=SYMBOL,
        min_required=31,
        interval_minutes=INTERVAL,
        max_data_age_minutes=8,
        now=candles[-1].ts + timedelta(minutes=INTERVAL),
    )
    assert not result.ok
    assert DataValidationError.DUPLICATE_OR_OUT_OF_ORDER_TIMESTAMPS in result.errors


def test_validate_candles_detects_malformed_price() -> None:
    candles = make_candles(list(range(1, 40)))
    candles[10] = candles[10].model_copy(update={"close": -5.0})
    result = validate_candles(
        candles,
        expected_symbol=SYMBOL,
        min_required=31,
        interval_minutes=INTERVAL,
        max_data_age_minutes=8,
        now=candles[-1].ts + timedelta(minutes=INTERVAL),
    )
    assert not result.ok
    assert DataValidationError.MALFORMED_PRICE in result.errors
