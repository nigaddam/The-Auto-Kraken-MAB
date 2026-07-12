/** Unified 5-tier signal, shared by watchlist coins (no open position) and
 * existing tracked positions (whose tier is derived from their already-computed
 * exit Decision, never recomputed independently — "one Strategy Engine").
 * Pure, no I/O. */

import type { Decision, SignalTier, StrategyRegime, TrendStrength } from "../shared/types";

export interface SignalTierInput {
  regime: StrategyRegime;
  trend: TrendStrength;
  slope7: number | null;
  goldenCrossNewlyConfirmed: boolean;
  goldenCrossEpisodeActive: boolean;
  /** null when this symbol has no ACTIVE tracked position (pure watchlist
   * evaluation) — set from the exit engine's Decision otherwise. */
  exitDecision: Decision | null;
}

export interface SignalTierResult {
  tier: SignalTier;
  reason: string;
}

/** Priority order mirrors exit-strategy.ts's own rule-priority convention:
 * an existing position's exit signal always dominates a symbol's tier
 * (SELL/STRONG_SELL never disagree with the actual exit engine driving
 * execution), buy-side rules only apply once no held-position signal fires. */
export function classifySignalTier(input: SignalTierInput): SignalTierResult {
  if (input.exitDecision === "CLOSE") {
    return { tier: "STRONG_SELL", reason: "Exit engine confirmed CLOSE on the open position." };
  }
  if (input.exitDecision === "WATCH" || input.exitDecision === "BLOCKED") {
    return { tier: "SELL", reason: `Exit engine is ${input.exitDecision}, watching for confirmation.` };
  }
  if (input.regime === "BROKEN") {
    return { tier: "SELL", reason: "BROKEN regime: SMA7<=SMA30 with non-positive SMA30 slope." };
  }
  if (input.goldenCrossNewlyConfirmed) {
    return { tier: "STRONG_BUY", reason: "Golden cross newly confirmed." };
  }
  if (input.regime === "EXPANSION") {
    return input.goldenCrossEpisodeActive
      ? { tier: "STRONG_BUY", reason: "EXPANSION regime with an active golden-cross episode." }
      : { tier: "BUY", reason: "EXPANSION regime: SMA7>SMA30 with positive slopes." };
  }
  if (input.regime === "HEALTHY" && input.trend === "STRONG" && (input.slope7 ?? 0) > 0) {
    return { tier: "BUY", reason: "HEALTHY regime with STRONG trend and positive SMA7 slope." };
  }
  return { tier: "HOLD", reason: "No buy or sell rule active." };
}

const TIER_RANK: Record<SignalTier, number> = {
  STRONG_SELL: -2,
  SELL: -1,
  HOLD: 0,
  BUY: 1,
  STRONG_BUY: 2,
};

/** Edge-trigger for notifications: fires when leaving HOLD into either
 * family, flipping directly from one family to the other (e.g. SELL
 * straight to BUY, skipping HOLD), or escalating further within a family to
 * a more extreme tier. Silent on de-escalation back toward HOLD — same
 * "notify once per direction" spirit as BuySignalState.signalFiredForThisEpisode. */
export function isNewSignalEscalation(previous: SignalTier | null, next: SignalTier): boolean {
  const prevRank = previous ? TIER_RANK[previous] : 0;
  const nextRank = TIER_RANK[next];
  if (nextRank === 0) return false;
  if (prevRank === 0) return true;
  return Math.sign(prevRank) !== Math.sign(nextRank) || Math.abs(nextRank) > Math.abs(prevRank);
}
