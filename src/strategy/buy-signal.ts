import type { BuySignalState, SMAPoint, TrendStrength } from "../shared/types";
import { determineTrend } from "./exit-strategy";

export const INITIAL_BUY_SIGNAL_STATE: BuySignalState = {
  consecutiveClosesAboveSmaFast: 0,
  lastProcessedCandleTs: null,
  signalFiredForThisEpisode: false,
};

export function seedBuySignalProgressAtLatestCompleted(
  prev: BuySignalState,
  smaSeries: SMAPoint[]
): BuySignalState {
  if (prev.lastProcessedCandleTs !== null) return prev;
  const latest = smaSeries[smaSeries.length - 1] ?? null;
  return {
    ...prev,
    consecutiveClosesAboveSmaFast: 0,
    lastProcessedCandleTs: latest?.ts ?? null,
  };
}

export interface BuySignalResult extends BuySignalState {
  trend: TrendStrength;
  /** True exactly on the cycle a golden cross is newly confirmed for this
   * episode — the only cycle a notification should fire on. */
  newlyConfirmed: boolean;
}

/** Mirrors advanceCandleProgress (exit-strategy.ts) but inverted: counts
 * consecutive completed hourly closes ABOVE SMA7. A "golden cross" is
 * confirmed once the trend is STRONG (SMA7 > SMA30) and that counter
 * reaches `confirmationCloses`. Fires at most once per continuous STRONG
 * episode — the flag resets the moment trend drops out of STRONG, so a
 * later, genuinely new crossover can fire again. */
export function advanceBuySignalProgress(
  prev: BuySignalState,
  smaSeries: SMAPoint[],
  confirmationCloses: number
): BuySignalResult {
  const newPoints = smaSeries.filter(
    (p) => prev.lastProcessedCandleTs === null || p.ts > prev.lastProcessedCandleTs
  );

  let counter = prev.consecutiveClosesAboveSmaFast;
  let lastProcessedCandleTs = prev.lastProcessedCandleTs;

  for (const point of newPoints) {
    if (point.smaFast !== null) {
      counter = point.close > point.smaFast ? counter + 1 : 0;
    }
    lastProcessedCandleTs = point.ts;
  }

  const latest = smaSeries[smaSeries.length - 1] ?? null;
  const trend = latest ? determineTrend(latest.smaFast, latest.smaSlow) : "UNKNOWN";

  const confirmedNow = trend === "STRONG" && counter >= confirmationCloses;
  const newlyConfirmed = confirmedNow && !prev.signalFiredForThisEpisode;
  const signalFiredForThisEpisode = trend === "STRONG" ? confirmedNow || prev.signalFiredForThisEpisode : false;

  return {
    consecutiveClosesAboveSmaFast: counter,
    lastProcessedCandleTs,
    signalFiredForThisEpisode,
    trend,
    newlyConfirmed,
  };
}
