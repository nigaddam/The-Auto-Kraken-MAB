"""Configuration loading.

Strategy/asset/behavioral configuration lives in a YAML file (config.yaml,
see config.example.yaml). Secrets and machine-specific paths (account id,
Chrome profile, Telegram token) live in environment variables / .env (see
.env.example) and are never written into the YAML or into source control.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from kraken_guard.models import Side, StrategyMode


class AppConfig(BaseModel):
    dry_run: bool = True
    live_execution_enabled: bool = False
    database_path: str = "./data/kraken_guard.db"
    screenshot_dir: str = "./data/screenshots"
    log_dir: str = "./data/logs"
    timezone: str = "America/Los_Angeles"


class MarketDataConfig(BaseModel):
    provider: str = "kraken_public"
    poll_seconds: int = 30
    use_completed_candles_only: bool = True
    max_data_age_minutes: int = 8
    min_candles_required: int = 31
    candle_history_size: int = 100


class ExecutionConfig(BaseModel):
    account_id_env: str = "KRAKEN_PROP_ACCOUNT_ID"
    base_url_env: str = "KRAKEN_PROP_BASE_URL"
    require_runtime_arm: bool = True
    arm_duration_minutes: int = 480
    signal_expiry_minutes: int = 10
    max_closes_per_hour: int = 1
    max_closes_per_day: int = 2
    browser_headless: bool = False
    final_confirmation_enabled: bool = False


class AssetConfig(BaseModel):
    enabled: bool = True
    data_symbol: str
    ui_symbol: str
    route_symbol: str
    expected_side: Side = Side.LONG
    expected_value_min_usd: float
    expected_value_max_usd: float
    candle_interval_minutes: int = 5
    fast_sma: int = 7
    slow_sma: int = 30
    strategy_mode: StrategyMode = StrategyMode.CONFIRMED_BEARISH_CROSS
    confirmation_candles: int = 1
    cooldown_minutes: int = 60

    @field_validator("expected_value_max_usd")
    @classmethod
    def _max_gte_min(cls, v: float, info: Any) -> float:
        min_v = info.data.get("expected_value_min_usd")
        if min_v is not None and v < min_v:
            raise ValueError("expected_value_max_usd must be >= expected_value_min_usd")
        return v

    @field_validator("fast_sma", "slow_sma")
    @classmethod
    def _positive_periods(cls, v: int) -> int:
        if v < 2:
            raise ValueError("SMA period must be >= 2")
        return v


class NotificationsConfig(BaseModel):
    macos: bool = True
    telegram: bool = False


class Settings(BaseModel):
    app: AppConfig = Field(default_factory=AppConfig)
    market_data: MarketDataConfig = Field(default_factory=MarketDataConfig)
    execution: ExecutionConfig = Field(default_factory=ExecutionConfig)
    assets: dict[str, AssetConfig] = Field(default_factory=dict)
    notifications: NotificationsConfig = Field(default_factory=NotificationsConfig)

    def enabled_assets(self) -> dict[str, AssetConfig]:
        return {k: v for k, v in self.assets.items() if v.enabled}


class EnvSecrets(BaseSettings):
    """Machine/account-specific secrets. Loaded from environment or .env, never from YAML."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    kraken_prop_account_id: str = ""
    kraken_prop_base_url: str = ""
    chrome_user_data_dir: str = ""
    chrome_profile_directory: str = "Default"
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    kraken_guard_killed: bool = False


def load_config(path: str | Path = "config.yaml") -> Settings:
    config_path = Path(path)
    if not config_path.exists():
        raise FileNotFoundError(
            f"Config file not found: {config_path}. Copy config.example.yaml to config.yaml first."
        )
    raw: dict[str, Any] = yaml.safe_load(config_path.read_text()) or {}
    return Settings.model_validate(raw)


def load_env_secrets(env_file: str | Path = ".env") -> EnvSecrets:
    return EnvSecrets(_env_file=str(env_file))  # type: ignore[call-arg]
