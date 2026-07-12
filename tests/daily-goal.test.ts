import { describe, expect, it } from "vitest";
import { computeDailyGoalProgress } from "../src/strategy/daily-goal";

describe("computeDailyGoalProgress", () => {
  it("returns a null goal when account equity is unavailable", () => {
    const result = computeDailyGoalProgress({
      accountEquityUsd: null,
      dailyGoalPct: 0.25,
      realizedPnlTodayUsd: 10,
      unrealizedPnlUsd: 5,
    });
    expect(result.goalUsd).toBeNull();
    expect(result.progressPct).toBeNull();
    expect(result.met).toBe(false);
    expect(result.totalUsd).toBe(15);
  });

  it("computes goalUsd from equity and dailyGoalPct", () => {
    const result = computeDailyGoalProgress({
      accountEquityUsd: 10_000,
      dailyGoalPct: 0.25,
      realizedPnlTodayUsd: 0,
      unrealizedPnlUsd: 0,
    });
    expect(result.goalUsd).toBe(25);
  });

  it("sums realized and unrealized P/L into totalUsd", () => {
    const result = computeDailyGoalProgress({
      accountEquityUsd: 10_000,
      dailyGoalPct: 0.25,
      realizedPnlTodayUsd: 10,
      unrealizedPnlUsd: 5,
    });
    expect(result.totalUsd).toBe(15);
    expect(result.progressPct).toBeCloseTo(60, 5);
    expect(result.met).toBe(false);
  });

  it("treats null unrealized P/L as 0", () => {
    const result = computeDailyGoalProgress({
      accountEquityUsd: 10_000,
      dailyGoalPct: 0.25,
      realizedPnlTodayUsd: 25,
      unrealizedPnlUsd: null,
    });
    expect(result.totalUsd).toBe(25);
    expect(result.met).toBe(true);
  });

  it("marks the goal met once totalUsd reaches goalUsd", () => {
    const result = computeDailyGoalProgress({
      accountEquityUsd: 10_000,
      dailyGoalPct: 0.25,
      realizedPnlTodayUsd: 30,
      unrealizedPnlUsd: 0,
    });
    expect(result.met).toBe(true);
    expect(result.progressPct).toBeCloseTo(120, 5);
  });

  it("is never met when totalUsd is negative", () => {
    const result = computeDailyGoalProgress({
      accountEquityUsd: 10_000,
      dailyGoalPct: 0.25,
      realizedPnlTodayUsd: -50,
      unrealizedPnlUsd: 0,
    });
    expect(result.met).toBe(false);
    expect(result.progressPct).toBeLessThan(0);
  });
});
