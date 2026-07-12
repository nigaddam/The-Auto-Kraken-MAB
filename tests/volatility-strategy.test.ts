import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/constants";
import type { Candle, Settings, TrackedPosition } from "../src/shared/types";
import { computeATR, computeSMA, computeTripleSmaSeries, normalizedSlope } from "../src/strategy/sma";
import {
  classifyRegime,
  computeDynamicProfitFloorPct,
  computeEffectiveHardLossPct,
  evaluateVolatilityAdjustedStrategy,
} from "../src/strategy/exit-strategy";

const HOUR = 3_600_000;

function candle(i: number, close: number, opts: Partial<Candle> = {}): Candle {
  return {
    ts: i * HOUR,
    open: opts.open ?? close,
    high: opts.high ?? close + 1,
    low: opts.low ?? close - 1,
    close,
    volume: opts.volume ?? 100,
  };
}

function series(count: number, start = 100, step = 0.2): Candle[] {
  return Array.from({ length: count }, (_, i) => candle(i, start + i * step));
}

function position(overrides: Partial<TrackedPosition> = {}): TrackedPosition {
  return {
    fingerprint: "AAVE:LONG:100.000000:100:2",
    symbol: "AAVE",
    side: "LONG",
    openingPrice: 100,
    openingValueUsd: 100,
    firstObservedAt: 0,
    lastSeenAt: 0,
    status: "ACTIVE",
    latest: {
      symbol: "AAVE",
      side: "LONG",
      entryPrice: 100,
      currentPriceUi: 101,
      valueUsd: 100,
      upnl: 1,
      netPnl: 1,
      leverage: 2,
      tpSlText: null,
    },
    latestApiPrice: 101,
    latestApiPriceAt: 0,
    highestObservedPrice: 101,
    peakReturnPct: 1,
    peakPrice: 101,
    profitFloorPct: null,
    smaFast: null,
    smaSlow: null,
    trend: "UNKNOWN",
    regime: "UNKNOWN",
    consecutiveClosesBelowSmaFast: 0,
    lastProcessedCandleTs: null,
    hardLossObservedSince: null,
    hardLossObservationCount: 0,
    strategyDiagnostics: null,
    decision: "HOLD",
    reason: "seed",
    autoCloseDisabledReason: null,
    ...overrides,
  };
}

function evalStrategy(args: {
  candles?: Candle[];
  apiPrice?: number;
  pos?: Partial<TrackedPosition>;
  settings?: Partial<Settings>;
  now?: number;
  blockingReasons?: string[];
}) {
  return evaluateVolatilityAdjustedStrategy({
    position: position(args.pos),
    candles: args.candles ?? series(120),
    apiPrice: args.apiPrice ?? 101,
    settings: { ...DEFAULT_SETTINGS, ...args.settings },
    now: args.now ?? 10_000,
    blockingReasons: args.blockingReasons ?? [],
  });
}

describe("volatility indicators", () => {
  it("calculates SMA7/SMA30/SMA90 and normalized slopes", () => {
    const candles = series(120, 1, 1);
    const points = computeTripleSmaSeries(candles, 7, 30, 90);
    expect(points[119]!.sma7).toBeCloseTo(117);
    expect(points[119]!.sma30).toBeCloseTo(105.5);
    expect(points[119]!.sma90).toBeCloseTo(75.5);
    expect(normalizedSlope(points.map((p) => p.sma7), 119, 3, 2)).toBeCloseTo(1.5);
  });

  it("calculates ATR14 from true ranges", () => {
    const candles = Array.from({ length: 20 }, (_, i) =>
      candle(i, 100 + i, { high: 102 + i, low: 98 + i })
    );
    const atr = computeATR(candles, 14);
    expect(atr[19]).toBeCloseTo(4);
  });

  it("returns null slope for zero or invalid ATR", () => {
    expect(normalizedSlope([1, 2, 3, 4], 3, 1, 0)).toBeNull();
    expect(normalizedSlope([1, 2, 3, 4], 3, 1, Number.NaN)).toBeNull();
  });

  it("keeps existing SMA helper behavior", () => {
    expect(computeSMA([1, 2, 3, 4], 3)).toEqual([null, null, 2, 3]);
  });
});

