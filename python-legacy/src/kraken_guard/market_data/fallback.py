"""Fallback market data provider interface.

Not wired into the signal engine by default. If you add a real fallback
(e.g. another exchange's public API), the signal engine must NEVER silently
switch to it mid-run — a different venue can have materially different
pricing than Kraken, which would make SMA comparisons meaningless. Any
fallback usage should be an explicit, logged, operator-visible event, and
ideally validated against the primary source's last-known price before
being trusted.
"""

from __future__ import annotations

from kraken_guard.market_data.base import MarketDataProvider
from kraken_guard.models import Candle


class FallbackNotConfiguredProvider(MarketDataProvider):
    name = "fallback_not_configured"

    async def fetch_completed_candles(
        self, data_symbol: str, interval_minutes: int, count: int
    ) -> list[Candle]:
        raise NotImplementedError(
            "No fallback market data provider is configured. Implement one here "
            "and wire it in explicitly (with operator notification) before use."
        )
