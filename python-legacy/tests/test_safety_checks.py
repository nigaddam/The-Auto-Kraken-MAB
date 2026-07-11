from datetime import UTC, datetime, timedelta

from kraken_guard.config import (
    AppConfig,
    AssetConfig,
    ExecutionConfig,
    MarketDataConfig,
    NotificationsConfig,
    Settings,
)
from kraken_guard.database import Database, new_signal_id
from kraken_guard.execution.safety import (
    check_execution_limits,
    check_global_arming,
    check_position_registration,
    check_signal_freshness,
    full_preflight_check,
)
from kraken_guard.models import PositionRegistration, Side, Signal, SignalStatus, StrategyMode

INTERVAL = 5


def make_settings(db_path: str, **overrides: object) -> Settings:
    execution_kwargs = dict(
        require_runtime_arm=True,
        signal_expiry_minutes=10,
        max_closes_per_hour=1,
        max_closes_per_day=2,
    )
    execution_kwargs.update(overrides)
    return Settings(
        app=AppConfig(dry_run=True, live_execution_enabled=False, database_path=db_path),
        market_data=MarketDataConfig(),
        execution=ExecutionConfig(**execution_kwargs),  # type: ignore[arg-type]
        assets={
            "JTO": AssetConfig(
                data_symbol="JTO/USD",
                ui_symbol="JTO",
                route_symbol="jto-usd",
                expected_value_min_usd=400,
                expected_value_max_usd=650,
                candle_interval_minutes=INTERVAL,
                strategy_mode=StrategyMode.CONFIRMED_BEARISH_CROSS,
            )
        },
        notifications=NotificationsConfig(macos=False, telegram=False),
    )


def make_signal(**overrides: object) -> Signal:
    defaults: dict[str, object] = dict(
        id=new_signal_id(),
        asset="JTO",
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
        idempotency_key=f"JTO:{datetime.now(UTC).isoformat()}",
    )
    defaults.update(overrides)
    return Signal(**defaults)  # type: ignore[arg-type]


def test_dry_run_blocks(tmp_path: object) -> None:
    settings = make_settings(str(tmp_path) + "/db.sqlite")
    db = Database(settings.app.database_path)
    result = check_global_arming(settings, db)
    assert not result.allowed
    assert any("DRY_RUN" in r for r in result.blocking_reasons)
    db.close()


def test_live_execution_disabled_blocks(tmp_path: object) -> None:
    settings = make_settings(str(tmp_path) + "/db.sqlite")
    settings.app.dry_run = False
    db = Database(settings.app.database_path)
    result = check_global_arming(settings, db)
    assert not result.allowed
    assert any("LIVE_EXECUTION_ENABLED" in r for r in result.blocking_reasons)
    db.close()


def test_unarmed_blocks(tmp_path: object) -> None:
    settings = make_settings(str(tmp_path) + "/db.sqlite")
    settings.app.dry_run = False
    settings.app.live_execution_enabled = True
    db = Database(settings.app.database_path)
    result = check_global_arming(settings, db)
    assert not result.allowed
    assert any("arming token is absent" in r for r in result.blocking_reasons)
    db.close()


def test_expired_arm_blocks(tmp_path: object) -> None:
    settings = make_settings(str(tmp_path) + "/db.sqlite")
    settings.app.dry_run = False
    settings.app.live_execution_enabled = True
    db = Database(settings.app.database_path)
    db.set_armed(datetime.now(UTC) - timedelta(minutes=1), "hash")
    result = check_global_arming(settings, db)
    assert not result.allowed
    assert any("expired" in r for r in result.blocking_reasons)
    db.close()


def test_armed_and_live_passes_global_check(tmp_path: object) -> None:
    settings = make_settings(str(tmp_path) + "/db.sqlite")
    settings.app.dry_run = False
    settings.app.live_execution_enabled = True
    db = Database(settings.app.database_path)
    db.set_armed(datetime.now(UTC) + timedelta(hours=1), "hash")
    result = check_global_arming(settings, db)
    assert result.allowed
    db.close()


