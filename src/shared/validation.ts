import type { Candle } from "./types";

export interface CandleValidationResult {
  ok: boolean;
  errors: string[];
}

export function isValidPrice(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export interface ValidateCandlesOptions {
  minRequired: number;
  intervalMinutes: number;
  maxDataAgeMinutes: number;
  now?: number;
}

/** Ported from the Python prototype's validate_candles: same checks, same
 * "any ambiguity blocks" philosophy. Candles must be ascending by ts. */
export function validateCandles(candles: Candle[], opts: ValidateCandlesOptions): CandleValidationResult {
  const now = opts.now ?? Date.now();
  const errors: string[] = [];

  if (candles.length === 0) {
    return { ok: false, errors: ["no candles available"] };
  }

  if (candles.length < opts.minRequired) {
    errors.push(
      `insufficient candles: got ${candles.length}, need at least ${opts.minRequired}`
    );
  }

  const timestamps = candles.map((c) => c.ts);
  const uniqueCount = new Set(timestamps).size;
  const isSorted = timestamps.every((t, i) => i === 0 || t > timestamps[i - 1]!);
  if (uniqueCount !== timestamps.length || !isSorted) {
    errors.push("duplicate or out-of-order candle timestamps");
  } else {
    const expectedGapMs = opts.intervalMinutes * 60_000;
    for (let i = 1; i < candles.length; i++) {
      const gap = candles[i]!.ts - candles[i - 1]!.ts;
      if (gap > expectedGapMs) {
        errors.push(`missing candle(s) detected between index ${i - 1} and ${i}`);
        break;
      }
    }
  }

  const hasMalformedPrice = candles.some(
    (c) =>
      !isValidPrice(c.open) ||
      !isValidPrice(c.high) ||
      !isValidPrice(c.low) ||
      !isValidPrice(c.close) ||
      !Number.isFinite(c.volume) ||
      c.volume < 0
  );
  if (hasMalformedPrice) {
    errors.push("malformed price or volume in candle series");
  }

  const latest = candles[candles.length - 1]!;
  const candleCloseTime = latest.ts + opts.intervalMinutes * 60_000;
  const ageMinutes = (now - candleCloseTime) / 60_000;
  if (ageMinutes > opts.maxDataAgeMinutes) {
    errors.push(`stale data: latest completed candle is ${ageMinutes.toFixed(1)} minutes old`);
  }

  return { ok: errors.length === 0, errors };
}

export interface PriceToleranceResult {
  withinTolerance: boolean;
  diffPercent: number;
}

export function checkPriceTolerance(
  uiPrice: number,
  apiPrice: number,
  tolerancePercent: number
): PriceToleranceResult {
  if (!isValidPrice(uiPrice) || !isValidPrice(apiPrice)) {
    return { withinTolerance: false, diffPercent: Number.NaN };
  }
  const diffPercent = (Math.abs(uiPrice - apiPrice) / apiPrice) * 100;
  return { withinTolerance: diffPercent <= tolerancePercent, diffPercent };
}
