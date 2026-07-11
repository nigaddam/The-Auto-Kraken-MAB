"""A simple, robust asyncio scheduling loop for the signal engine.

Deliberately not APScheduler: the requirement is "every 5 minutes (or
poll_seconds), evaluate each enabled asset," which a plain loop does with
far less surface area. If more complex scheduling is ever needed, this can
be swapped for APScheduler without touching the signal engine.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import UTC, datetime
from pathlib import Path

from kraken_guard.strategy.signal_engine import SignalEngine

logger = logging.getLogger(__name__)


class Scheduler:
    def __init__(
        self,
        engine: SignalEngine,
        asset_keys: list[str],
        poll_seconds: int,
        heartbeat_path: str | Path | None = None,
    ):
        self.engine = engine
        self.asset_keys = asset_keys
        self.poll_seconds = poll_seconds
        self.heartbeat_path = Path(heartbeat_path) if heartbeat_path else None
        self._stop = asyncio.Event()

    def stop(self) -> None:
        self._stop.set()

    async def run_forever(self) -> None:
        while not self._stop.is_set():
            await self.tick()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=self.poll_seconds)

    async def tick(self) -> None:
        expired = self.engine.expire_stale_signals()
        if expired:
            logger.info("signals_expired", extra={"count": expired})
        for asset_key in self.asset_keys:
            try:
                await self.engine.evaluate_asset(asset_key)
            except Exception:
                logger.exception("asset_evaluation_failed", extra={"asset": asset_key})
        self._write_heartbeat()

    def _write_heartbeat(self) -> None:
        if self.heartbeat_path is None:
            return
        self.heartbeat_path.parent.mkdir(parents=True, exist_ok=True)
        self.heartbeat_path.write_text(datetime.now(UTC).isoformat())
