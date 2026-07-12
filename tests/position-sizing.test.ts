import { describe, expect, it } from "vitest";
import { computeSuggestedNewBuyUsd } from "../src/strategy/position-sizing";

describe("computeSuggestedNewBuyUsd", () => {
  it("returns null when account equity is unavailable", () => {
    const result = computeSuggestedNewBuyUsd({
      accountEquityUsd: null,
      currentHoldingValueUsd: 0,
      currentPrice: 100,
      capFraction: 0.05,
    });
    expect(result.suggestedBuyUsd).toBeNull();
    expect(result.atOrAboveCap).toBe(false);
  });

  it("returns null when account equity is zero or negative", () => {
    const result = computeSuggestedNewBuyUsd({
      accountEquityUsd: 0,
      currentHoldingValueUsd: 0,
      currentPrice: 100,
      capFraction: 0.05,
    });
    expect(result.suggestedBuyUsd).toBeNull();
  });

  it("suggests up to the full cap when there is no existing holding", () => {
    const result = computeSuggestedNewBuyUsd({
      accountEquityUsd: 10_000,
      currentHoldingValueUsd: 0,
      currentPrice: 50,
      capFraction: 0.05,
    });
    expect(result.suggestedBuyUsd).toBe(500);
    expect(result.suggestedBuyUnits).toBe(10);
    expect(result.atOrAboveCap).toBe(false);
  });

  it("suggests only the remaining room when partially allocated", () => {
    const result = computeSuggestedNewBuyUsd({
      accountEquityUsd: 10_000,
      currentHoldingValueUsd: 300,
      currentPrice: 100,
      capFraction: 0.05,
    });
    expect(result.suggestedBuyUsd).toBe(200);
    expect(result.suggestedBuyUnits).toBe(2);
  });

  it("suggests nothing once the holding is already at the cap", () => {
    const result = computeSuggestedNewBuyUsd({
      accountEquityUsd: 10_000,
      currentHoldingValueUsd: 500,
      currentPrice: 100,
      capFraction: 0.05,
    });
    expect(result.suggestedBuyUsd).toBeNull();
    expect(result.atOrAboveCap).toBe(true);
  });

  it("never suggests a trim when a holding has organically grown past the cap", () => {
    const result = computeSuggestedNewBuyUsd({
      accountEquityUsd: 10_000,
      currentHoldingValueUsd: 900,
      currentPrice: 100,
      capFraction: 0.05,
    });
    expect(result.suggestedBuyUsd).toBeNull();
    expect(result.atOrAboveCap).toBe(true);
    // No field in the result represents a "sell down to cap" instruction.
    expect(Object.keys(result)).not.toContain("suggestedTrimUsd");
  });

  it("returns null units when current price is unavailable", () => {
    const result = computeSuggestedNewBuyUsd({
      accountEquityUsd: 10_000,
      currentHoldingValueUsd: 0,
      currentPrice: null,
      capFraction: 0.05,
    });
    expect(result.suggestedBuyUsd).toBe(500);
    expect(result.suggestedBuyUnits).toBeNull();
  });
});
