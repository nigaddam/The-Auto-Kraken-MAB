"""Market data provider interface.

Providers only fetch public price data. They never place trades and never
touch the Kraken Prop web UI. Only completed (closed) candles should be
returned by fetch_completed_candles; the currently-forming candle must be
excluded by the implementation.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from kraken_guard.models import Candle


class MarketDataError(Exception):
    """Raised when a provider cannot return trustworthy data for a symbol."""


class MarketDataProvider(ABC):
    name: str

    @abstractmethod
    async def fetch_completed_candles(
        self, data_symbol: str, interval_minutes: int, count: int
    ) -> list[Candle]:
        """Return up to `count` most recent *completed* candles, ascending by ts.

        Raises MarketDataError if the symbol is unknown or the response is malformed.
        """
        raise NotImplementedError
