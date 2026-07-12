import type { ParsedPositionData, TrackedPosition } from "../shared/types";

/** Stable identity for a continuous position: symbol, side, opening price,
 * and a bucketed value (bucketing absorbs P&L-driven value drift so the
 * fingerprint doesn't change every poll for the same real position). Not
 * including a timestamp — the whole point of a fingerprint is to survive
 * across scans. Opening price is the primary identity signal (kept at full
 * precision); value is secondary (bucketed) — two lots with the same
 * symbol/side/leverage but different opening prices always get different
 * fingerprints, i.e. they are never merged into one tracked lot. */
export function computeFingerprint(p: ParsedPositionData): string {
  const roundedEntry = p.entryPrice.toFixed(6);
  const valueBucket = Math.round(p.valueUsd / 5) * 5;
  const leverage = p.leverage ?? 0;
  return `${p.symbol}:${p.side}:${roundedEntry}:${valueBucket}:${leverage}`;
}

function createTrackedPosition(parsed: ParsedPositionData, fingerprint: string, now: number): TrackedPosition {
  return {
    fingerprint,
    symbol: parsed.symbol,
    side: "LONG",
    openingPrice: parsed.entryPrice,
    openingValueUsd: parsed.valueUsd,
    firstObservedAt: now,
    lastSeenAt: now,
    status: "ACTIVE",

    latest: parsed,
    latestApiPrice: null,
    latestApiPriceAt: null,

    highestObservedPrice: parsed.currentPriceUi,
    peakReturnPct: 0,
    peakPrice: parsed.currentPriceUi,
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
    reason: "Awaiting first strategy evaluation.",

    autoCloseDisabledReason: null,
  };
}

/** Reconciles a fresh DOM scan against previously tracked positions. Only
 * touches identity/lifecycle fields (fingerprint, status, latest, opening
 * price/value); market-derived fields (SMA, peak, decision) are left as-is
 * for existing positions and neutral defaults for new ones — a separate
 * evaluation pass (background/service-worker) fills those in from live
 * market data every poll.
 *
 * A symbol+side can legitimately have more than one ACTIVE lot (e.g. two
 * XPL LONG rows opened at different prices) — that is normal, not merged
 * and not flagged. Rows that parse to the exact same fingerprint within a
 * single scan (i.e. cannot be told apart even by opening price/value) are
 * flagged via autoCloseDisabledReason rather than silently deduplicated. */
export function reconcilePositions(
  parsed: ParsedPositionData[],
  existing: Record<string, TrackedPosition>,
  now: number
): Record<string, TrackedPosition> {
  const next: Record<string, TrackedPosition> = { ...existing };
  const matchedFingerprints = new Set<string>();

  // Track which ACTIVE existing slots (by symbol+side) haven't been matched
  // yet this scan, so we can tell "changed mid-scan" apart from "reappeared
  // after disappearing". A slot can hold multiple lots now, so this is a
  // list, not a single fingerprint.
  const unmatchedActiveBySymbolSide = new Map<string, string[]>();
  for (const [fp, pos] of Object.entries(existing)) {
    if (pos.status === "ACTIVE") {
      const key = `${pos.symbol}:${pos.side}`;
      const list = unmatchedActiveBySymbolSide.get(key) ?? [];
      list.push(fp);
      unmatchedActiveBySymbolSide.set(key, list);
    }
  }

  const fingerprintCountThisScan = new Map<string, number>();
  for (const p of parsed) {
    if (p.side !== "LONG") continue;
    const fp = computeFingerprint(p);
    fingerprintCountThisScan.set(fp, (fingerprintCountThisScan.get(fp) ?? 0) + 1);
  }

  for (const parsedPosition of parsed) {
    if (parsedPosition.side !== "LONG") {
      continue; // this extension only ever tracks LONG positions
    }
    const fingerprint = computeFingerprint(parsedPosition);
    matchedFingerprints.add(fingerprint);

    const ambiguousDuplicate =
      (fingerprintCountThisScan.get(fingerprint) ?? 0) > 1
        ? `${fingerprintCountThisScan.get(fingerprint)} rows this scan parsed to the same identity ` +
          `(symbol/side/opening price/value/leverage) and cannot be told apart. Auto-close is disabled for this lot.`
        : null;

    const existingMatch = existing[fingerprint];
    if (existingMatch && existingMatch.status === "ACTIVE") {
      next[fingerprint] = {
        ...existingMatch,
        latest: parsedPosition,
        lastSeenAt: now,
        autoCloseDisabledReason: ambiguousDuplicate,
      };
      const key = `${parsedPosition.symbol}:${parsedPosition.side}`;
      const remaining = (unmatchedActiveBySymbolSide.get(key) ?? []).filter((fp) => fp !== fingerprint);
      unmatchedActiveBySymbolSide.set(key, remaining);
      continue;
    }

    const slotKey = `${parsedPosition.symbol}:${parsedPosition.side}`;
    const candidates = unmatchedActiveBySymbolSide.get(slotKey) ?? [];
    if (candidates.length === 1) {
      // Exactly one previously-tracked lot for this symbol+side is still
      // unaccounted for this scan, and this row didn't match any existing
      // fingerprint exactly — treat it as that same lot having changed
      // (manual add/reduce), not a disappearance-then-reopen. With 0 or 2+
      // leftover candidates we can't confidently attribute the change to a
      // specific lot, so we fall through and treat it as a new lot instead
      // — safer than guessing which existing lot to overwrite.
      const changedFingerprint = candidates[0]!;
      const changedPosition = next[changedFingerprint];
      if (changedPosition) {
        next[changedFingerprint] = {
          ...changedPosition,
          status: "CHANGED",
          lastSeenAt: now,
          autoCloseDisabledReason:
            "Position size/entry changed manually. Requires acknowledgment before auto-close can resume.",
        };
        matchedFingerprints.add(changedFingerprint);
      }
      unmatchedActiveBySymbolSide.set(slotKey, []);
      next[fingerprint] = {
        ...createTrackedPosition(parsedPosition, fingerprint, now),
        autoCloseDisabledReason: ambiguousDuplicate,
      };
      continue;
    }

    // Genuinely new lot (or reappeared after a prior CLOSED gap).
    next[fingerprint] = {
      ...createTrackedPosition(parsedPosition, fingerprint, now),
      autoCloseDisabledReason: ambiguousDuplicate,
    };
  }

  // Anything ACTIVE that was never matched this scan has disappeared.
  for (const [fp, pos] of Object.entries(existing)) {
    if (pos.status === "ACTIVE" && !matchedFingerprints.has(fp)) {
      next[fp] = {
        ...pos,
        status: "CLOSED",
        decision: "CLOSED",
        reason: "Position no longer detected on the Kraken Prop page.",
      };
    }
  }

  return next;
}
