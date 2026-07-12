import { describe, expect, it } from "vitest";
import {
  advanceCandleProgress,
  applySafetyGating,
  computeCurrentReturnPct,
  computeProfitFloor,
  determineTrend,
  evaluateExitRules,
  seedCandleProgressAtLatestCompleted,
  updatePeakAndFloor,
} from "../src/strategy/exit-strategy";
import type { SMAPoint } from "../src/shared/types";

describe("computeCurrentReturnPct", () => {
  it("computes percentage return from entry", () => {
    expect(computeCurrentReturnPct(100, 105)).toBeCloseTo(5);
    expect(computeCurrentReturnPct(100, 97)).toBeCloseTo(-3);
  });
});

describe("computeProfitFloor tiers", () => {
  it("is inactive below the activation threshold", () => {
    expect(computeProfitFloor(2, 3)).toBeNull();
  });

  it("matches the spec's worked examples exactly", () => {
    expect(computeProfitFloor(4, 3)).toBeCloseTo(2); // 4 * 0.5
    expect(computeProfitFloor(10, 3)).toBeCloseTo(6.5); // 10 * 0.65
    expect(computeProfitFloor(20, 3)).toBeCloseTo(15); // 20 * 0.75
  });

  it("covers tier boundaries", () => {
    expect(computeProfitFloor(3, 3)).toBeCloseTo(1.5);
    expect(computeProfitFloor(6.999, 3)).toBeCloseTo(6.999 * 0.5, 3);
    expect(computeProfitFloor(7, 3)).toBeCloseTo(7 * 0.65);
    expect(computeProfitFloor(15, 3)).toBeCloseTo(15 * 0.75);
  });
});

describe("updatePeakAndFloor monotonicity", () => {
  it("the floor only ever rises, even as price declines after the peak", () => {
    let state = { peakReturnPct: 0, profitFloorPct: null as number | null };
    state = updatePeakAndFloor(state, 10, 3); // peak 10%, floor 6.5%
    expect(state.profitFloorPct).toBeCloseTo(6.5);

    state = updatePeakAndFloor(state, 4, 3); // price pulled back to +4%
    expect(state.peakReturnPct).toBeCloseTo(10); // peak unchanged
    expect(state.profitFloorPct).toBeCloseTo(6.5); // floor must not loosen
  });

  it("raises the floor again once a new higher peak is reached", () => {
    let state = { peakReturnPct: 0, profitFloorPct: null as number | null };
    state = updatePeakAndFloor(state, 4, 3);
    expect(state.profitFloorPct).toBeCloseTo(2);
    state = updatePeakAndFloor(state, 20, 3);
    expect(state.profitFloorPct).toBeCloseTo(15);
  });
});

describe("determineTrend", () => {
  it("is STRONG when SMA7 > SMA30, WEAK when SMA7 <= SMA30, UNKNOWN when data missing", () => {
    expect(determineTrend(10, 9)).toBe("STRONG");
    expect(determineTrend(9, 10)).toBe("WEAK");
    expect(determineTrend(9, 9)).toBe("WEAK");
    expect(determineTrend(null, 9)).toBe("UNKNOWN");
    expect(determineTrend(9, null)).toBe("UNKNOWN");
  });
});

function point(ts: number, close: number, smaFast: number | null, smaSlow: number | null): SMAPoint {
  return { ts, close, smaFast, smaSlow };
}

