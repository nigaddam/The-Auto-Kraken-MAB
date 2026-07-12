import { KRAKEN_PUBLIC_OHLC_URL, KRAKEN_PUBLIC_TICKER_URL } from "../shared/constants";
import type { Candle } from "../shared/types";

export class MarketDataError extends Error {}

interface KrakenOhlcResponse {
  error: string[];
  result: Record<string, unknown>;
}

interface KrakenTickerResponse {
  error: string[];
  result: Record<string, { c?: [string, string] }>;
}

/** Fetch completed 1-hour candles for a Kraken public REST pair. Excludes
 * the still-forming hour so hourly-close-based decisions never look at a
 * candle that hasn't finished yet. */
export async function fetchCompletedHourlyCandles(
  pairParam: string,
  count: number
): Promise<Candle[]> {
  const url = `${KRAKEN_PUBLIC_OHLC_URL}?pair=${encodeURIComponent(pairParam)}&interval=60`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new MarketDataError(`Network error fetching OHLC for ${pairParam}: ${String(err)}`);
  }
  if (!response.ok) {
    throw new MarketDataError(`Kraken OHLC request failed for ${pairParam}: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as KrakenOhlcResponse;
  if (payload.error && payload.error.length > 0) {
    throw new MarketDataError(`Kraken OHLC API error for ${pairParam}: ${payload.error.join(", ")}`);
  }

  const seriesKeys = Object.keys(payload.result).filter((k) => k !== "last");
  if (seriesKeys.length !== 1) {
    throw new MarketDataError(
      `Unexpected Kraken OHLC result shape for ${pairParam}: keys=${Object.keys(payload.result).join(",")}`
    );
  }
  const rows = payload.result[seriesKeys[0]!];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new MarketDataError(`Kraken OHLC returned no rows for ${pairParam}`);
  }

  const nowSeconds = Date.now() / 1000;
  const intervalSeconds = 60 * 60;
  const candles: Candle[] = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 7) {
      throw new MarketDataError(`Malformed OHLC row for ${pairParam}: ${JSON.stringify(row)}`);
    }
    const openTimeSeconds = Number(row[0]);
    const closeTimeSeconds = openTimeSeconds + intervalSeconds;
    if (closeTimeSeconds > nowSeconds) {
      continue; // still-forming candle, excluded
    }
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[6]);
    if ([open, high, low, close, volume].some((v) => !Number.isFinite(v))) {
      throw new MarketDataError(`Malformed OHLC values for ${pairParam}: ${JSON.stringify(row)}`);
    }
    candles.push({ ts: openTimeSeconds * 1000, open, high, low, close, volume });
  }

  candles.sort((a, b) => a.ts - b.ts);
  return candles.length > count ? candles.slice(candles.length - count) : candles;
}

/** Current public last-trade price, used only for the API/UI price-tolerance
 * cross-check — never as the sole source for SMA-based decisions. */
export async function fetchCurrentPrice(pairParam: string): Promise<number> {
  const url = `${KRAKEN_PUBLIC_TICKER_URL}?pair=${encodeURIComponent(pairParam)}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new MarketDataError(`Network error fetching ticker for ${pairParam}: ${String(err)}`);
  }
  if (!response.ok) {
    throw new MarketDataError(
      `Kraken Ticker request failed for ${pairParam}: HTTP ${response.status}`
    );
  }

  const payload = (await response.json()) as KrakenTickerResponse;
  if (payload.error && payload.error.length > 0) {
    throw new MarketDataError(`Kraken Ticker API error for ${pairParam}: ${payload.error.join(", ")}`);
  }

  const seriesKeys = Object.keys(payload.result);
  if (seriesKeys.length !== 1) {
    throw new MarketDataError(`Unexpected Kraken Ticker result shape for ${pairParam}`);
  }
  const lastTrade = payload.result[seriesKeys[0]!]?.c?.[0];
  const price = lastTrade ? Number(lastTrade) : Number.NaN;
  if (!Number.isFinite(price) || price <= 0) {
    throw new MarketDataError(`Malformed ticker price for ${pairParam}: ${String(lastTrade)}`);
  }
  return price;
}
