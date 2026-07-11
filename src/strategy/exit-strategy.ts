import { PROFIT_LOCK_TIERS } from "../shared/constants";
import type {
  Candle,
  Decision,
  Settings,
  SMAPoint,
  StrategyDiagnostics,
  StrategyRegime,
  StrategyReasonCode,
  TrackedPosition,
  TrendStrength,
} from "../shared/types";
import { computeATR, computeTripleSmaSeries, normalizedSlope } from "./sma";

export function computeCurrentReturnPct(openingPrice: number, currentPrice: number): number {
  return ((currentPrice - openingPrice) / openingPrice) * 100;
}

/** Peak-return-tier profit floor. Returns null when profit protection isn't
 * active yet (peak hasn't reached the activation threshold). */
export function computeProfitFloor(peakReturnPct: number, activationPct: number): number | null {
  if (peakReturnPct < activationPct) {
    return null;
  }
  const tier = PROFIT_LOCK_TIERS.find(
    (t) => peakReturnPct >= t.minPeakPct && peakReturnPct < t.maxPeakPct
  );
  if (!tier) {
    return null;
  }
  return peakReturnPct * tier.floorFraction;
}

export interface PeakAndFloor {
  peakReturnPct: number;
  profitFloorPct: number | null;
}

/** Peak only ever rises; the floor derived from it only ever rises too — it
 * must never loosen because the price declined afterward. */
export function updatePeakAndFloor(
  prev: PeakAndFloor,
  currentReturnPct: number,
  activationPct: number
): PeakAndFloor {
  const peakReturnPct = Math.max(prev.peakReturnPct, currentReturnPct);
  const computedFloor = computeProfitFloor(peakReturnPct, activationPct);
  let profitFloorPct = prev.profitFloorPct;
  if (computedFloor !== null) {
    profitFloorPct = profitFloorPct === null ? computedFloor : Math.max(profitFloorPct, computedFloor);
  }
  return { peakReturnPct, profitFloorPct };
}

export function determineTrend(smaFast: number | null, smaSlow: number | null): TrendStrength {
  if (smaFast === null || smaSlow === null) {
    return "UNKNOWN";
  }
  return smaFast > smaSlow ? "STRONG" : "WEAK";
}

export interface CandleProgressState {
  consecutiveClosesBelowSmaFast: number;
  lastProcessedCandleTs: number | null;
}

export function seedCandleProgressAtLatestCompleted(
  prev: CandleProgressState,
  smaSeries: SMAPoint[]
): CandleProgressState {
  if (prev.lastProcessedCandleTs !== null) return prev;
  const latest = smaSeries[smaSeries.length - 1] ?? null;
  return {
    consecutiveClosesBelowSmaFast: 0,
    lastProcessedCandleTs: latest?.ts ?? null,
  };
}

/** Advances the "consecutive completed hourly closes below SMA7" counter
 * using only candles newer than lastProcessedCandleTs, in order, so a
 * candle is never counted twice across repeated 5-minute polls within the
 * same hour. Trend reflects the most recent point in the full series. */
export function advanceCandleProgress(
  prev: CandleProgressState,
  smaSeries: SMAPoint[]
): CandleProgressState & { trend: TrendStrength } {
  const newPoints = smaSeries.filter(
    (p) => prev.lastProcessedCandleTs === null || p.ts > prev.lastProcessedCandleTs
  );

  let counter = prev.consecutiveClosesBelowSmaFast;
  let lastProcessedCandleTs = prev.lastProcessedCandleTs;

  for (const point of newPoints) {
    if (point.smaFast !== null) {
      counter = point.close < point.smaFast ? counter + 1 : 0;
    }
    lastProcessedCandleTs = point.ts;
  }

  const latest = smaSeries[smaSeries.length - 1] ?? null;
  const trend = latest ? determineTrend(latest.smaFast, latest.smaSlow) : "UNKNOWN";

  return { consecutiveClosesBelowSmaFast: counter, lastProcessedCandleTs, trend };
}

