/** Builds the read-only Market Data table: one row per unique symbol (not
 * per lot), covering every symbol with an ACTIVE tracked position plus the
 * developer watchlist (so the table can be exercised before row discovery
 * finds real positions). Uses only Kraken's public OHLC/Ticker endpoints —
 * no API key is read, stored, or requested anywhere in this path. */

import { fetchCompletedHourlyCandles, fetchCurrentPrice, MarketDataError } from "../api/kraken-public";
import { resolvePublicMarket } from "../api/symbols";
import { DEV_WATCHLIST_SYMBOLS } from "../shared/constants";
import type { MarketDataRow, Settings, TrackedPosition } from "../shared/types";
import { validateCandles } from "../shared/validation";
import { computeSmaSeries } from "../strategy/sma";
import { determineTrend } from "../strategy/exit-strategy";

function emptyRow(
  symbol: string,
  apiMarket: string,
  source: MarketDataRow["source"],
  errorMessage: string,
  now: number
): MarketDataRow {
  return {
    symbol,
    apiMarket,
    source,
    currentApiPrice: null,
    lastCompletedClose: null,
    smaFast: null,
    smaSlow: null,
    trend: "UNKNOWN",
    vsSmaFastPct: null,
    vsSmaSlowPct: null,
    latestCandleTs: null,
    completedCandleCount: 0,
    formingCandleExcluded: true,
    lastUpdatedAt: now,
    apiStatus: "ERROR",
    errorMessage,
  };
}

export async function buildMarketDataTable(
  settings: Settings,
  positions: Record<string, TrackedPosition>,
  now: number,
  options: {
    symbols?: string[];
    previous?: Record<string, MarketDataRow>;
    preservePreviousOnError?: boolean;
  } = {}
): Promise<Record<string, MarketDataRow>> {
  const detectedSymbols = new Set(
    Object.values(positions)
      .filter((p) => p.status === "ACTIVE")
      .map((p) => p.symbol)
  );
  const allSymbols = new Set(
    options.symbols ?? [...detectedSymbols, ...settings.watchlistCoins, ...DEV_WATCHLIST_SYMBOLS]
  );

  const table: Record<string, MarketDataRow> = options.symbols ? { ...(options.previous ?? {}) } : {};

  for (const symbol of allSymbols) {
    const source: MarketDataRow["source"] = detectedSymbols.has(symbol)
      ? "DETECTED_POSITION"
      : "WATCHLIST";
    const resolution = await resolvePublicMarket(symbol);

    if (resolution.status === "UNSUPPORTED") {
      const row = emptyRow(
        symbol,
        "unsupported",
        source,
        resolution.reason,
        now
      );
      table[symbol] = maybePreservePrevious(symbol, row, options);
      continue;
    }

    try {
      const candles = await fetchCompletedHourlyCandles(resolution.pairParam, 100);
      const apiPrice = await fetchCurrentPrice(resolution.pairParam);
      const validation = validateCandles(candles, {
        minRequired: settings.slowSma + 1,
        intervalMinutes: settings.candleIntervalMinutes,
        maxDataAgeMinutes: settings.candleIntervalMinutes + 30,
        now,
      });
      const smaSeries = computeSmaSeries(candles, settings.fastSma, settings.slowSma);
      const latest = smaSeries[smaSeries.length - 1] ?? null;

      table[symbol] = {
        symbol,
        apiMarket: resolution.dataSymbol,
        source,
        currentApiPrice: apiPrice,
        lastCompletedClose: latest?.close ?? null,
        smaFast: latest?.smaFast ?? null,
        smaSlow: latest?.smaSlow ?? null,
        trend: determineTrend(latest?.smaFast ?? null, latest?.smaSlow ?? null),
        vsSmaFastPct:
          latest?.smaFast != null ? ((apiPrice - latest.smaFast) / latest.smaFast) * 100 : null,
        vsSmaSlowPct:
          latest?.smaSlow != null ? ((apiPrice - latest.smaSlow) / latest.smaSlow) * 100 : null,
        latestCandleTs: latest?.ts ?? null,
        completedCandleCount: candles.length,
        formingCandleExcluded: true,
        lastUpdatedAt: now,
        apiStatus: validation.ok ? "OK" : "STALE",
        errorMessage: validation.ok ? null : validation.errors.join("; "),
      };
    } catch (err) {
      const message = err instanceof MarketDataError ? err.message : String(err);
      const row = emptyRow(symbol, resolution.dataSymbol, source, message, now);
      table[symbol] = maybePreservePrevious(symbol, row, options);
    }
  }

  return table;
}

function maybePreservePrevious(
  symbol: string,
  errorRow: MarketDataRow,
  options: {
    previous?: Record<string, MarketDataRow>;
    preservePreviousOnError?: boolean;
  }
): MarketDataRow {
  const previous = options.previous?.[symbol];
  if (!options.preservePreviousOnError || !previous || previous.apiStatus === "ERROR") {
    return errorRow;
  }
  return {
    ...previous,
    apiStatus: "ERROR",
    errorMessage: errorRow.errorMessage,
  };
}
