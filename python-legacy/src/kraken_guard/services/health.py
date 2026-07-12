"""Aggregates a point-in-time health snapshot for `kraken-guard health`."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from kraken_guard.config import Settings
from kraken_guard.database import Database


def build_health_report(
    settings: Settings, db: Database, heartbeat_path: str | Path | None = None
) -> dict[str, Any]:
    now = datetime.now(UTC)

    heartbeat_age_seconds: float | None = None
    if heartbeat_path is not None:
        path = Path(heartbeat_path)
        if path.exists():
            try:
                last = datetime.fromisoformat(path.read_text().strip())
                heartbeat_age_seconds = (now - last).total_seconds()
            except ValueError:
                heartbeat_age_seconds = None

    per_asset: dict[str, Any] = {}
    for asset_key, cfg in settings.assets.items():
        candles = db.get_recent_candles(cfg.data_symbol, cfg.candle_interval_minutes, 1)
        last_candle_ts = candles[-1].ts.isoformat() if candles else None
        per_asset[asset_key] = {
            "enabled": cfg.enabled,
            "last_completed_candle": last_candle_ts,
        }

    arm_state = db.get_arm_state()
    armed = arm_state is not None and now <= arm_state[0]
    killed, kill_reason = db.is_killed()

    pending_signals = db.list_pending_signals()

    return {
        "generated_at": now.isoformat(),
        "scheduler_heartbeat_age_seconds": heartbeat_age_seconds,
        "scheduler_likely_running": (
            heartbeat_age_seconds is not None
            and heartbeat_age_seconds < settings.market_data.poll_seconds * 3
        ),
        "dry_run": settings.app.dry_run,
        "live_execution_enabled": settings.app.live_execution_enabled,
        "armed": armed,
        "armed_until": arm_state[0].isoformat() if arm_state else None,
        "killed": killed,
        "kill_reason": kill_reason,
        "assets": per_asset,
        "registered_positions": [
            {"symbol": p.symbol, "enabled": p.enabled} for p in db.list_positions()
        ],
        "pending_signals": [
            {
                "id": s.id,
                "asset": s.asset,
                "status": s.status.value,
                "created_at": s.created_at.isoformat(),
            }
            for s in pending_signals
        ],
        "browser_status": "not implemented in this stage (Stage 2+)",
    }


def format_health_report(report: dict[str, Any]) -> str:
    heartbeat_age = report["scheduler_heartbeat_age_seconds"]
    heartbeat_display = (
        "never (monitor not running yet)" if heartbeat_age is None else f"{heartbeat_age:.0f}s ago"
    )
    lines = [
        f"Generated at:        {report['generated_at']}",
        f"Scheduler heartbeat: {heartbeat_display} "
        f"(likely running: {report['scheduler_likely_running']})",
        f"Mode:                {'DRY-RUN' if report['dry_run'] else 'LIVE'} "
        f"(live_execution_enabled={report['live_execution_enabled']})",
        f"Armed:               {report['armed']} (until {report['armed_until']})",
        f"Kill switch:         "
        f"{'ACTIVE - ' + str(report['kill_reason']) if report['killed'] else 'inactive'}",
        f"Browser:             {report['browser_status']}",
        "Assets:",
    ]
    for asset, info in report["assets"].items():
        lines.append(
            f"  - {asset}: enabled={info['enabled']} "
            f"last_completed_candle={info['last_completed_candle']}"
        )
    lines.append("Registered positions:")
    for pos in report["registered_positions"]:
        lines.append(f"  - {pos['symbol']} (enabled={pos['enabled']})")
    lines.append(f"Pending signals: {len(report['pending_signals'])}")
    for sig in report["pending_signals"]:
        lines.append(
            f"  - {sig['id'][:8]} {sig['asset']} {sig['status']} created={sig['created_at']}"
        )
    return "\n".join(lines)