def test_kill_switch_blocks_even_when_armed(tmp_path: object) -> None:
    settings = make_settings(str(tmp_path) + "/db.sqlite")
    settings.app.dry_run = False
    settings.app.live_execution_enabled = True
    db = Database(settings.app.database_path)
    db.set_armed(datetime.now(UTC) + timedelta(hours=1), "hash")
    db.set_killed("test emergency stop")
    result = check_global_arming(settings, db)
    assert not result.allowed
    assert any("kill switch" in r for r in result.blocking_reasons)
    db.close()


def test_daily_limit_blocks(tmp_path: object) -> None:
    settings = make_settings(
        str(tmp_path) + "/db.sqlite", max_closes_per_day=1, max_closes_per_hour=5
    )
    db = Database(settings.app.database_path)
    sig = make_signal(status=SignalStatus.EXECUTED)
    db.insert_signal(sig)
    db.update_signal_status(sig.id, SignalStatus.EXECUTED)
    result = check_execution_limits(settings, db)
    assert not result.allowed
    assert any("MAX_CLOSES_PER_DAY" in r for r in result.blocking_reasons)
    db.close()


def test_hourly_limit_blocks(tmp_path: object) -> None:
    settings = make_settings(
        str(tmp_path) + "/db.sqlite", max_closes_per_hour=1, max_closes_per_day=5
    )
    db = Database(settings.app.database_path)
    sig = make_signal(status=SignalStatus.EXECUTED)
    db.insert_signal(sig)
    db.update_signal_status(sig.id, SignalStatus.EXECUTED)
    result = check_execution_limits(settings, db)
    assert not result.allowed
    assert any("MAX_CLOSES_PER_HOUR" in r for r in result.blocking_reasons)
    db.close()


def test_signal_expiry_blocks() -> None:
    settings = Settings(execution=ExecutionConfig(signal_expiry_minutes=10))
    old_signal = make_signal(created_at=datetime.now(UTC) - timedelta(minutes=11))
    result = check_signal_freshness(settings, old_signal)
    assert not result.allowed
    assert any("stale" in r for r in result.blocking_reasons)


def test_already_processed_signal_blocks() -> None:
    settings = Settings(execution=ExecutionConfig(signal_expiry_minutes=10))
    processed = make_signal(status=SignalStatus.EXECUTED)
    result = check_signal_freshness(settings, processed)
    assert not result.allowed
    assert any("already been processed" in r for r in result.blocking_reasons)


def test_unregistered_position_blocks(tmp_path: object) -> None:
    db = Database(str(tmp_path) + "/db.sqlite")
    result = check_position_registration(db, "JTO")
    assert not result.allowed
    assert any("not registered" in r for r in result.blocking_reasons)
    db.close()


def test_disabled_position_blocks(tmp_path: object) -> None:
    db = Database(str(tmp_path) + "/db.sqlite")
    db.upsert_position(
        PositionRegistration(
            symbol="JTO",
            expected_side=Side.LONG,
            approx_entry_price=0.6,
            expected_value_min_usd=400,
            expected_value_max_usd=650,
            registered_at=datetime.now(UTC),
            enabled=False,
        )
    )
    result = check_position_registration(db, "JTO")
    assert not result.allowed
    assert any("disabled" in r for r in result.blocking_reasons)
    db.close()


def test_full_preflight_aggregates_all_reasons(tmp_path: object) -> None:
    settings = make_settings(str(tmp_path) + "/db.sqlite")
    db = Database(settings.app.database_path)
    sig = make_signal()
    db.insert_signal(sig)
    result = full_preflight_check(settings, db, sig)
    assert not result.allowed
    # dry_run + live_execution_enabled + arm + no registered position, at minimum.
    assert len(result.blocking_reasons) >= 3
    db.close()
