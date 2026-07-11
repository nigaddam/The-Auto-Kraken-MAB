import type { Candle, SMAPoint } from "../shared/types";

/** Simple moving average aligned to `closes`, ascending order. Index i uses
 * only closes[i-period+1 .. i] — no look-ahead. Values before the window
 * fills are null (never backfilled/estimated). */
export function computeSMA(closes: number[], period: number): (number | null)[] {
  const result = new Array<number | null>(closes.length).fill(null);
  let windowSum = 0;
  for (let i = 0; i < closes.length; i++) {
    windowSum += closes[i]!;
    if (i >= period) {
      windowSum -= closes[i - period]!;
    }
    if (i >= period - 1) {
      result[i] = windowSum / period;
    }
  }
  return result;
}

/** Compute SMA(fast) and SMA(slow) aligned to each completed candle. */
export function computeSmaSeries(candles: Candle[], fastPeriod: number, slowPeriod: number): SMAPoint[] {
  const closes = candles.map((c) => c.close);
  const smaFast = computeSMA(closes, fastPeriod);
  const smaSlow = computeSMA(closes, slowPeriod);
  return candles.map((c, i) => ({
    ts: c.ts,
    close: c.close,
    smaFast: smaFast[i] ?? null,
    smaSlow: smaSlow[i] ?? null,
  }));
}

export interface MovingAveragePoint {
  ts: number;
  close: number;
  sma7: number | null;
  sma30: number | null;
  sma90: number | null;
}

export function computeTripleSmaSeries(
  candles: Candle[],
  sma7Period: number,
  sma30Period: number,
  sma90Period: number
): MovingAveragePoint[] {
  const closes = candles.map((c) => c.close);
  const sma7 = computeSMA(closes, sma7Period);
  const sma30 = computeSMA(closes, sma30Period);
  const sma90 = computeSMA(closes, sma90Period);
  return candles.map((c, i) => ({
    ts: c.ts,
    close: c.close,
    sma7: sma7[i] ?? null,
    sma30: sma30[i] ?? null,
    sma90: sma90[i] ?? null,
  }));
}

export function computeTrueRanges(candles: Candle[]): number[] {
  return candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1]!.close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  });
}

export function computeATR(candles: Candle[], period: number): (number | null)[] {
  const trueRanges = computeTrueRanges(candles);
  const result = new Array<number | null>(candles.length).fill(null);
  let windowSum = 0;
  for (let i = 0; i < trueRanges.length; i++) {
    windowSum += trueRanges[i]!;
    if (i >= period) {
      windowSum -= trueRanges[i - period]!;
    }
    if (i >= period - 1) {
      result[i] = windowSum / period;
    }
  }
  return result;
}

export function normalizedSlope(
  values: (number | null)[],
  index: number,
  lookback: number,
  atr: number | null
): number | null {
  if (atr === null || !Number.isFinite(atr) || atr <= 0) return null;
  const current = values[index] ?? null;
  const previous = values[index - lookback] ?? null;
  if (current === null || previous === null) return null;
  return (current - previous) / atr;
}