export interface ExitRuleInput {
  currentReturnPct: number;
  hardLossPercent: number;
  profitFloorPct: number | null;
  trend: TrendStrength;
  consecutiveClosesBelowSmaFast: number;
  strongTrendConfirmationCloses: number;
  weakTrendConfirmationCloses: number;
}

export interface ExitRuleOutput {
  decision: Decision; // HOLD | WATCH | CLOSE only — safety gating happens elsewhere
  reason: string;
}

/** The four exit rules, evaluated strictly in priority order. Never uses a
 * live intrahour price for the SMA rule — only completed-candle state. */
export function evaluateExitRules(input: ExitRuleInput): ExitRuleOutput {
  const pct = input.currentReturnPct.toFixed(2);

  // Rule 1: hard loss.
  if (input.currentReturnPct <= input.hardLossPercent) {
    return {
      decision: "CLOSE",
      reason: `Current return ${pct}% breached the hard-loss threshold (${input.hardLossPercent}%).`,
    };
  }

  // Rule 2: profit protection.
  if (input.profitFloorPct !== null && input.currentReturnPct <= input.profitFloorPct) {
    return {
      decision: "CLOSE",
      reason: `Current return ${pct}% fell to or below the profit floor (${input.profitFloorPct.toFixed(2)}%).`,
    };
  }

  // Rule 3: SMA trend break.
  if (input.trend === "STRONG") {
    if (input.consecutiveClosesBelowSmaFast >= input.strongTrendConfirmationCloses) {
      return {
        decision: "CLOSE",
        reason:
          `Strong trend (SMA7 > SMA30): ${input.consecutiveClosesBelowSmaFast} consecutive completed ` +
          `hourly closes below SMA7 met the configured threshold (${input.strongTrendConfirmationCloses}).`,
      };
    }
    if (input.consecutiveClosesBelowSmaFast === 1) {
      return {
        decision: "WATCH",
        reason:
          `One completed hourly candle closed below SMA7. ` +
          `${input.strongTrendConfirmationCloses} consecutive closes are required for a strong-trend exit.`,
      };
    }
  } else if (input.trend === "WEAK") {
    if (input.consecutiveClosesBelowSmaFast >= input.weakTrendConfirmationCloses) {
      return {
        decision: "CLOSE",
        reason:
          `Weak trend (SMA7 <= SMA30): ${input.consecutiveClosesBelowSmaFast} completed hourly close(s) ` +
          `below SMA7 met the configured threshold (${input.weakTrendConfirmationCloses}).`,
      };
    }
  }

  // Rule 4: otherwise hold.
  if (input.trend === "UNKNOWN") {
    return { decision: "HOLD", reason: "Not enough completed-candle history for SMA7/SMA30 yet." };
  }
  return {
    decision: "HOLD",
    reason:
      input.trend === "STRONG"
        ? "Price is above SMA7 and SMA7 is above SMA30. No exit rule is active."
        : "SMA7 is at or below SMA30, but no completed close below SMA7 yet.",
  };
}

/** If an exit rule would CLOSE but a safety gate blocks execution (stale
 * data, price mismatch, ambiguous row, etc.), downgrade to BLOCKED. HOLD
 * and WATCH are never blocked — there is nothing to execute yet. */
export function applySafetyGating(
  result: ExitRuleOutput,
  blockingReasons: string[]
): ExitRuleOutput {
  if (result.decision === "CLOSE" && blockingReasons.length > 0) {
    return {
      decision: "BLOCKED",
      reason: `Exit condition triggered (${result.reason}) but is blocked: ${blockingReasons.join("; ")}`,
    };
  }
  return result;
}

/** True only on the poll where the decision first becomes CLOSE. Callers
 * use this to notify/log exactly once per exit condition instead of every
 * poll while it remains true — the same guarantee a persisted "signal" has
 * already executed serves in the Python prototype, expressed here as an
 * edge-trigger over continuously-recomputed decisions instead. */
export function isNewCloseTransition(previousDecision: Decision, newDecision: Decision): boolean {
  return newDecision === "CLOSE" && previousDecision !== "CLOSE";
}

