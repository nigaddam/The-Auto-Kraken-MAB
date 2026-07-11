"""kraken-guard CLI.

Stage 1: monitoring, signal generation, and manual position registration are
fully implemented. `inspect-ui` and `execute-signal` are present but refuse
to run — browser automation starts in Stage 2, only after inspection output
has been reviewed (see README.md "Staged rollout").
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import secrets
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path

import click

from kraken_guard.config import EnvSecrets, Settings, load_config, load_env_secrets
from kraken_guard.database import Database
from kraken_guard.execution.safety import full_preflight_check
from kraken_guard.logging_setup import setup_logging
from kraken_guard.market_data.kraken_public import KrakenPublicProvider
from kraken_guard.models import PositionRegistration, Side, SignalStatus
from kraken_guard.services.health import build_health_report, format_health_report
from kraken_guard.services.notifications import Notifier
from kraken_guard.services.scheduler import Scheduler
from kraken_guard.strategy.signal_engine import SignalEngine

_DURATION_RE = re.compile(r"(\d+)\s*([dhm])", re.IGNORECASE)


def parse_duration(text: str) -> timedelta:
    text = text.strip()
    if text.isdigit():
        return timedelta(minutes=int(text))
    matches = _DURATION_RE.findall(text)
    if not matches:
        raise click.BadParameter(f"Cannot parse duration: {text!r} (examples: 8h, 30m, 1d, 90)")
    total = timedelta()
    for value, unit in matches:
        n = int(value)
        if unit.lower() == "d":
            total += timedelta(days=n)
        elif unit.lower() == "h":
            total += timedelta(hours=n)
        elif unit.lower() == "m":
            total += timedelta(minutes=n)
    return total


class AppContext:
    def __init__(self, config_path: str, env_path: str):
        self.settings: Settings = load_config(config_path)
        self.env_secrets: EnvSecrets = load_env_secrets(env_path)
        setup_logging(self.settings.app.log_dir)
        self.db = Database(self.settings.app.database_path)
        self.notifier = Notifier(self.settings.notifications, self.env_secrets)
        self.heartbeat_path = Path(self.settings.app.log_dir) / "heartbeat.txt"

    def close(self) -> None:
        self.db.close()


@click.group()
@click.option("--config", "config_path", default="config.yaml", show_default=True)
@click.option("--env-file", "env_path", default=".env", show_default=True)
@click.pass_context
def cli(ctx: click.Context, config_path: str, env_path: str) -> None:
    ctx.ensure_object(dict)
    ctx.obj["config_path"] = config_path
    ctx.obj["env_path"] = env_path


def _get_app(ctx: click.Context) -> AppContext:
    if "app" not in ctx.obj:
        ctx.obj["app"] = AppContext(ctx.obj["config_path"], ctx.obj["env_path"])
    return ctx.obj["app"]  # type: ignore[no-any-return]


@cli.command()
@click.pass_context
def init(ctx: click.Context) -> None:
    """Copy example config/env files and create data directories."""
    config_path = Path(ctx.obj["config_path"])
    env_path = Path(ctx.obj["env_path"])

    if not config_path.exists():
        shutil.copy("config.example.yaml", config_path)
        click.echo(f"Created {config_path} from config.example.yaml — edit it before running.")
    else:
        click.echo(f"{config_path} already exists, leaving it alone.")

    if not env_path.exists():
        shutil.copy(".env.example", env_path)
        click.echo(f"Created {env_path} from .env.example — fill in your values.")
    else:
        click.echo(f"{env_path} already exists, leaving it alone.")

    for d in ["./data", "./data/screenshots", "./data/logs"]:
        Path(d).mkdir(parents=True, exist_ok=True)
    click.echo("Data directories ready. Next: edit config.yaml, then run `kraken-guard status`.")


@cli.command()
@click.pass_context
def monitor(ctx: click.Context) -> None:
    """Run the signal engine on a loop. No browser interaction happens here."""
    app = _get_app(ctx)
    mode = "DRY-RUN" if app.settings.app.dry_run else "LIVE"
    click.echo(f"Starting monitor in {mode} mode. Ctrl-C to stop.")
    app.notifier.notify("kraken-guard started", f"Monitoring started in {mode} mode.")

    provider = KrakenPublicProvider()
    engine = SignalEngine(app.db, app.settings, provider, app.notifier)
    scheduler = Scheduler(
        engine,
        list(app.settings.enabled_assets().keys()),
        app.settings.market_data.poll_seconds,
        app.heartbeat_path,
    )

    async def _run() -> None:
        try:
            await scheduler.run_forever()
        finally:
            await provider.aclose()

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        click.echo("Stopped.")


@cli.command()
@click.pass_context
def status(ctx: click.Context) -> None:
    """Short operational summary."""
    app = _get_app(ctx)
    report = build_health_report(app.settings, app.db, app.heartbeat_path)
    mode = "DRY-RUN" if report["dry_run"] else "LIVE"
    click.echo(f"Mode: {mode} | Armed: {report['armed']} | Killed: {report['killed']}")
    click.echo(f"Pending signals: {len(report['pending_signals'])}")
    click.echo(f"Registered positions: {len(report['registered_positions'])}")


@cli.command()
@click.pass_context
def health(ctx: click.Context) -> None:
    """Full health report."""
    app = _get_app(ctx)
    report = build_health_report(app.settings, app.db, app.heartbeat_path)
    click.echo(format_health_report(report))


@cli.command()
@click.option("--asset", default=None)
@click.option("--status", "status_filter", default=None)
@click.option("--limit", default=20, show_default=True)
@click.pass_context
def signals(ctx: click.Context, asset: str | None, status_filter: str | None, limit: int) -> None:
    """List recent signals."""
    app = _get_app(ctx)
    status_enum = SignalStatus(status_filter) if status_filter else None
    rows = app.db.list_signals(asset=asset, status=status_enum, limit=limit)
    if not rows:
        click.echo("No signals recorded yet.")
        return
    for s in rows:
        click.echo(
            f"{s.created_at.isoformat()}  {s.asset:6s}  {s.status.value:20s}  "
            f"close={s.trigger_close}  SMA_fast={s.sma_fast:.6f}  SMA_slow={s.sma_slow:.6f}  "
            f"id={s.id}"
        )


@cli.command()
@click.pass_context
def positions(ctx: click.Context) -> None:
    """List registered positions (shortcut for `position list`)."""
    ctx.invoke(position_list)


@cli.group("position")
def position_group() -> None:
    """Manage manually-registered positions. Never places a trade."""


@position_group.command("add")
@click.option("--symbol", required=True)
@click.option("--side", default="LONG", show_default=True)
@click.option("--approx-value", "approx_value", type=float, required=True)
@click.option("--entry-price", type=float, required=True)
@click.option("--value-tolerance-pct", type=float, default=15.0, show_default=True)
@click.option("--max-age-minutes", type=int, default=None)
@click.option("--notes", default=None)
@click.pass_context
def position_add(
    ctx: click.Context,
    symbol: str,
    side: str,
    approx_value: float,
    entry_price: float,
    value_tolerance_pct: float,
    max_age_minutes: int | None,
    notes: str | None,
) -> None:
    """Register an already-manually-opened position for the safety system to expect."""
    app = _get_app(ctx)
    side_enum = Side(side.upper())
    if side_enum != Side.LONG:
        raise click.ClickException(
            "This tool only ever closes LONG positions. Refusing to register a non-LONG position."
        )
    tolerance = approx_value * value_tolerance_pct / 100.0
    reg = PositionRegistration(
        symbol=symbol.upper(),
        expected_side=side_enum,
        approx_entry_price=entry_price,
        expected_value_min_usd=approx_value - tolerance,
        expected_value_max_usd=approx_value + tolerance,
        registered_at=datetime.now(UTC),
        enabled=True,
        max_age_minutes=max_age_minutes,
        notes=notes,
    )
    app.db.upsert_position(reg)
    click.echo(
        f"Registered {reg.symbol} LONG, expected value "
        f"[{reg.expected_value_min_usd:.2f}, {reg.expected_value_max_usd:.2f}] USD."
    )


@position_group.command("list")
@click.pass_context
def position_list(ctx: click.Context) -> None:
    app = _get_app(ctx)
    rows = app.db.list_positions()
    if not rows:
        click.echo("No positions registered.")
        return
    for p in rows:
        state = "enabled" if p.enabled else "disabled"
        click.echo(
            f"{p.symbol:8s} {p.expected_side.value:6s} entry={p.approx_entry_price} "
            f"value=[{p.expected_value_min_usd:.2f}, {p.expected_value_max_usd:.2f}] "
            f"{state} registered={p.registered_at.isoformat()}"
        )


@position_group.command("disable")
@click.argument("symbol")
@click.pass_context
def position_disable(ctx: click.Context, symbol: str) -> None:
    app = _get_app(ctx)
    if app.db.set_position_enabled(symbol.upper(), False):
        click.echo(f"Disabled {symbol.upper()}.")
    else:
        raise click.ClickException(f"{symbol.upper()} is not registered.")


@position_group.command("remove")
@click.argument("symbol")
@click.pass_context
def position_remove(ctx: click.Context, symbol: str) -> None:
    app = _get_app(ctx)
    if app.db.remove_position(symbol.upper()):
        click.echo(f"Removed {symbol.upper()}.")
    else:
        raise click.ClickException(f"{symbol.upper()} is not registered.")


@position_group.command("sync-preview")
@click.pass_context
def position_sync_preview(ctx: click.Context) -> None:
    """Preview only: compare registered positions against configured assets.
    Makes no changes and touches no browser."""
    app = _get_app(ctx)
    registered = {p.symbol for p in app.db.list_positions(enabled_only=True)}
    configured = set(app.settings.enabled_assets().keys())

    missing_registration = sorted(configured - registered)
    missing_config = sorted(registered - configured)

    if missing_registration:
        click.echo("Configured assets with no registered position (signals will be blocked):")
        for s in missing_registration:
            click.echo(f"  - {s}")
    if missing_config:
        click.echo("Registered positions with no matching enabled asset config:")
        for s in missing_config:
            click.echo(f"  - {s}")
    if not missing_registration and not missing_config:
        click.echo("Registered positions and configured assets are in sync.")


@cli.command()
@click.option("--duration", default="8h", show_default=True, help="e.g. 8h, 30m, 1d")
@click.pass_context
def arm(ctx: click.Context, duration: str) -> None:
    """Create a short-lived local authorization to permit live execution.
    Requires app.live_execution_enabled=true in config.yaml to have any effect."""
    app = _get_app(ctx)
    delta = parse_duration(duration)
    armed_until = datetime.now(UTC) + delta
    token = secrets.token_hex(16)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    app.db.set_armed(armed_until, token_hash)
    click.echo(f"Armed until {armed_until.isoformat()}.")
    if not app.settings.app.live_execution_enabled:
        click.echo(
            "Note: app.live_execution_enabled is still false in config.yaml, "
            "so no execution can happen yet."
        )


@cli.command()
@click.pass_context
def disarm(ctx: click.Context) -> None:
    app = _get_app(ctx)
    app.db.clear_arm()
    click.echo("Disarmed.")


@cli.command()
@click.option("--reason", default="manual kill switch activation")
@click.pass_context
def kill(ctx: click.Context, reason: str) -> None:
    """Emergency stop: blocks all future execution immediately until cleared."""
    app = _get_app(ctx)
    app.db.set_killed(reason)
    app.db.clear_arm()
    click.echo(f"Kill switch ACTIVE: {reason}")
    app.notifier.notify("kraken-guard KILL SWITCH ACTIVATED", reason, urgent=True)


@cli.command("inspect-ui")
@click.pass_context
def inspect_ui(ctx: click.Context) -> None:
    """Stage 2+. Not implemented in Stage 1."""
    raise click.ClickException(
        "inspect-ui is not implemented in this stage. Use scripts/launch_chrome_profile.py "
        "to open the dedicated Chrome profile and confirm you're logged in manually. "
        "DOM inspection lands in Stage 2 per the staged rollout in README.md."
    )


@cli.command("execute-signal")
@click.option("--signal-id", required=True)
@click.pass_context
def execute_signal(ctx: click.Context, signal_id: str) -> None:
    """Stage 2+. Runs pre-flight safety checks only; never touches a browser."""
    app = _get_app(ctx)
    signal = app.db.get_signal(signal_id)
    if signal is None:
        raise click.ClickException(f"No such signal: {signal_id}")
    result = full_preflight_check(app.settings, app.db, signal)
    click.echo(f"Pre-flight check for signal {signal_id}: allowed={result.allowed}")
    for reason in result.blocking_reasons:
        click.echo(f"  BLOCKED: {reason}")
    raise click.ClickException(
        "Browser execution is not implemented in this stage. See README.md 'Staged rollout'. "
        "This command only reports what the safety checks would decide."
    )


@cli.command("test-notification")
@click.pass_context
def test_notification(ctx: click.Context) -> None:
    app = _get_app(ctx)
    app.notifier.notify("kraken-guard test notification", "If you see this, notifications work.")
    click.echo("Sent test notification.")


def main() -> None:
    cli(obj={})


if __name__ == "__main__":
    main()
