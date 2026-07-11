import { describe, expect, it } from "vitest";
import {
  advanceBuySignalProgress,
  INITIAL_BUY_SIGNAL_STATE,
  seedBuySignalProgressAtLatestCompleted,
} from "../src/strategy/buy-signal";
import type { SMAPoint } from "../src/shared/types";

const HOUR = 3_600_000;
const START = Date.UTC(2026, 0, 1);

function point(i: number, close: number, smaFast: number | null, smaSlow: number | null): SMAPoint {
  return { ts: START + i * HOUR, close, smaFast, smaSlow };
}

describe("seedBuySignalProgressAtLatestCompleted", () => {
  it("seeds lastProcessedCandleTs from the latest point when null", () => {
    const series = [point(0, 10, 9, 9.5), point(1, 11, 9.5, 9.5)];
    const seeded = seedBuySignalProgressAtLatestCompleted(INITIAL_BUY_SIGNAL_STATE, series);
    expect(seeded.lastProcessedCandleTs).toBe(series[1]!.ts);
    expect(seeded.consecutiveClosesAboveSmaFast).toBe(0);
  });

  it("leaves an already-seeded state untouched", () => {
    const prev = { ...INITIAL_BUY_SIGNAL_STATE, lastProcessedCandleTs: 12345 };
    const series = [point(0, 10, 9, 9.5)];
    expect(seedBuySignalProgressAtLatestCompleted(prev, series)).toBe(prev);
  });
});

describe("advanceBuySignalProgress", () => {
  it("counts consecutive completed closes above SMA7 and confirms once the threshold and STRONG trend are both met", () => {
    // Two new completed closes above smaFast, smaFast > smaSlow (STRONG).
    const series = [point(0, 10, 9, 9.5), point(1, 11, 9.5, 9.4)];
    const result = advanceBuySignalProgress(INITIAL_BUY_SIGNAL_STATE, series, 2);
    expect(result.consecutiveClosesAboveSmaFast).toBe(2);
    expect(result.trend).toBe("STRONG");
    expect(result.newlyConfirmed).toBe(true);
    expect(result.signalFiredForThisEpisode).toBe(true);
  });

  it("does not confirm on only one qualifying close when two are required", () => {
    const series = [point(0, 11, 9.5, 9.4)];
    const result = advanceBuySignalProgress(INITIAL_BUY_SIGNAL_STATE, series, 2);
    expect(result.consecutiveClosesAboveSmaFast).toBe(1);
    expect(result.newlyConfirmed).toBe(false);
  });

  it("resets the counter to 0 the moment a close drops back below SMA7", () => {
    const series = [point(0, 11, 9.5, 9.4), point(1, 9, 9.5, 9.4)];
    const result = advanceBuySignalProgress(INITIAL_BUY_SIGNAL_STATE, series, 2);
    expect(result.consecutiveClosesAboveSmaFast).toBe(0);
    expect(result.newlyConfirmed).toBe(false);
  });

  it("never confirms while trend is WEAK, no matter how high the counter is", () => {
    // smaFast <= smaSlow => WEAK, even though close is "above" smaFast both times.
    const series = [point(0, 10, 9, 9.5), point(1, 11, 9.4, 9.5)];
    const result = advanceBuySignalProgress(INITIAL_BUY_SIGNAL_STATE, series, 2);
    expect(result.trend).toBe("WEAK");
    expect(result.newlyConfirmed).toBe(false);
    expect(result.signalFiredForThisEpisode).toBe(false);
  });

  it("only fires newlyConfirmed once per STRONG episode, not every subsequent cycle", () => {
    const firstBatch = [point(0, 10, 9, 9.5), point(1, 11, 9.5, 9.4)];
    const first = advanceBuySignalProgress(INITIAL_BUY_SIGNAL_STATE, firstBatch, 2);
    expect(first.newlyConfirmed).toBe(true);

    // Next cycle: one more new completed close, still STRONG, already fired.
    const secondBatch = [...firstBatch, point(2, 12, 9.6, 9.4)];
    const second = advanceBuySignalProgress(first, secondBatch, 2);
    expect(second.trend).toBe("STRONG");
    expect(second.newlyConfirmed).toBe(false);
    expect(second.signalFiredForThisEpisode).toBe(true);
  });

  it("resets signalFiredForThisEpisode once trend drops out of STRONG, allowing a later genuine re-fire", () => {
    const strongBatch = [point(0, 10, 9, 9.5), point(1, 11, 9.5, 9.4)];
    const fired = advanceBuySignalProgress(INITIAL_BUY_SIGNAL_STATE, strongBatch, 2);
    expect(fired.signalFiredForThisEpisode).toBe(true);

    // Trend drops to WEAK (smaFast <= smaSlow).
    const weakBatch = [...strongBatch, point(2, 8, 9.3, 9.4)];
    const droppedOut = advanceBuySignalProgress(fired, weakBatch, 2);
    expect(droppedOut.trend).toBe("WEAK");
    expect(droppedOut.signalFiredForThisEpisode).toBe(false);

    // New STRONG episode with two fresh qualifying closes should fire again.
    const newStrongBatch = [
      ...weakBatch,
      point(3, 10, 9.4, 9.3),
      point(4, 11, 9.6, 9.3),
    ];
    const refired = advanceBuySignalProgress(droppedOut, newStrongBatch, 2);
    expect(refired.trend).toBe("STRONG");
    expect(refired.newlyConfirmed).toBe(true);
  });

  it("never double-counts a candle already processed in a prior call", () => {
    const series = [point(0, 10, 9, 9.5), point(1, 11, 9.5, 9.4)];
    const first = advanceBuySignalProgress(INITIAL_BUY_SIGNAL_STATE, series, 5);
    expect(first.consecutiveClosesAboveSmaFast).toBe(2);

    // Re-running with the exact same series (no new points beyond
    // lastProcessedCandleTs) must not advance the counter further.
    const second = advanceBuySignalProgress(first, series, 5);
    expect(second.consecutiveClosesAboveSmaFast).toBe(2);
  });

  it("treats a null smaFast point as a no-op for the counter (data gap, not a reset)", () => {
    const series = [point(0, 11, 9.5, 9.4), point(1, 12, null, 9.4)];
    const result = advanceBuySignalProgress(INITIAL_BUY_SIGNAL_STATE, series, 2);
    expect(result.consecutiveClosesAboveSmaFast).toBe(1);
  });
});