export interface VolatilityStrategyInput {
  position: TrackedPosition;
  candles: Candle[];
  apiPrice: number;
  settings: Settings;
  now: number;
  blockingReasons: string[];
}

export interface VolatilityStrategyResult {
  decision: Decision;
  reasonCode: StrategyReasonCode;
  reason: string;
  peakReturnPct: number;
  peakPrice: number;
  profitFloorPct: number | null;
  consecutiveClosesBelowSma7: number;
  lastProcessedCandleTs: number | null;
  hardLossObservedSince: number | null;
  hardLossObservationCount: number;
  diagnostics: StrategyDiagnostics;
}

function clampNegative(value: number, mostNegative: number, leastNegative: number): number {
  return Math.max(mostNegative, Math.min(leastNegative, value));
}

export function computeEffectiveHardLossPct(
  entryPrice: number,
  atr14: number | null,
  settings: Settings
): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || atr14 === null || !Number.isFinite(atr14) || atr14 <= 0) {
    return settings.hardLossFallbackPct;
  }
  const atrStopPct = -((settings.hardLossAtrMultiple * atr14) / entryPrice) * 100;
  return clampNegative(atrStopPct, settings.hardLossMaxDistancePct, settings.hardLossMinDistancePct);
}

export function computeDynamicProfitFloorPct(
  peakReturnPct: number,
  previousFloorPct: number | null
): number | null {
  let next: number | null = null;
  if (peakReturnPct >= 3 && peakReturnPct < 7) next = Math.max(0.5, peakReturnPct * 0.35);
  if (peakReturnPct >= 7 && peakReturnPct < 15) next = Math.max(3, peakReturnPct * 0.5);
  if (peakReturnPct >= 15 && peakReturnPct < 30) next = Math.max(7, peakReturnPct * 0.6);
  if (peakReturnPct >= 30) next = Math.max(15, peakReturnPct * 0.7);
  if (next === null) return previousFloorPct;
  return previousFloorPct === null ? next : Math.max(previousFloorPct, next);
}

export function classifyRegime(input: {
  sma7: number;
  sma30: number;
  slope7: number;
  slope30: number;
  latestClose: number;
  closesBelowSma7: number;
  settings: Settings;
}): StrategyRegime {
  if (input.sma7 <= input.sma30 && input.slope30 <= 0) return "BROKEN";
  const expansion =
    input.sma7 > input.sma30 &&
    input.slope7 >= input.settings.slope7Positive &&
    input.slope30 > 0 &&
    input.latestClose >= input.sma7;
  if (expansion) return "EXPANSION";
  const deteriorating =
    (input.sma7 > input.sma30 && input.slope7 < input.settings.slope7Negative) ||
    (input.sma7 > input.sma30 && input.closesBelowSma7 > 0) ||
    (input.slope30 < input.settings.slope30FlatLowerBound);
  if (deteriorating) return "DETERIORATING";
  return "HEALTHY";
}

function returnPct(entryPrice: number, price: number): number {
  return ((price - entryPrice) / entryPrice) * 100;
}

function countLatestClosesBelowSma7(series: { close: number; sma7: number | null; ts: number }[]): number {
  let count = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    const point = series[i]!;
    if (point.sma7 === null || point.close >= point.sma7) break;
    count += 1;
  }
  return count;
}

function buildDiagnostics(
  input: VolatilityStrategyInput,
  data: {
    decision: Decision;
    reasonCode: StrategyReasonCode;
    reason: string;
    currentReturnPct: number | null;
    peakReturnPct: number;
    peakPrice: number;
    profitProtectionActive: boolean;
    profitFloorPct: number | null;
    effectiveHardLossPct: number | null;
    sma7: number | null;
    sma30: number | null;
    sma90: number | null;
    atr14: number | null;
    atrPct: number | null;
    slope7: number | null;
    slope30: number | null;
    slope90: number | null;
    regime: StrategyRegime;
    completedClosesBelowSma7: number;
    majorTrendBreakLevel: number | null;
    candleTimestamp: number | null;
    nextCloseCondition: string;
  }
): StrategyDiagnostics {
  return {
    ...data,
    btcStressActive: false,
    dataTimestamp: input.now,
    positionFingerprint: input.position.fingerprint,
    executionEligible: data.decision === "CLOSE" && input.blockingReasons.length === 0,
    failedSafetyGates: input.blockingReasons,
  };
}