describe("advanceCandleProgress", () => {
  it("counts consecutive completed closes below SMA7 and resets on a close above it", () => {
    const series: SMAPoint[] = [
      point(1, 10, 11, 12), // below fast -> 1
      point(2, 10, 11, 12), // below fast -> 2
      point(3, 13, 11, 12), // above fast -> reset to 0
    ];
    const result = advanceCandleProgress({ consecutiveClosesBelowSmaFast: 0, lastProcessedCandleTs: null }, series);
    expect(result.consecutiveClosesBelowSmaFast).toBe(0);
  });

  it("does not reprocess candles older than lastProcessedCandleTs (no repeat-processing)", () => {
    const series: SMAPoint[] = [point(1, 10, 11, 12)];
    const first = advanceCandleProgress({ consecutiveClosesBelowSmaFast: 0, lastProcessedCandleTs: null }, series);
    expect(first.consecutiveClosesBelowSmaFast).toBe(1);

    // Same series polled again (e.g. 5 minutes later, same hourly candle still latest).
    const second = advanceCandleProgress(first, series);
    expect(second.consecutiveClosesBelowSmaFast).toBe(1); // unchanged, not double-counted
    expect(second.lastProcessedCandleTs).toBe(1);
  });

  it("advances only over genuinely new candles when polled again later", () => {
    const firstPoll: SMAPoint[] = [point(1, 10, 11, 12)];
    let state = advanceCandleProgress({ consecutiveClosesBelowSmaFast: 0, lastProcessedCandleTs: null }, firstPoll);
    expect(state.consecutiveClosesBelowSmaFast).toBe(1);

    const secondPoll: SMAPoint[] = [point(1, 10, 11, 12), point(2, 9, 11, 12)];
    state = advanceCandleProgress(state, secondPoll);
    expect(state.consecutiveClosesBelowSmaFast).toBe(2);
    expect(state.lastProcessedCandleTs).toBe(2);
  });

  it("seeds a new position at the latest completed candle without counting historical below-SMA closes", () => {
    const historicalSeries: SMAPoint[] = [
      point(1, 10, 11, 9),
      point(2, 10, 11, 9),
      point(3, 10, 11, 9),
      point(4, 10, 11, 9),
      point(5, 10, 11, 9),
      point(6, 10, 11, 9),
      point(7, 10, 11, 9),
    ];
    const seeded = seedCandleProgressAtLatestCompleted(
      { consecutiveClosesBelowSmaFast: 0, lastProcessedCandleTs: null },
      historicalSeries
    );
    const progress = advanceCandleProgress(seeded, historicalSeries);
    expect(progress.consecutiveClosesBelowSmaFast).toBe(0);
    expect(progress.lastProcessedCandleTs).toBe(7);
    expect(progress.trend).toBe("STRONG");
  });

  it("counts only candles that complete after the seeded registration candle", () => {
    const firstPoll = [point(10, 10, 11, 9)];
    let progress = seedCandleProgressAtLatestCompleted(
      { consecutiveClosesBelowSmaFast: 0, lastProcessedCandleTs: null },
      firstPoll
    );
    progress = advanceCandleProgress(progress, firstPoll);
    expect(progress.consecutiveClosesBelowSmaFast).toBe(0);

    progress = advanceCandleProgress(progress, [...firstPoll, point(11, 9.5, 11, 9)]);
    expect(progress.consecutiveClosesBelowSmaFast).toBe(1);

    progress = advanceCandleProgress(progress, [...firstPoll, point(11, 9.5, 11, 9), point(12, 12, 11, 9)]);
    expect(progress.consecutiveClosesBelowSmaFast).toBe(0);
  });
});

const baseInput = {
  currentReturnPct: 1,
  hardLossPercent: -3,
  profitFloorPct: null as number | null,
  trend: "STRONG" as const,
  consecutiveClosesBelowSmaFast: 0,
  strongTrendConfirmationCloses: 2,
  weakTrendConfirmationCloses: 1,
};

describe("evaluateExitRules priority ordering", () => {
  it("Rule 1 hard loss wins even if SMA and profit-floor conditions are also active", () => {
    const result = evaluateExitRules({
      ...baseInput,
      currentReturnPct: -5,
      profitFloorPct: -1, // would also trigger Rule 2
      consecutiveClosesBelowSmaFast: 5, // would also trigger Rule 3
    });
    expect(result.decision).toBe("CLOSE");
    expect(result.reason).toMatch(/hard-loss/);
  });

  it("Rule 2 profit protection triggers when return falls to/below the floor", () => {
    const result = evaluateExitRules({ ...baseInput, currentReturnPct: 6, profitFloorPct: 6.5 });
    expect(result.decision).toBe("CLOSE");
    expect(result.reason).toMatch(/profit floor/);
  });

  it("strong trend requires two consecutive closes below SMA7 before closing", () => {
    const oneClose = evaluateExitRules({ ...baseInput, trend: "STRONG", consecutiveClosesBelowSmaFast: 1 });
    expect(oneClose.decision).toBe("WATCH");

    const twoCloses = evaluateExitRules({ ...baseInput, trend: "STRONG", consecutiveClosesBelowSmaFast: 2 });
    expect(twoCloses.decision).toBe("CLOSE");
    expect(twoCloses.reason).toMatch(/threshold \(2\)/);
  });

  it("weak trend closes on a single completed close below SMA7", () => {
    const result = evaluateExitRules({ ...baseInput, trend: "WEAK", consecutiveClosesBelowSmaFast: 1 });
    expect(result.decision).toBe("CLOSE");
    expect(result.reason).toMatch(/threshold \(1\)/);
  });

  it("holds when trend is unknown (not enough SMA history)", () => {
    const result = evaluateExitRules({ ...baseInput, trend: "UNKNOWN", consecutiveClosesBelowSmaFast: 0 });
    expect(result.decision).toBe("HOLD");
  });

  it("holds when no exit rule is active", () => {
    const result = evaluateExitRules({ ...baseInput, trend: "STRONG", consecutiveClosesBelowSmaFast: 0 });
    expect(result.decision).toBe("HOLD");
  });
});

