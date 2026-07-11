"""Kraken public OHLC REST provider.

Uses https://api.kraken.com/0/public/OHLC — no API key required, no private
account data involved. This is the default market_data.provider.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime

import httpx

from kraken_guard.market_data.base import MarketDataError, MarketDataProvider
from kraken_guard.models import Candle

KRAKEN_OHLC_URL = "https://api.kraken.com/0/public/OHLC"

VALID_INTERVALS_MINUTES = {1, 5, 15, 30, 60, 240, 1440, 10080, 21600}


def _pair_param(data_symbol: str) -> str:
    """"JTO/USD" -> "JTOUSD". Kraken's REST pair codes are configurable per asset
    via the `data_symbol` mapping if a different format is ever required."""
    return data_symbol.replace("/", "").upper()


class KrakenPublicProvider(MarketDataProvider):
    name = "kraken_public"

    def __init__(self, client: httpx.AsyncClient | None = None, timeout_seconds: float = 10.0):
        self._client = client
        self._timeout = timeout_seconds
        self._owns_client = client is None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout)
        return self._client

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()

    async def fetch_completed_candles(
        self, data_symbol: str, interval_minutes: int, count: int
    ) -> list[Candle]:
        if interval_minutes not in VALID_INTERVALS_MINUTES:
            raise MarketDataError(
                f"Kraken public OHLC does not support a {interval_minutes}-minute interval. "
                f"Valid values: {sorted(VALID_INTERVALS_MINUTES)}"
            )

        pair = _pair_param(data_symbol)
        client = await self._get_client()
        try:
            resp = await client.get(
                KRAKEN_OHLC_URL, params={"pair": pair, "interval": interval_minutes}
            )
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise MarketDataError(f"Kraken OHLC request failed for {data_symbol}: {exc}") from exc

        payload = resp.json()
        errors = payload.get("error") or []
        if errors:
            raise MarketDataError(f"Kraken OHLC API error for {data_symbol}: {errors}")

        result = payload.get("result") or {}
        series_keys = [k for k in result if k != "last"]
        if len(series_keys) != 1:
            raise MarketDataError(
                f"Unexpected Kraken OHLC result shape for {data_symbol} (pair={pair}): "
                f"keys={list(result.keys())}"
            )
        rows = result[series_keys[0]]
        if not rows:
            raise MarketDataError(f"Kraken OHLC returned no rows for {data_symbol}")

        interval_seconds = interval_minutes * 60
        candles: list[Candle] = []
        for row in rows:
            if len(row) < 7:
                raise MarketDataError(f"Malformed OHLC row for {data_symbol}: {row}")
            candle_open_time = int(row[0])
            candle_close_time = candle_open_time + interval_seconds
            # Exclude the still-forming candle: only include ones whose window
            # has fully elapsed.
            if candle_close_time > time.time():
                continue
            ts = datetime.fromtimestamp(candle_open_time, tz=UTC)
            try:
                candle = Candle(
                    symbol=data_symbol,
                    interval_minutes=interval_minutes,
                    ts=ts,
                    open=float(row[1]),
                    high=float(row[2]),
                    low=float(row[3]),
                    close=float(row[4]),
                    volume=float(row[6]),
                )
            except (TypeError, ValueError) as exc:
                raise MarketDataError(f"Malformed OHLC values for {data_symbol}: {row}") from exc
            candles.append(candle)

        candles.sort(key=lambda c: c.ts)
        if len(candles) > count:
            candles = candles[-count:]
        return candles
