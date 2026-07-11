/** Evaluates golden-cross BUY signals for the user's watchlist coins
 * (Settings.watchlistCoins, capped at MAX_WATCHLIST_COINS) — entirely
 * separate from open-position tracking. Uses only Kraken's public
 * OHLC/Ticker endpoints, same as market-data-table.ts. Never places an
 * order; the only output is a signal the caller may choose to notify on. */

import { fetchCompletedHourlyCandles, fetchCurrentPrice } from "../api/kraken-public";
import { resolvePublicMarket } from "../api/symbols";
import { MAX_WATCHLIST_COINS } from "../shared/constants";
import type { BuySignalState, Settings } from "../shared/types";
import {
  advanceBuySignalProgress,
  INITIAL_BUY_SIGNAL_STATE,
  seedBuySignalProgressAtLatestCompleted,
} from "../strategy/buy-signal";
import { computeSmaSeries } from "../strategy/sma";

export interface WatchlistSignalUpdate {
  symbol: string;
  state: BuySignalState;
  newlyConfirmed: boolean;
  currentPrice: number | null;
  smaFast: number | null;
  smaSlow: number | null;
}

export async function evaluateWatchlistBuySignals(
  settings: Settings,
  previous: Record<string, BuySignalState>
): Promise<WatchlistSignalUpdate[]> {
  const symbols = settings.watchlistCoins.slice(0, MAX_WATCHLIST_COINS);
  const results: WatchlistSignalUpdate[] = [];

  for (const symbol of symbols) {
    const resolution = await resolvePublicMarket(symbol);
    if (resolution.status !== "SUPPORTED") continue;

    try {
      const [candles, currentPrice] = await Promise.all([
        fetchCompletedHourlyCandles(resolution.pairParam, 100),
        fetchCurrentPrice(resolution.pairParam),
      ]);
      const smaSeries = computeSmaSeries(candles, settings.fastSma, settings.slowSma);
      const seeded = seedBuySignalProgressAtLatestCompleted(
        previous[symbol] ?? INITIAL_BUY_SIGNAL_STATE,
        smaSeries
      );
      const advanced = advanceBuySignalProgress(seeded, smaSeries, settings.strongTrendConfirmationCloses);
      const latest = smaSeries[smaSeries.length - 1] ?? null;

      results.push({
        symbol,
        state: {
          consecutiveClosesAboveSmaFast: advanced.consecutiveClosesAboveSmaFast,
          lastProcessedCandleTs: advanced.lastProcessedCandleTs,
          signalFiredForThisEpisode: advanced.signalFiredForThisEpisode,
        },
        newlyConfirmed: advanced.newlyConfirmed,
        currentPrice,
        smaFast: latest?.smaFast ?? null,
        smaSlow: latest?.smaSlow ?? null,
      });
    } catch (err) {
      console.warn(`[kraken-guard] watchlist buy-signal check failed for ${symbol}`, err);
      // Best-effort: skip this symbol this cycle, keep its prior state untouched.
    }
  }

  return results;
}