describe("volatility hard loss", () => {
  it("clamps ATR stop inside configured bounds", () => {
    expect(computeEffectiveHardLossPct(100, 1.2, DEFAULT_SETTINGS)).toBeCloseTo(-2.4);
  });

  it("clamps shallow ATR stop to -1.75%", () => {
    expect(computeEffectiveHardLossPct(100, 0.6, DEFAULT_SETTINGS)).toBeCloseTo(-1.75);
  });

  it("clamps wide ATR stop to -3.0%", () => {
    expect(computeEffectiveHardLossPct(100, 2.25, DEFAULT_SETTINGS)).toBeCloseTo(-3);
  });

  it("uses fallback when ATR is unavailable", () => {
    expect(computeEffectiveHardLossPct(100, null, DEFAULT_SETTINGS)).toBeCloseTo(-3);
  });

  it("debounces a hard-loss tick instead of closing immediately", () => {
    const result = evalStrategy({ apiPrice: 97, settings: { hardLossRequiredObservations: 2 } });
    expect(result.decision).toBe("WATCH");
    expect(result.reasonCode).toBe("WATCHING_CONFIRMATION");
  });

  it("confirmed hard loss produces CLOSE", () => {
    const result = evalStrategy({
      apiPrice: 97,
      pos: { hardLossObservedSince: 0, hardLossObservationCount: 1 },
      now: 30_000,
    });
    expect(result.decision).toBe("CLOSE");
    expect(result.reasonCode).toBe("HARD_LOSS");
  });
});

describe("regime classification", () => {
  it("classifies EXPANSION, HEALTHY, DETERIORATING, and BROKEN", () => {
    const settings = DEFAULT_SETTINGS;
    expect(classifyRegime({ sma7: 110, sma30: 100, slope7: 0.04, slope30: 0.01, latestClose: 111, closesBelowSma7: 0, settings })).toBe("EXPANSION");
    expect(classifyRegime({ sma7: 110, sma30: 100, slope7: 0.01, slope30: 0, latestClose: 111, closesBelowSma7: 0, settings })).toBe("HEALTHY");
    expect(classifyRegime({ sma7: 110, sma30: 100, slope7: -0.04, slope30: 0, latestClose: 111, closesBelowSma7: 0, settings })).toBe("DETERIORATING");
    expect(classifyRegime({ sma7: 99, sma30: 100, slope7: 0, slope30: 0, latestClose: 100, closesBelowSma7: 0, settings })).toBe("BROKEN");
  });

  it("applies BROKEN before other tie cases", () => {
    expect(classifyRegime({
      sma7: 100,
      sma30: 100,
      slope7: 0.2,
      slope30: 0,
      latestClose: 110,
      closesBelowSma7: 0,
      settings: DEFAULT_SETTINGS,
    })).toBe("BROKEN");
  });
});

describe("profit protection and exits", () => {
  it("does not create a floor below activation and ratchets upward", () => {
    expect(computeDynamicProfitFloorPct(2.9, null)).toBeNull();
    expect(computeDynamicProfitFloorPct(3, null)).toBeCloseTo(1.05);
    expect(computeDynamicProfitFloorPct(10, 1.05)).toBeCloseTo(5);
    expect(computeDynamicProfitFloorPct(8, 7)).toBeCloseTo(7);
  });

  it("EXPANSION floor touch produces WATCH", () => {
    const result = evalStrategy({
      apiPrice: 104.8,
      pos: { peakReturnPct: 10, peakPrice: 110, profitFloorPct: 5 },
    });
    expect(result.decision).toBe("WATCH");
  });

  it("major SMA30 break has priority", () => {
    const candles = series(119, 100, 0.1);
    candles.push(candle(119, 90, { high: 91, low: 89 }));
    const result = evalStrategy({ candles, apiPrice: 101 });
    expect(result.decision).toBe("CLOSE");
    expect(result.reasonCode).toBe("MAJOR_TREND_BREAK");
  });

  it("CLOSE becomes BLOCKED when execution safety fails", () => {
    const candles = series(119, 100, 0.1);
    candles.push(candle(119, 90, { high: 91, low: 89 }));
    const result = evalStrategy({ candles, apiPrice: 101, blockingReasons: ["API/UI price mismatch"] });
    expect(result.decision).toBe("BLOCKED");
    expect(result.reason).toMatch(/Strategy decision: CLOSE - MAJOR_TREND_BREAK/);
    expect(result.diagnostics.failedSafetyGates).toEqual(["API/UI price mismatch"]);
  });

  it("insufficient SMA90 history returns ERROR", () => {
    const result = evalStrategy({ candles: series(80) });
    expect(result.decision).toBe("ERROR");
    expect(result.reasonCode).toBe("STRATEGY_DATA_INVALID");
  });

  it("new fingerprint starts without inherited peak", () => {
    const oldLot = evalStrategy({ apiPrice: 122, pos: { fingerprint: "OLD", peakReturnPct: 20, peakPrice: 120 } });
    const newLot = evalStrategy({ apiPrice: 101, pos: { fingerprint: "NEW", peakReturnPct: 0, peakPrice: 100 } });
    expect(oldLot.peakReturnPct).toBeGreaterThan(20);
    expect(newLot.peakReturnPct).toBeLessThan(20);
  });
});
