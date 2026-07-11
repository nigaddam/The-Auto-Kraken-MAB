import { describe, expect, it } from "vitest";
import { computeFingerprint, reconcilePositions } from "../src/strategy/state-machine";
import { freshRuntimeState } from "../src/storage/migrations";
import type { ParsedPositionData, TrackedPosition } from "../src/shared/types";

function parsedJto(overrides: Partial<ParsedPositionData> = {}): ParsedPositionData {
  return {
    symbol: "JTO",
    side: "LONG",
    entryPrice: 0.61828,
    currentPriceUi: 0.6,
    valueUsd: 500,
    upnl: -10,
    netPnl: -11,
    leverage: 3,
    tpSlText: null,
    ...overrides,
  };
}

describe("computeFingerprint", () => {
  it("is stable for the same symbol/side/entry/value/leverage", () => {
    const a = computeFingerprint(parsedJto());
    const b = computeFingerprint(parsedJto({ currentPriceUi: 0.55, upnl: -50 })); // P&L drift shouldn't matter
    expect(a).toBe(b);
  });

  it("changes when entry price or value changes materially", () => {
    const a = computeFingerprint(parsedJto());
    const b = computeFingerprint(parsedJto({ entryPrice: 0.7 }));
    expect(a).not.toBe(b);
  });
});

describe("reconcilePositions: identity and lifecycle", () => {
  it("creates a fresh tracked position with zeroed counters/peak for a brand-new position", () => {
    const result = reconcilePositions([parsedJto()], {}, 1_000);
    const entries = Object.values(result);
    expect(entries).toHaveLength(1);
    const pos = entries[0]!;
    expect(pos.status).toBe("ACTIVE");
    expect(pos.peakReturnPct).toBe(0);
    expect(pos.profitFloorPct).toBeNull();
    expect(pos.consecutiveClosesBelowSmaFast).toBe(0);
    expect(pos.firstObservedAt).toBe(1_000);
  });

  it("never tracks a SHORT position, even if it appears on the page", () => {
    const result = reconcilePositions([parsedJto({ side: "SHORT" })], {}, 1_000);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("preserves peak return, profit floor, and counters across a continuous match", () => {
    const fingerprint = computeFingerprint(parsedJto());
    const existing: Record<string, TrackedPosition> = {
      [fingerprint]: {
        ...baseTrackedPosition(fingerprint),
        peakReturnPct: 8.5,
        profitFloorPct: 5.525,
        consecutiveClosesBelowSmaFast: 1,
      },
    };
    const result = reconcilePositions([parsedJto({ currentPriceUi: 0.62 })], existing, 2_000);
    const pos = result[fingerprint]!;
    expect(pos.peakReturnPct).toBe(8.5);
    expect(pos.profitFloorPct).toBe(5.525);
    expect(pos.consecutiveClosesBelowSmaFast).toBe(1);
    expect(pos.lastSeenAt).toBe(2_000);
    expect(pos.latest?.currentPriceUi).toBe(0.62);
  });

  it("marks a position CLOSED (with decision CLOSED) when it disappears from a scan", () => {
    const fingerprint = computeFingerprint(parsedJto());
    const existing: Record<string, TrackedPosition> = {
      [fingerprint]: baseTrackedPosition(fingerprint),
    };
    const result = reconcilePositions([], existing, 3_000);
    const pos = result[fingerprint]!;
    expect(pos.status).toBe("CLOSED");
    expect(pos.decision).toBe("CLOSED");
  });

  it("treats a position reappearing with a materially different entry/size as new, resetting state", () => {
    const oldFingerprint = computeFingerprint(parsedJto());
    let state: Record<string, TrackedPosition> = {
      [oldFingerprint]: { ...baseTrackedPosition(oldFingerprint), peakReturnPct: 12 },
    };
    // Position disappears (closed) ...
    state = reconcilePositions([], state, 4_000);
    expect(state[oldFingerprint]!.status).toBe("CLOSED");

    // ... then reappears later with a different entry price (a new trade).
    const reopened = parsedJto({ entryPrice: 0.5 });
    const newFingerprint = computeFingerprint(reopened);
    state = reconcilePositions([reopened], state, 5_000);

    expect(newFingerprint).not.toBe(oldFingerprint);
    expect(state[newFingerprint]!.peakReturnPct).toBe(0); // fresh, not inherited from the old one
    expect(state[oldFingerprint]!.status).toBe("CLOSED"); // old one stays closed/retained for history
  });

  it("marks POSITION_CHANGED (not a silent reset) when size/entry changes mid-session without disappearing", () => {
    const oldFingerprint = computeFingerprint(parsedJto());
    const existing: Record<string, TrackedPosition> = {
      [oldFingerprint]: { ...baseTrackedPosition(oldFingerprint), peakReturnPct: 9 },
    };
    // Same scan, same symbol+side, but a manual top-up changed the entry price —
    // the old fingerprint is still "seen" conceptually, just under new terms.
    const changed = parsedJto({ entryPrice: 0.9, valueUsd: 900 });
    const result = reconcilePositions([changed], existing, 6_000);

    expect(result[oldFingerprint]!.status).toBe("CHANGED");
    expect(result[oldFingerprint]!.autoCloseDisabledReason).toBeTruthy();

    const newFingerprint = computeFingerprint(changed);
    expect(result[newFingerprint]!.status).toBe("ACTIVE");
    expect(result[newFingerprint]!.peakReturnPct).toBe(0); // fresh tracking, not inherited
  });
});

describe("freshRuntimeState: browser/extension restart begins disarmed", () => {
  it("starts stopped, monitor-only, and unarmed", () => {
    const state = freshRuntimeState();
    expect(state.monitoringStatus).toBe("STOPPED");
    expect(state.executionMode).toBe("MONITOR_ONLY");
    expect(state.armedUntil).toBeNull();
    expect(state.autoCloseLive).toBe(false);
    expect(state.autoCloseDryRunIntents).toEqual({});
  });
});

function baseTrackedPosition(fingerprint: string): TrackedPosition {
  return {
    fingerprint,
    symbol: "JTO",
    side: "LONG",
    openingPrice: 0.61828,
    openingValueUsd: 500,
    firstObservedAt: 0,
    lastSeenAt: 0,
    status: "ACTIVE",
    latest: parsedJto(),
    latestApiPrice: null,
    latestApiPriceAt: null,
    highestObservedPrice: 0.61828,
    peakReturnPct: 0,
    profitFloorPct: null,
    smaFast: null,
    smaSlow: null,
    trend: "UNKNOWN",
    consecutiveClosesBelowSmaFast: 0,
    lastProcessedCandleTs: null,
    decision: "HOLD",
    reason: "",
    autoCloseDisabledReason: null,
  };
}
