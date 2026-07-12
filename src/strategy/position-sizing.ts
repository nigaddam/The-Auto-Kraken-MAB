/** Soft position-size cap: sizes a *new* buy suggestion so a symbol doesn't
 * exceed capFraction of total account equity. Never trims an existing
 * holding that has organically grown past the cap — it only stops
 * suggesting further buys into that symbol (display-only in this pass; see
 * HANDOFF's buy-side-automation follow-up for when this actually places an
 * order). Pure, no I/O. */

export interface PositionSizingInput {
  accountEquityUsd: number | null;
  currentHoldingValueUsd: number;
  currentPrice: number | null;
  capFraction: number;
}

export interface PositionSizingResult {
  suggestedBuyUsd: number | null;
  suggestedBuyUnits: number | null;
  atOrAboveCap: boolean;
  reason: string;
}

export function computeSuggestedNewBuyUsd(input: PositionSizingInput): PositionSizingResult {
  if (input.accountEquityUsd === null || input.accountEquityUsd <= 0) {
    return {
      suggestedBuyUsd: null,
      suggestedBuyUnits: null,
      atOrAboveCap: false,
      reason: "Account equity is unavailable.",
    };
  }

  const capUsd = input.accountEquityUsd * input.capFraction;
  const remainingUsd = capUsd - input.currentHoldingValueUsd;

  if (remainingUsd <= 0) {
    return {
      suggestedBuyUsd: null,
      suggestedBuyUnits: null,
      atOrAboveCap: true,
      reason: `Existing holding ($${input.currentHoldingValueUsd.toFixed(2)}) is already at or above the ${(input.capFraction * 100).toFixed(1)}% cap ($${capUsd.toFixed(2)}).`,
    };
  }

  const suggestedBuyUsd = Math.min(remainingUsd, capUsd);
  return {
    suggestedBuyUsd,
    suggestedBuyUnits: input.currentPrice && input.currentPrice > 0 ? suggestedBuyUsd / input.currentPrice : null,
    atOrAboveCap: false,
    reason: `Up to $${suggestedBuyUsd.toFixed(2)} keeps this symbol within the ${(input.capFraction * 100).toFixed(1)}% cap.`,
  };
}
