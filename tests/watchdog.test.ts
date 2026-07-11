import { describe, expect, it } from "vitest";
import { checkStall, computeStallThresholdMs } from "../src/background/watchdog";

describe("computeStallThresholdMs", () => {
  it("uses 3x the poll interval when that exceeds 15 minutes", () => {
    expect(computeStallThresholdMs(10)).toBe(30 * 60_000); // 3*10=30 > 15
  });

  it("floors at 15 minutes for short poll intervals", () => {
    expect(computeStallThresholdMs(1)).toBe(15 * 60_000); // 3*1=3 < 15
    expect(computeStallThresholdMs(5)).toBe(15 * 60_000); // 3*5=15
  });
});

describe("checkStall", () => {
  const pollMinutes = 5; // threshold = max(15, 15) = 15 minutes

  it("is not stalled immediately after a successful scan", () => {
    const now = 1_000_000;
    const result = checkStall({
      lastSuccessfulScanAt: now - 60_000, // 1 minute ago
      fallbackReferenceAt: null,
      pollMinutes,
      now,
    });
    expect(result.stalled).toBe(false);
  });

  it("is not stalled right at the threshold boundary", () => {
    const now = 1_000_000;
    const result = checkStall({
      lastSuccessfulScanAt: now - 15 * 60_000,
      fallbackReferenceAt: null,
      pollMinutes,
      now,
    });
    expect(result.stalled).toBe(false); // exactly at threshold, not over
  });

  it("is stalled once past max(3x poll, 15 minutes)", () => {
    const now = 1_000_000;
    const result = checkStall({
      lastSuccessfulScanAt: now - 16 * 60_000,
      fallbackReferenceAt: null,
      pollMinutes,
      now,
    });
    expect(result.stalled).toBe(true);
    expect(result.stalledForMs).toBe(16 * 60_000);
  });

  it("falls back to monitoringStartedAt when no scan has ever succeeded", () => {
    const now = 1_000_000;
    const result = checkStall({
      lastSuccessfulScanAt: null,
      fallbackReferenceAt: now - 20 * 60_000,
      pollMinutes,
      now,
    });
    expect(result.stalled).toBe(true);
  });

  it("does not false-positive when there is no reference point at all (first tick)", () => {
    const now = 1_000_000;
    const result = checkStall({
      lastSuccessfulScanAt: null,
      fallbackReferenceAt: null,
      pollMinutes,
      now,
    });
    expect(result.stalled).toBe(false);
    expect(result.stalledForMs).toBe(0);
  });

  it("respects a longer poll interval's proportionally longer threshold", () => {
    const now = 1_000_000;
    // pollMinutes=10 -> threshold 30 minutes
    const notYet = checkStall({
      lastSuccessfulScanAt: now - 25 * 60_000,
      fallbackReferenceAt: null,
      pollMinutes: 10,
      now,
    });
    expect(notYet.stalled).toBe(false);

    const stalled = checkStall({
      lastSuccessfulScanAt: now - 31 * 60_000,
      fallbackReferenceAt: null,
      pollMinutes: 10,
      now,
    });
    expect(stalled.stalled).toBe(true);
  });
});