describe("applySafetyGating", () => {
  it("downgrades a CLOSE to BLOCKED when blocking reasons are present", () => {
    const result = applySafetyGating({ decision: "CLOSE", reason: "hard loss" }, ["stale market data"]);
    expect(result.decision).toBe("BLOCKED");
    expect(result.reason).toMatch(/stale market data/);
  });

  it("never blocks HOLD or WATCH — there is nothing to execute yet", () => {
    expect(applySafetyGating({ decision: "HOLD", reason: "x" }, ["some reason"]).decision).toBe("HOLD");
    expect(applySafetyGating({ decision: "WATCH", reason: "x" }, ["some reason"]).decision).toBe("WATCH");
  });

  it("passes CLOSE through unchanged when there are no blocking reasons", () => {
    const result = applySafetyGating({ decision: "CLOSE", reason: "hard loss" }, []);
    expect(result.decision).toBe("CLOSE");
  });
});

describe("regression: JTO entry 0.61828 -> current 0.59870 must CLOSE on hard loss", () => {
  const entryPrice = 0.61828;
  const currentPrice = 0.5987;
  // (0.59870 / 0.61828) - 1 ~= -3.1668%
  const expectedReturnPct = (currentPrice / entryPrice - 1) * 100;

  it("computes the expected ~-3.17% return", () => {
    const returnPct = computeCurrentReturnPct(entryPrice, currentPrice);
    expect(returnPct).toBeCloseTo(expectedReturnPct, 6);
    expect(returnPct).toBeCloseTo(-3.1668, 3);
    expect(returnPct).toBeLessThanOrEqual(-3);
  });

  it("CLOSEs with HARD_LOSS even while the SMA rule alone would HOLD", () => {
    const returnPct = computeCurrentReturnPct(entryPrice, currentPrice);
    const result = evaluateExitRules({
      currentReturnPct: returnPct,
      hardLossPercent: -3,
      profitFloorPct: null,
      trend: "STRONG",
      consecutiveClosesBelowSmaFast: 0, // SMA rule alone -> HOLD
      strongTrendConfirmationCloses: 2,
      weakTrendConfirmationCloses: 1,
    });
    expect(result.decision).toBe("CLOSE");
    expect(result.reason).toMatch(/hard-loss/i);
  });

  it("CLOSEs with HARD_LOSS even while the SMA rule alone would WATCH", () => {
    const returnPct = computeCurrentReturnPct(entryPrice, currentPrice);
    const result = evaluateExitRules({
      currentReturnPct: returnPct,
      hardLossPercent: -3,
      profitFloorPct: null,
      trend: "STRONG",
      consecutiveClosesBelowSmaFast: 1, // SMA rule alone -> WATCH
      strongTrendConfirmationCloses: 2,
      weakTrendConfirmationCloses: 1,
    });
    expect(result.decision).toBe("CLOSE");
    expect(result.reason).toMatch(/hard-loss/i);
  });

  it("does not wait for an hourly candle close — evaluated purely from live price, no candle/SMA input required", () => {
    // computeCurrentReturnPct takes only (openingPrice, currentPrice); it has
    // no candle or SMA parameter at all, so there is nothing to "wait for."
    const returnPct = computeCurrentReturnPct(entryPrice, currentPrice);
    const result = evaluateExitRules({
      currentReturnPct: returnPct,
      hardLossPercent: -3,
      profitFloorPct: null,
      trend: "UNKNOWN", // as if zero completed candles exist yet
      consecutiveClosesBelowSmaFast: 0,
      strongTrendConfirmationCloses: 2,
      weakTrendConfirmationCloses: 1,
    });
    expect(result.decision).toBe("CLOSE");
  });

  it("uses plain price return from opening price, not a leverage-multiplied margin return", () => {
    // computeCurrentReturnPct's signature has no leverage parameter — it
    // structurally cannot fold leverage into the calculation. A 3x-leveraged
    // position with this same entry/current price must report the same
    // ~-3.17% price return, not a leverage-inflated ~-9.5% margin return.
    const unleveraged = computeCurrentReturnPct(entryPrice, currentPrice);
    const asIfLeveraged = computeCurrentReturnPct(entryPrice, currentPrice); // no leverage input possible
    expect(unleveraged).toBeCloseTo(asIfLeveraged, 10);
    expect(Math.abs(unleveraged)).toBeLessThan(5); // sanity: not a leverage-inflated magnitude
  });
});
