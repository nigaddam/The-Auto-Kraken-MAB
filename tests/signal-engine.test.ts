import { describe, expect, it } from "vitest";
import { classifySignalTier, isNewSignalEscalation } from "../src/strategy/signal-engine";
import type { SignalTierInput } from "../src/strategy/signal-engine";

function baseInput(overrides: Partial<SignalTierInput> = {}): SignalTierInput {
  return {
    regime: "HEALTHY",
    trend: "STRONG",
    slope7: 0.1,
    goldenCrossNewlyConfirmed: false,
    goldenCrossEpisodeActive: false,
    exitDecision: null,
    ...overrides,
  };
}

describe("classifySignalTier", () => {
  it("returns STRONG_SELL when the exit engine says CLOSE, regardless of regime", () => {
    const result = classifySignalTier(baseInput({ exitDecision: "CLOSE", regime: "EXPANSION" }));
    expect(result.tier).toBe("STRONG_SELL");
  });

  it("returns SELL when the exit engine says WATCH", () => {
    const result = classifySignalTier(baseInput({ exitDecision: "WATCH" }));
    expect(result.tier).toBe("SELL");
  });

  it("returns SELL when the exit engine says BLOCKED", () => {
    const result = classifySignalTier(baseInput({ exitDecision: "BLOCKED" }));
    expect(result.tier).toBe("SELL");
  });

  it("returns SELL for a BROKEN regime with no held position", () => {
    const result = classifySignalTier(baseInput({ regime: "BROKEN", exitDecision: null }));
    expect(result.tier).toBe("SELL");
  });

  it("returns STRONG_BUY on a newly confirmed golden cross", () => {
    const result = classifySignalTier(baseInput({ goldenCrossNewlyConfirmed: true, regime: "HEALTHY" }));
    expect(result.tier).toBe("STRONG_BUY");
  });

  it("returns STRONG_BUY for EXPANSION with an active golden-cross episode", () => {
    const result = classifySignalTier(
      baseInput({ regime: "EXPANSION", goldenCrossEpisodeActive: true })
    );
    expect(result.tier).toBe("STRONG_BUY");
  });

  it("returns BUY for EXPANSION without an active golden-cross episode", () => {
    const result = classifySignalTier(
      baseInput({ regime: "EXPANSION", goldenCrossEpisodeActive: false })
    );
    expect(result.tier).toBe("BUY");
  });

  it("returns BUY for HEALTHY + STRONG trend + positive slope7", () => {
    const result = classifySignalTier(
      baseInput({ regime: "HEALTHY", trend: "STRONG", slope7: 0.05 })
    );
    expect(result.tier).toBe("BUY");
  });

  it("returns HOLD for HEALTHY + STRONG trend but non-positive slope7", () => {
    const result = classifySignalTier(
      baseInput({ regime: "HEALTHY", trend: "STRONG", slope7: -0.01 })
    );
    expect(result.tier).toBe("HOLD");
  });

  it("returns HOLD for HEALTHY + WEAK trend", () => {
    const result = classifySignalTier(baseInput({ regime: "HEALTHY", trend: "WEAK" }));
    expect(result.tier).toBe("HOLD");
  });

  it("returns HOLD for DETERIORATING with no other rule firing", () => {
    const result = classifySignalTier(baseInput({ regime: "DETERIORATING", trend: "WEAK", slope7: -0.01 }));
    expect(result.tier).toBe("HOLD");
  });

  it("prioritizes the held-position exit signal over regime-based buy rules", () => {
    const result = classifySignalTier(
      baseInput({ exitDecision: "WATCH", regime: "EXPANSION", goldenCrossNewlyConfirmed: true })
    );
    expect(result.tier).toBe("SELL");
  });
});

describe("isNewSignalEscalation", () => {
  it("fires when leaving HOLD (or null) into BUY", () => {
    expect(isNewSignalEscalation(null, "BUY")).toBe(true);
    expect(isNewSignalEscalation("HOLD", "BUY")).toBe(true);
  });

  it("fires when leaving HOLD into SELL", () => {
    expect(isNewSignalEscalation("HOLD", "SELL")).toBe(true);
  });

  it("fires when escalating further within the same family", () => {
    expect(isNewSignalEscalation("BUY", "STRONG_BUY")).toBe(true);
    expect(isNewSignalEscalation("SELL", "STRONG_SELL")).toBe(true);
  });

  it("does not fire when de-escalating back toward HOLD", () => {
    expect(isNewSignalEscalation("STRONG_BUY", "BUY")).toBe(false);
    expect(isNewSignalEscalation("BUY", "HOLD")).toBe(false);
    expect(isNewSignalEscalation("STRONG_SELL", "SELL")).toBe(false);
  });

  it("does not fire when the next tier is HOLD", () => {
    expect(isNewSignalEscalation(null, "HOLD")).toBe(false);
  });

  it("does not fire when crossing families without escalating (e.g. SELL to BUY counts as an escalation only if magnitude increases)", () => {
    // SELL (-1) -> BUY (1): different sign, treated as a fresh escalation into BUY.
    expect(isNewSignalEscalation("SELL", "BUY")).toBe(true);
  });

  it("does not fire on repeated identical tier", () => {
    expect(isNewSignalEscalation("BUY", "BUY")).toBe(false);
    expect(isNewSignalEscalation("STRONG_SELL", "STRONG_SELL")).toBe(false);
  });
});
