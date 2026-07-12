import { describe, expect, it } from "vitest";
import { applySafetyGating, isNewCloseTransition } from "../src/strategy/exit-strategy";
import { checkPriceTolerance, validateCandles } from "../src/shared/validation";
import {
  clickClosePosition,
  confirmCloseModal,
  highlightPositionRow,
} from "../src/content/close-executor";
import type { Candle } from "../src/shared/types";

describe("legacy close-executor stubs remain disabled", () => {
  it("highlightPositionRow (Iteration 2+) always throws", () => {
    expect(() => highlightPositionRow("JTO")).toThrow(/disabled legacy stub/i);
  });
  it("clickClosePosition (Iteration 3+) always throws", () => {
    expect(() => clickClosePosition("JTO")).toThrow(/disabled legacy stub/i);
  });
  it("confirmCloseModal (Iteration 4+) always throws", () => {
    expect(() => confirmCloseModal("JTO")).toThrow(/disabled legacy stub/i);
  });
});

describe("stale/invalid market data cannot produce an actionable decision", () => {
  const validCandle = (ts: number, close: number): Candle => ({
    ts,
    open: close,
    high: close + 0.01,
    low: close - 0.01,
    close,
    volume: 100,
  });

  it("flags insufficient candle history", () => {
    const candles = [validCandle(0, 10), validCandle(3_600_000, 10)];
    const result = validateCandles(candles, { minRequired: 31, intervalMinutes: 60, maxDataAgeMinutes: 90 });
    expect(result.ok).toBe(false);
  });

  it("flags a stale latest candle", () => {
    const now = Date.now();
    const candles = Array.from({ length: 31 }, (_, i) => validCandle(now - (31 - i) * 3_600_000 - 5 * 3_600_000, 10));
    const result = validateCandles(candles, {
      minRequired: 31,
      intervalMinutes: 60,
      maxDataAgeMinutes: 90,
      now,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("stale"))).toBe(true);
  });
});

describe("API/UI price mismatch blocks execution", () => {
  it("flags a mismatch beyond tolerance", () => {
    const tolerance = checkPriceTolerance(0.63, 0.6, 1);
    expect(tolerance.withinTolerance).toBe(false);
  });

  it("downgrades an otherwise-valid CLOSE to BLOCKED when price mismatch is detected", () => {
    const tolerance = checkPriceTolerance(0.63, 0.6, 1);
    const blockingReasons = tolerance.withinTolerance ? [] : ["UI/API price mismatch"];
    const gated = applySafetyGating({ decision: "CLOSE", reason: "hard loss" }, blockingReasons);
    expect(gated.decision).toBe("BLOCKED");
  });

  it("allows execution to proceed when within tolerance", () => {
    const tolerance = checkPriceTolerance(0.601, 0.6, 1);
    expect(tolerance.withinTolerance).toBe(true);
    const gated = applySafetyGating(
      { decision: "CLOSE", reason: "hard loss" },
      tolerance.withinTolerance ? [] : ["mismatch"]
    );
    expect(gated.decision).toBe("CLOSE");
  });
});

describe("a changed (manually adjusted) position blocks execution", () => {
  it("is treated as a blocking reason regardless of the underlying rule result", () => {
    const blockingReasons = ["position changed manually; awaiting acknowledgment"];
    const gated = applySafetyGating({ decision: "CLOSE", reason: "profit floor breached" }, blockingReasons);
    expect(gated.decision).toBe("BLOCKED");
    expect(gated.reason).toMatch(/awaiting acknowledgment/);
  });
});

describe("isNewCloseTransition prevents acting on the same condition repeatedly", () => {
  it("is true only the first time CLOSE appears", () => {
    expect(isNewCloseTransition("HOLD", "CLOSE")).toBe(true);
    expect(isNewCloseTransition("WATCH", "CLOSE")).toBe(true);
  });

  it("is false on every subsequent poll while CLOSE persists", () => {
    expect(isNewCloseTransition("CLOSE", "CLOSE")).toBe(false);
  });

  it("is false for any transition that isn't landing on CLOSE", () => {
    expect(isNewCloseTransition("CLOSE", "HOLD")).toBe(false);
    expect(isNewCloseTransition("HOLD", "WATCH")).toBe(false);
  });
});