export function evaluateVolatilityAdjustedStrategy(input: VolatilityStrategyInput): VolatilityStrategyResult {
  const { position, candles, apiPrice, settings, now } = input;
  const requiredCandles = Math.max(
    settings.longSma + settings.slope90LookbackHours,
    settings.slowSma + settings.slope30LookbackHours,
    settings.fastSma + settings.slope7LookbackHours,
    settings.atrPeriod + 1
  );
  const previousPeakPrice = position.peakPrice || position.highestObservedPrice || position.openingPrice;
  const currentReturnPct = Number.isFinite(apiPrice) && apiPrice > 0 ? returnPct(position.openingPrice, apiPrice) : null;

  if (candles.length < requiredCandles) {
    const reason = `Strategy data invalid: insufficient completed 1h candles for SMA90/ATR/slope history (got ${candles.length}, need ${requiredCandles}).`;
    const diagnostics = buildDiagnostics(input, {
      decision: "ERROR",
      reasonCode: "STRATEGY_DATA_INVALID",
      reason,
      currentReturnPct,
      peakReturnPct: position.peakReturnPct,
      peakPrice: previousPeakPrice,
      profitProtectionActive: position.profitFloorPct !== null,
      profitFloorPct: position.profitFloorPct,
      effectiveHardLossPct: settings.hardLossFallbackPct,
      sma7: null,
      sma30: null,
      sma90: null,
      atr14: null,
      atrPct: null,
      slope7: null,
      slope30: null,
      slope90: null,
      regime: "UNKNOWN",
      completedClosesBelowSma7: position.consecutiveClosesBelowSmaFast,
      majorTrendBreakLevel: null,
      candleTimestamp: candles[candles.length - 1]?.ts ?? null,
      nextCloseCondition: "Need sufficient valid completed hourly history before execution.",
    });
    return {
      decision: "ERROR",
      reasonCode: "STRATEGY_DATA_INVALID",
      reason,
      peakReturnPct: position.peakReturnPct,
      peakPrice: previousPeakPrice,
      profitFloorPct: position.profitFloorPct,
      consecutiveClosesBelowSma7: position.consecutiveClosesBelowSmaFast,
      lastProcessedCandleTs: position.lastProcessedCandleTs,
      hardLossObservedSince: null,
      hardLossObservationCount: 0,
      diagnostics,
    };
  }

  const maSeries = computeTripleSmaSeries(candles, settings.fastSma, settings.slowSma, settings.longSma);
  const atrSeries = computeATR(candles, settings.atrPeriod);
  const latestIndex = candles.length - 1;
  const latest = candles[latestIndex]!;
  const latestMa = maSeries[latestIndex]!;
  const atr14 = atrSeries[latestIndex] ?? null;
  const atrPct = atr14 !== null ? atr14 / latest.close : null;
  const sma7Values = maSeries.map((p) => p.sma7);
  const sma30Values = maSeries.map((p) => p.sma30);
  const sma90Values = maSeries.map((p) => p.sma90);
  const slope7 = normalizedSlope(sma7Values, latestIndex, settings.slope7LookbackHours, atr14);
  const slope30 = normalizedSlope(sma30Values, latestIndex, settings.slope30LookbackHours, atr14);
  const slope90 = normalizedSlope(sma90Values, latestIndex, settings.slope90LookbackHours, atr14);
  const dataInvalid =
    latestMa.sma7 === null ||
    latestMa.sma30 === null ||
    latestMa.sma90 === null ||
    atr14 === null ||
    atr14 <= 0 ||
    slope7 === null ||
    slope30 === null ||
    slope90 === null;

  if (dataInvalid) {
    const reason = "Strategy data invalid: SMA90, ATR14, or normalized slope is unavailable.";
    const diagnostics = buildDiagnostics(input, {
      decision: "ERROR",
      reasonCode: "STRATEGY_DATA_INVALID",
      reason,
      currentReturnPct,
      peakReturnPct: position.peakReturnPct,
      peakPrice: previousPeakPrice,
      profitProtectionActive: position.profitFloorPct !== null,
      profitFloorPct: position.profitFloorPct,
      effectiveHardLossPct: settings.hardLossFallbackPct,
      sma7: latestMa.sma7,
      sma30: latestMa.sma30,
      sma90: latestMa.sma90,
      atr14,
      atrPct,
      slope7,
      slope30,
      slope90,
      regime: "UNKNOWN",
      completedClosesBelowSma7: 0,
      majorTrendBreakLevel: null,
      candleTimestamp: latest.ts,
      nextCloseCondition: "Need valid SMA90/ATR/slope inputs before execution.",
    });
    return {
      decision: "ERROR",
      reasonCode: "STRATEGY_DATA_INVALID",
      reason,
      peakReturnPct: position.peakReturnPct,
      peakPrice: previousPeakPrice,
      profitFloorPct: position.profitFloorPct,
      consecutiveClosesBelowSma7: 0,
      lastProcessedCandleTs: latest.ts,
      hardLossObservedSince: null,
      hardLossObservationCount: 0,
      diagnostics,
    };
  }

  // The current parser does not expose a reliable entry timestamp, so using
  // all fetched historical candle highs would leak pre-entry highs into a
  // new lot. Until entry time exists, peak reconstruction is limited to the
  // persisted tracked peak plus the latest validated live API price.
  const peakPrice = Math.max(previousPeakPrice, apiPrice);
  const peakReturnPct = Math.max(position.peakReturnPct, returnPct(position.openingPrice, peakPrice));
  const profitProtectionActive =
    peakReturnPct >= settings.profitActivationPct ||
    (atr14 > 0 && peakPrice - position.openingPrice >= settings.profitActivationAtrMultiple * atr14);
  const computedFloor = profitProtectionActive
    ? computeDynamicProfitFloorPct(peakReturnPct, position.profitFloorPct)
    : position.profitFloorPct;
  const profitFloorPct = computedFloor;
  const completedClosesBelowSma7 = countLatestClosesBelowSma7(maSeries);
  const regime = classifyRegime({
    sma7: latestMa.sma7!,
    sma30: latestMa.sma30!,
    slope7,
    slope30,
    latestClose: latest.close,
    closesBelowSma7: completedClosesBelowSma7,
    settings,
  });
  const effectiveHardLossPct = computeEffectiveHardLossPct(position.openingPrice, atr14, settings);
  const majorTrendBreakLevel = latestMa.sma30! - settings.majorTrendBreakAtrBuffer * atr14;

  let hardLossObservedSince = position.hardLossObservedSince ?? null;
  let hardLossObservationCount = position.hardLossObservationCount ?? 0;
  if (currentReturnPct !== null && currentReturnPct <= effectiveHardLossPct) {
    hardLossObservedSince = hardLossObservedSince ?? now;
    hardLossObservationCount += 1;
  } else {
    hardLossObservedSince = null;
    hardLossObservationCount = 0;
  }
  const hardLossConfirmed =
    hardLossObservedSince !== null &&
    hardLossObservationCount >= settings.hardLossRequiredObservations &&
    now - hardLossObservedSince >= settings.hardLossConfirmationSeconds * 1000;

  let decision: Decision = "HOLD";
  let reasonCode: StrategyReasonCode = "NO_EXIT_RULE";
  let reason = "No exit rule active.";
  let nextCloseCondition = "Hard loss, major trend break, profit-floor confirmation, or regime trend break.";

  if (currentReturnPct !== null && currentReturnPct <= effectiveHardLossPct && hardLossConfirmed) {
    decision = "CLOSE";
    reasonCode = "HARD_LOSS";
    reason = `HARD_LOSS: current return ${currentReturnPct.toFixed(2)}% confirmed below effective hard stop ${effectiveHardLossPct.toFixed(2)}%.`;
  } else if (currentReturnPct !== null && currentReturnPct <= effectiveHardLossPct) {
    decision = "WATCH";
    reasonCode = "WATCHING_CONFIRMATION";
    reason = `Hard-loss threshold touched (${currentReturnPct.toFixed(2)}% <= ${effectiveHardLossPct.toFixed(2)}%); waiting for debounce confirmation.`;
    nextCloseCondition = "Another valid hard-loss observation after debounce duration.";
  } else if (latest.close < majorTrendBreakLevel) {
    decision = "CLOSE";
    reasonCode = "MAJOR_TREND_BREAK";
    reason = `MAJOR_TREND_BREAK: completed close ${latest.close.toFixed(6)} below SMA30 minus ${settings.majorTrendBreakAtrBuffer.toFixed(2)} ATR (${majorTrendBreakLevel.toFixed(6)}).`;
  } else if (profitProtectionActive && profitFloorPct !== null && currentReturnPct !== null && currentReturnPct <= profitFloorPct) {
    const floorBufferReturnPct = (settings.expansionFloorAtrBuffer * atr14 / position.openingPrice) * 100;
    const floorBreachedWithBuffer = currentReturnPct <= profitFloorPct - floorBufferReturnPct;
    const sma7Confirmed = completedClosesBelowSma7 >= 2;
    if (regime === "EXPANSION") {
      if (floorBreachedWithBuffer || sma7Confirmed) {
        decision = "CLOSE";
        reasonCode = "PROFIT_LOCK_CONFIRMED";
        reason = "PROFIT_LOCK_CONFIRMED: expansion winner breached profit floor with ATR/SMA confirmation.";
      } else {
        decision = "WATCH";
        reasonCode = "WATCHING_CONFIRMATION";
        reason = "Profit floor touched, but EXPANSION trend remains intact.";
        nextCloseCondition = "Floor breach by ATR buffer or confirmed SMA7 break.";
      }
    } else if (regime === "HEALTHY") {
      if (sma7Confirmed) {
        decision = "CLOSE";
        reasonCode = "PROFIT_LOCK_CONFIRMED";
        reason = "PROFIT_LOCK_CONFIRMED: HEALTHY winner breached floor with SMA7 confirmation.";
      } else {
        decision = "WATCH";
        reasonCode = "WATCHING_CONFIRMATION";
        reason = "Profit floor touched in HEALTHY regime; waiting for SMA7 confirmation.";
        nextCloseCondition = "Second completed close below SMA7.";
      }
    } else {
      decision = "CLOSE";
      reasonCode = "PROFIT_LOCK_AND_WEAK_TREND";
      reason = "PROFIT_LOCK_AND_WEAK_TREND: profit floor breached while regime is weak.";
    }
  } else if (regime === "EXPANSION") {
    const fastBreak = latest.close < latestMa.sma7! - settings.expansionFastBreakAtrBuffer * atr14 && slope7 < settings.slope7Negative;
    if (fastBreak) {
      decision = "CLOSE";
      reasonCode = "EXPANSION_FAST_BREAK";
      reason = "EXPANSION_FAST_BREAK: completed close broke below SMA7 by ATR buffer with negative SMA7 slope.";
    } else if (completedClosesBelowSma7 >= 2 && slope7 <= 0) {
      decision = "CLOSE";
      reasonCode = "EXPANSION_TREND_BREAK";
      reason = "EXPANSION_TREND_BREAK: two completed closes below SMA7 and SMA7 slope is non-positive.";
    } else if (completedClosesBelowSma7 >= 1) {
      decision = "WATCH";
      reasonCode = "WATCHING_CONFIRMATION";
      reason = "First completed close below SMA7 in EXPANSION.";
      nextCloseCondition = "Second close below SMA7 with non-positive SMA7 slope.";
    } else {
      decision = profitProtectionActive ? "PROTECT" : "HOLD";
      reasonCode = profitProtectionActive ? "PROFIT_PROTECTION_ACTIVE" : "NO_EXIT_RULE";
      reason = profitProtectionActive
        ? "Profit protection active; expansion trend intact."
        : "Expansion trend intact.";
    }
  } else if (regime === "HEALTHY") {
    if (completedClosesBelowSma7 >= 2) {
      decision = "CLOSE";
      reasonCode = "HEALTHY_TREND_BREAK";
      reason = "HEALTHY_TREND_BREAK: two completed closes below SMA7.";
    } else if (completedClosesBelowSma7 === 1) {
      decision = "WATCH";
      reasonCode = "WATCHING_CONFIRMATION";
      reason = "First completed close below SMA7 in HEALTHY regime.";
      nextCloseCondition = "Second completed close below SMA7.";
    } else {
      decision = profitProtectionActive ? "PROTECT" : "HOLD";
      reasonCode = profitProtectionActive ? "PROFIT_PROTECTION_ACTIVE" : "NO_EXIT_RULE";
      reason = profitProtectionActive ? "Profit protection active; healthy trend intact." : "Healthy trend intact.";
    }
  } else if (regime === "DETERIORATING") {
    const previous = candles[candles.length - 2]!;
    const belowSma7 = latest.close < latestMa.sma7!;
    const downsideConfirmed =
      latest.close < previous.low ||
      completedClosesBelowSma7 >= 2 ||
      latest.close < latestMa.sma7! - settings.deteriorationAtrBreakBuffer * atr14;
    if (belowSma7 && downsideConfirmed) {
      decision = "CLOSE";
      reasonCode = "DETERIORATING_TREND";
      reason = "DETERIORATING_TREND: close below SMA7 with downside confirmation.";
    } else if (belowSma7) {
      decision = "WATCH";
      reasonCode = "WATCHING_CONFIRMATION";
      reason = "Deteriorating regime with close below SMA7; waiting for downside confirmation.";
      nextCloseCondition = "Prior-low break, second close below SMA7, or ATR-buffer break below SMA7.";
    } else {
      decision = "HOLD";
      reasonCode = "NO_EXIT_RULE";
      reason = "Deteriorating regime, but price has not closed below SMA7.";
    }
  } else {
    if (latest.close < latestMa.sma7!) {
      decision = "CLOSE";
      reasonCode = "BROKEN_TREND";
      reason = "BROKEN_TREND: BROKEN regime and completed close below SMA7.";
    } else {
      decision = "WATCH";
      reasonCode = "WATCHING_CONFIRMATION";
      reason = "BROKEN regime; watching for completed close below SMA7.";
      nextCloseCondition = "Completed close below SMA7.";
    }
  }

  const gated = applySafetyGating({ decision, reason }, input.blockingReasons);
  const finalDecision = gated.decision;
  const finalReason =
    finalDecision === "BLOCKED"
      ? `Strategy decision: ${decision} - ${reasonCode}. Execution: BLOCKED - ${input.blockingReasons.join("; ")}`
      : gated.reason;

  const diagnostics = buildDiagnostics(input, {
    decision: finalDecision,
    reasonCode,
    reason: finalReason,
    currentReturnPct,
    peakReturnPct,
    peakPrice,
    profitProtectionActive,
    profitFloorPct,
    effectiveHardLossPct,
    sma7: latestMa.sma7,
    sma30: latestMa.sma30,
    sma90: latestMa.sma90,
    atr14,
    atrPct,
    slope7,
    slope30,
    slope90,
    regime,
    completedClosesBelowSma7,
    majorTrendBreakLevel,
    candleTimestamp: latest.ts,
    nextCloseCondition,
  });

  return {
    decision: finalDecision,
    reasonCode,
    reason: finalReason,
    peakReturnPct,
    peakPrice,
    profitFloorPct,
    consecutiveClosesBelowSma7: completedClosesBelowSma7,
    lastProcessedCandleTs: latest.ts,
    hardLossObservedSince,
    hardLossObservationCount,
    diagnostics,
  };
}
