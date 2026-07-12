/** Pure indicator computation shared by BOTH the exit engine and the new
 * entry (Recovery Cross) engine — the "one Strategy Engine" requirement:
 * nobody recomputes SMA7/30/90, ATR14, slopes, or regime independently.
 * This is a direct extraction of what was previously inlined inside
 * exit-strategy.ts's evaluateVolatilityAdjustedStrategy (the block that
 * only ever depended on candles+settings, never on position-specific
 * state like peakPrice/profitFloor/hardLoss) — the arithmetic here is
 * unchanged from that inlined version, verified by re-running the
 * existing exit-strategy/volatility-strategy test suites unmodified. */

import type { Candle, Settings, StrategyRegime } from "../shared/types";
import { computeATR, computeTripleSmaSeries, normalizedSlope } from "./sma";

export interface IndicatorSnapshot {
  candleTimestamp: number | null;
  latestClose: number | null;
  sma7: number | null;
  sma30: number | null;
  sma90: number | null;
  atr14: number | null;
  atrPct: number | null;
  slope7: number | null;
  slope30: number | null;
  slope90: number | null;
  regime: StrategyRegime;
  completedClosesBelowSma7: number;
  latestVolume: number | null;
  volumeSma: number | null;
  dataValid: boolean;
  invalidReason: string | null;
}

export function classifyRegime(input: {
  sma7: number;
  sma30: number;
  slope7: number;
  slope30: number;
  latestClose: number;
  closesBelowSma7: number;
  settings: Settings;
}): StrategyRegime {
  if (input.sma7 <= input.sma30 && input.slope30 <= 0) return "BROKEN";
  const expansion =
    input.sma7 > input.sma30 &&
    input.slope7 >= input.settings.slope7Positive &&
    input.slope30 > 0 &&
    input.latestClose >= input.sma7;
  if (expansion) return "EXPANSION";
  const deteriorating =
    (input.sma7 > input.sma30 && input.slope7 < input.settings.slope7Negative) ||
    (input.sma7 > input.sma30 && input.closesBelowSma7 > 0) ||
    input.slope30 < input.settings.slope30FlatLowerBound;
  if (deteriorating) return "DETERIORATING";
  return "HEALTHY";
}

export function countLatestClosesBelowSma7(
  series: { close: number; sma7: number | null; ts: number }[]
): number {
  let count = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    const point = series[i]!;
    if (point.sma7 === null || point.close >= point.sma7) break;
    count += 1;
  }
  return count;
}

function computeVolumeSma(candles: Candle[], lookback: number): number | null {
  const window = candles.slice(-lookback);
  if (window.length === 0) return null;
  return window.reduce((sum, c) => sum + c.volume, 0) / window.length;
}

export function requiredCandleCount(settings: Settings): number {
  return Math.max(
    settings.longSma + settings.slope90LookbackHours,
    settings.slowSma + settings.slope30LookbackHours,
    settings.fastSma + settings.slope7LookbackHours,
    settings.atrPeriod + 1
  );
}

/** Only ever uses completed candles the caller passes in — never fetches or
 * excludes the forming hour itself, same contract as before extraction. */
export function computeIndicatorSnapshot(
  candles: Candle[],
  settings: Settings,
  volumeLookback = 20
): IndicatorSnapshot {
  const required = requiredCandleCount(settings);

  if (candles.length < required) {
    const last = candles[candles.length - 1] ?? null;
    return {
      candleTimestamp: last?.ts ?? null,
      latestClose: last?.close ?? null,
      sma7: null,
      sma30: null,
      sma90: null,
      atr14: null,
      atrPct: null,
      slope7: null,
      slope30: null,
      slope90: null,
      regime: "UNKNOWN",
      completedClosesBelowSma7: 0,
      latestVolume: last?.volume ?? null,
      volumeSma: null,
      dataValid: false,
      invalidReason: `Strategy data invalid: insufficient completed 1h candles for SMA90/ATR/slope history (got ${candles.length}, need ${required}).`,
    };
  }

  const tripleSeries = computeTripleSmaSeries(candles, settings.fastSma, settings.slowSma, settings.longSma);
  const atrSeries = computeATR(candles, settings.atrPeriod);
  const latestIndex = candles.length - 1;
  const latest = candles[latestIndex]!;
  const latestMa = tripleSeries[latestIndex]!;
  const atr14 = atrSeries[latestIndex] ?? null;
  const atrPct = atr14 !== null ? atr14 / latest.close : null;
  const sma7Values = tripleSeries.map((p) => p.sma7);
  const sma30Values = tripleSeries.map((p) => p.sma30);
  const sma90Values = tripleSeries.map((p) => p.sma90);
  const slope7 = normalizedSlope(sma7Values, latestIndex, settings.slope7LookbackHours, atr14);
  const slope30 = normalizedSlope(sma30Values, latestIndex, settings.slope30LookbackHours, atr14);
  const slope90 = normalizedSlope(sma90Values, latestIndex, settings.slope90LookbackHours, atr14);
  const volumeSma = computeVolumeSma(candles, volumeLookback);

  const dataInvalid =
    latestMa.sma7 === null ||
    latestMa.sma30 === null ||
    latestMa.sma90 === null ||
    atr14 === null ||
    atr14 <= 0 ||
    slope7 === null ||
    slope30 === null ||
    slope90 === null;

  if (dataInvalid) {
    return {
      candleTimestamp: latest.ts,
      latestClose: latest.close,
      sma7: latestMa.sma7,
      sma30: latestMa.sma30,
      sma90: latestMa.sma90,
      atr14,
      atrPct,
      slope7,
      slope30,
      slope90,
      regime: "UNKNOWN",
      completedClosesBelowSma7: 0,
      latestVolume: latest.volume,
      volumeSma,
      dataValid: false,
      invalidReason: "Strategy data invalid: SMA90, ATR14, or normalized slope is unavailable.",
    };
  }

  const completedClosesBelowSma7 = countLatestClosesBelowSma7(tripleSeries);
  const regime = classifyRegime({
    sma7: latestMa.sma7!,
    sma30: latestMa.sma30!,
    slope7,
    slope30,
    latestClose: latest.close,
    closesBelowSma7: completedClosesBelowSma7,
    settings,
  });

  return {
    candleTimestamp: latest.ts,
    latestClose: latest.close,
    sma7: latestMa.sma7,
    sma30: latestMa.sma30,
    sma90: latestMa.sma90,
    atr14,
    atrPct,
    slope7,
    slope30,
    slope90,
    regime,
    completedClosesBelowSma7,
    latestVolume: latest.volume,
    volumeSma,
    dataValid: true,
    invalidReason: null,
  };
}
