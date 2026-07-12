import { describe, expect, it } from "vitest";
import { computeSMA, computeSmaSeries } from "../src/strategy/sma";
import type { Candle } from "../src/shared/types";

function makeCandles(closes: number[]): Candle[] {
  const startTs = Date.UTC(2026, 0, 1);
  return closes.map((close, i) => ({
    ts: startTs + i * 3_600_000,
    open: close,
    high: close + 0.01,
    low: close - 0.01,
    close,
    volume: 100,
  }));
}

describe("computeSMA", () => {
  it("matches a manual average", () => {
    const result = computeSMA([1, 2, 3, 4, 5, 6, 7], 3);
    expect(result[result.length - 1]).toBeCloseTo(6); // avg(5,6,7)
  });

  it("is null until the window fills, never estimated", () => {
    const result = computeSMA([1, 2, 3], 5);
    expect(result).toEqual([null, null, null]);
  });

  it("has no look-ahead bias: a later value never changes an earlier SMA", () => {
    const base = [1, 2, 3, 4, 5, 6, 7];
    const withChangedFuture = [1, 2, 3, 4, 5, 999, 7];
    const resultBase = computeSMA(base, 3);
    const resultChanged = computeSMA(withChangedFuture, 3);
    expect(resultChanged[3]).toEqual(resultBase[3]);
  });
});

describe("computeSmaSeries", () => {
  it("computes SMA7 and SMA30 aligned to each completed candle", () => {
    const closes = Array.from({ length: 35 }, (_, i) => 100 + i);
    const candles = makeCandles(closes);
    const series = computeSmaSeries(candles, 7, 30);
    expect(series).toHaveLength(35);
    expect(series[29]!.smaSlow).not.toBeNull();
    expect(series[28]!.smaSlow).toBeNull();
    expect(series[6]!.smaFast).not.toBeNull();
    expect(series[5]!.smaFast).toBeNull();
  });

  it("only ever uses completed candles passed to it (caller excludes the forming hour)", () => {
    const closes = [10, 10, 10, 10, 10, 10, 10];
    const candles = makeCandles(closes);
    const series = computeSmaSeries(candles, 7, 30);
    expect(series).toHaveLength(7); // no extra forming candle sneaks in
  });
});
