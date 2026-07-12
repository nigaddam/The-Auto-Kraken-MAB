"""Pre-flight and position-matching safety checks.

These checks do not require a browser and are fully unit-testable. They are
the first gate an execution attempt must pass; browser-dependent checks
(login state, account identity, DOM structure, modal content — see
browser.py / kraken_prop.py) are a second, later gate that stacks on top of
these, not a replacement for them.

Every check here is a "default deny": if anything is ambiguous, missing, or
out of range, the result is not allowed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from pydantic import BaseModel

from kraken_guard.config import AssetConfig, Settings
from kraken_guard.database import Database
from kraken_guard.models import PositionRegistration, Side, Signal, SignalStatus


class ScrapedPosition(BaseModel):
    """What the (future) browser layer reads from a single position row."""

    symbol: str
    side: Side
    value_usd: float
    raw_text: str = ""


@dataclass
class SafetyCheckResult:
    allowed: bool
    blocking_reasons: list[str] = field(default_factory=list)

    @staticmethod
    def ok() -> SafetyCheckResult:
        return SafetyCheckResult(allowed=True)

    @staticmethod
    def block(reason: str) -> SafetyCheckResult:
        return SafetyCheckResult(allowed=False, blocking_reasons=[reason])

    def merge(self, other: SafetyCheckResult) -> SafetyCheckResult:
        return SafetyCheckResult(
            allowed=self.allowed and other.allowed,
            blocking_reasons=[*self.blocking_reasons, *other.blocking_reasons],
        )


def check_global_arming(
    settings: Settings, db: Database, now: datetime | None = None
) -> SafetyCheckResult:
    now = now or datetime.now(UTC)
    reasons: list[str] = []

    if settings.app.dry_run:
        reasons.append("DRY_RUN is enabled")
    if not settings.app.live_execution_enabled:
        reasons.append("LIVE_EXECUTION_ENABLED is false")

    killed, kill_reason = db.is_killed()
    if killed:
        reasons.append(f"kill switch is active: {kill_reason or 'no reason given'}")

    if settings.execution.require_runtime_arm:
        arm_state = db.get_arm_state()
        if arm_state is None:
            reasons.append("runtime arming token is absent")
        else:
            armed_until, _token_hash = arm_state
            if now > armed_until:
                reasons.append("runtime arming token has expired")

    return SafetyCheckResult(allowed=not reasons, blocking_reasons=reasons)


def check_execution_limits(
    settings: Settings, db: Database, now: datetime | None = None
) -> SafetyCheckResult:
    now = now or datetime.now(UTC)
    reasons: list[str] = []

    since_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if db.count_executed_since(since_day) >= settings.execution.max_closes_per_day:
        reasons.append("MAX_CLOSES_PER_DAY reached")

    since_hour = now - timedelta(hours=1)
    if db.count_executed_since(since_hour) >= settings.execution.max_closes_per_hour:
        reasons.append("MAX_CLOSES_PER_HOUR reached")

    pending = db.list_pending_signals()
    if any(s.status == SignalStatus.EXECUTION_STARTED for s in pending):
        reasons.append("another execution is already in progress")

    return SafetyCheckResult(allowed=not reasons, blocking_reasons=reasons)


def check_signal_freshness(
    settings: Settings, signal: Signal, now: datetime | None = None
) -> SafetyCheckResult:
    now = now or datetime.now(UTC)
    reasons: list[str] = []

    if signal.is_expired(now, settings.execution.signal_expiry_minutes):
        reasons.append("signal is stale (older than SIGNAL_EXPIRY_MINUTES)")

    if signal.status not in (SignalStatus.DETECTED, SignalStatus.WAITING_FOR_ARM):
        reasons.append(f"signal has already been processed (status={signal.status.value})")

    return SafetyCheckResult(allowed=not reasons, blocking_reasons=reasons)


def check_position_registration(
    db: Database, asset_key: str, now: datetime | None = None
) -> SafetyCheckResult:
    now = now or datetime.now(UTC)
    registration = db.get_position(asset_key)
    if registration is None:
        return SafetyCheckResult.block(f"{asset_key} is not registered as an expected position")
    if not registration.enabled:
        return SafetyCheckResult.block(f"{asset_key} registration is disabled")
    if registration.expected_side != Side.LONG:
        return SafetyCheckResult.block(
            f"{asset_key} registered side is {registration.expected_side.value}, not LONG"
        )
    if registration.max_age_minutes is not None:
        age_minutes = (now - registration.registered_at).total_seconds() / 60.0
        if age_minutes > registration.max_age_minutes:
            return SafetyCheckResult.block(f"{asset_key} registration exceeded max_age_minutes")
    return SafetyCheckResult.ok()


def match_scraped_position(
    cfg: AssetConfig,
    registration: PositionRegistration,
    scraped: list[ScrapedPosition],
) -> SafetyCheckResult:
    """Confirm exactly one actionable row matches the exact expected symbol,
    side LONG, and a value within the configured tolerance."""
    exact_symbol_matches = [p for p in scraped if p.symbol == cfg.ui_symbol]

    if len(exact_symbol_matches) == 0:
        return SafetyCheckResult.block(
            f"no open position row found for exact symbol {cfg.ui_symbol}"
        )
    if len(exact_symbol_matches) > 1:
        return SafetyCheckResult.block(
            f"more than one matching position row found for {cfg.ui_symbol}"
        )

    row = exact_symbol_matches[0]
    if row.side != Side.LONG:
        return SafetyCheckResult.block(
            f"{cfg.ui_symbol} position side is {row.side.value}, not LONG"
        )

    value_ok = (
        registration.expected_value_min_usd <= row.value_usd <= registration.expected_value_max_usd
    )
    if not value_ok:
        return SafetyCheckResult.block(
            f"{cfg.ui_symbol} position value {row.value_usd} is outside expected range "
            f"[{registration.expected_value_min_usd}, {registration.expected_value_max_usd}]"
        )

    return SafetyCheckResult.ok()


def full_preflight_check(
    settings: Settings, db: Database, signal: Signal, now: datetime | None = None
) -> SafetyCheckResult:
    """Aggregate every check that does not require a live browser page."""
    now = now or datetime.now(UTC)
    result = check_global_arming(settings, db, now)
    result = result.merge(check_execution_limits(settings, db, now))
    result = result.merge(check_signal_freshness(settings, signal, now))
    result = result.merge(check_position_registration(db, signal.asset, now))
    return result
