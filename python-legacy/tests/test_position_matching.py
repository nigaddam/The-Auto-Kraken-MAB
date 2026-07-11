from datetime import UTC, datetime

from kraken_guard.config import AssetConfig
from kraken_guard.execution.safety import ScrapedPosition, match_scraped_position
from kraken_guard.models import PositionRegistration, Side, StrategyMode

CFG = AssetConfig(
    data_symbol="JTO/USD",
    ui_symbol="JTO",
    route_symbol="jto-usd",
    expected_value_min_usd=400,
    expected_value_max_usd=650,
    strategy_mode=StrategyMode.CONFIRMED_BEARISH_CROSS,
)

REGISTRATION = PositionRegistration(
    symbol="JTO",
    expected_side=Side.LONG,
    approx_entry_price=0.6,
    expected_value_min_usd=400,
    expected_value_max_usd=650,
    registered_at=datetime.now(UTC),
)


def test_exact_match_passes() -> None:
    scraped = [ScrapedPosition(symbol="JTO", side=Side.LONG, value_usd=500)]
    result = match_scraped_position(CFG, REGISTRATION, scraped)
    assert result.allowed


def test_no_matching_symbol_blocks() -> None:
    scraped = [ScrapedPosition(symbol="XPL", side=Side.LONG, value_usd=500)]
    result = match_scraped_position(CFG, REGISTRATION, scraped)
    assert not result.allowed
    assert any("no open position row found" in r for r in result.blocking_reasons)


def test_partial_symbol_is_not_a_match() -> None:
    # "JTO2" must never match "JTO" — exact match only, never substring/prefix.
    scraped = [ScrapedPosition(symbol="JTO2", side=Side.LONG, value_usd=500)]
    result = match_scraped_position(CFG, REGISTRATION, scraped)
    assert not result.allowed


def test_duplicate_matching_rows_block() -> None:
    scraped = [
        ScrapedPosition(symbol="JTO", side=Side.LONG, value_usd=500),
        ScrapedPosition(symbol="JTO", side=Side.LONG, value_usd=510),
    ]
    result = match_scraped_position(CFG, REGISTRATION, scraped)
    assert not result.allowed
    assert any("more than one matching" in r for r in result.blocking_reasons)


def test_short_side_blocks() -> None:
    scraped = [ScrapedPosition(symbol="JTO", side=Side.SHORT, value_usd=500)]
    result = match_scraped_position(CFG, REGISTRATION, scraped)
    assert not result.allowed
    assert any("not LONG" in r for r in result.blocking_reasons)


def test_value_below_tolerance_blocks() -> None:
    scraped = [ScrapedPosition(symbol="JTO", side=Side.LONG, value_usd=100)]
    result = match_scraped_position(CFG, REGISTRATION, scraped)
    assert not result.allowed
    assert any("outside expected range" in r for r in result.blocking_reasons)


def test_value_above_tolerance_blocks() -> None:
    scraped = [ScrapedPosition(symbol="JTO", side=Side.LONG, value_usd=5000)]
    result = match_scraped_position(CFG, REGISTRATION, scraped)
    assert not result.allowed
    assert any("outside expected range" in r for r in result.blocking_reasons)


def test_value_at_exact_boundaries_passes() -> None:
    for value in (REGISTRATION.expected_value_min_usd, REGISTRATION.expected_value_max_usd):
        scraped = [ScrapedPosition(symbol="JTO", side=Side.LONG, value_usd=value)]
        result = match_scraped_position(CFG, REGISTRATION, scraped)
        assert result.allowed
