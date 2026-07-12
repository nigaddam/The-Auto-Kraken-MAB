/** THE guarded buy-execution surface — mirrors close-preview.ts's exact
 * resolve -> open/validate -> confirm pattern, built only after real DOM
 * evidence was gathered from a live, logged-in Kraken Trade page (Buy tab,
 * quantity input, submit control, and post-submit confirmation modal all
 * confirmed via Order-Form Diagnostics runs on 2026-07-12 — see
 * order-form-diagnostics.ts and HANDOFF.md's buy-side addendum). Never
 * clicks the modal's "Don't show this confirmation again" checkbox — that
 * checkbox is the one thing standing between this flow and an
 * unconfirmable single-click order, so it must never be touched by
 * automation and the account it runs against must never have it checked. */

import type { BuyModalValidation, BuyOrderReport } from "../shared/types";
import { dismissOpenModal, sleep } from "./close-preview";
import {
  findOrderEntryPanel,
  findQuantityInput,
  findSubmitControlCandidates,
  findTabCandidates,
  tabSelectedState,
} from "./order-form-diagnostics";
import { textOf } from "./kraken-dom";

const MODAL_WAIT_MS = 5_000;
const MODAL_POLL_MS = 150;
const AFTER_CLICK_SETTLE_MS = 200;

/** Sets a value on a React-controlled <input> the way a real user typing
 * would — assigning `.value` directly does not notify React's internal
 * change tracking, so a stale value could silently remain in the app's
 * state while the DOM shows the new one. Uses the native property setter
 * (bypassing any overridden setter React installs on the instance) then
 * dispatches real input/change events, the standard workaround for this. */
function setReactControlledValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
  if (descriptor?.set) {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Avoids scientific notation for very small quantities and trims
 * trailing-zero noise, without ever rounding up (always at most the
 * intended precision). */
function formatQuantity(units: number): string {
  return units
    .toFixed(8)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

function findModalCandidates(root: ParentNode): Element[] {
  return Array.from(
    root.querySelectorAll<Element>(
      '[role="dialog"], [aria-modal="true"], [data-testid*="modal" i], [data-testid*="dialog" i]'
    )
  ).filter((el) => textOf(el).length > 0);
}

/** Real Kraken evidence shows quantity and symbol are sometimes concatenated
 * with no whitespace between them (e.g. "0.001BTC", same pattern already
 * seen in Order-Form Diagnostics' "QuantityJTO") — a plain `\bSYMBOL\b`
 * regex never matches there, since `\b` doesn't fire between two word
 * characters (a digit and a letter both count as word characters). This
 * only excludes a letter immediately adjacent (so "0.001BTC" matches, but
 * "SOMEBTCTOKEN" does not), which is the actual ambiguity this needs to
 * avoid, not digit-adjacency. */
function symbolBoundaryPattern(symbolUpper: string): string {
  return `(?<![A-Za-z])${symbolUpper}(?![A-Za-z])`;
}

function findConfirmControls(modal: Element): HTMLElement[] {
  return Array.from(modal.querySelectorAll<HTMLElement>('button, [role="button"]')).filter((el) => {
    const label = el.getAttribute("aria-label") ?? el.getAttribute("title") ?? textOf(el);
    return /^confirm$/i.test(label.trim());
  });
}

/** Real Kraken evidence: the post-submit confirmation modal reads
 * "Market long 0.001 BTC ... Cancel | Confirm" — no symbol-specific final
 * button text (unlike the close modal's "Close AAVE long position"), so
 * finalButtonMatched relies on exact "Confirm" text scoped to the one
 * modal already confirmed to reference our symbol/quantity. */
export function validateBuyModal(root: ParentNode, symbol: string, expectedQuantity: number): BuyModalValidation {
  const symbolUpper = symbol.toUpperCase();
  const candidates = findModalCandidates(root);
  const symbolPattern = symbolBoundaryPattern(symbolUpper);
  const matching = candidates.filter((modal) => new RegExp(symbolPattern, "i").test(textOf(modal)));

  const base = {
    modalFound: matching.length > 0,
    symbolMatched: matching.length === 1,
    actionMatched: false,
    quantityMatched: false,
    finalButtonMatched: false,
    conflictingActionFound: false,
    confidence: "LOW" as const,
  };

  if (matching.length !== 1) {
    return {
      ...base,
      ready: false,
      blockedReason: `${matching.length} modal(s) referenced ${symbolUpper}; expected exactly one.`,
      modalTextExcerpt: candidates.map((m) => textOf(m).slice(0, 160)).join(" | "),
      quantityEvidence: null,
      finalControlText: null,
    };
  }

  const modal = matching[0]!;
  const text = textOf(modal);
  const actionMatched = /\blong\b/i.test(text);
  const conflictingActionFound = /\b(short|sell|close\s*position|increase\s*leverage|add\s*margin)\b/i.test(text);
  const quantityMatch = text.match(new RegExp(`([\\d,.]+)\\s*${symbolPattern}`, "i"));
  const quantityParsed = quantityMatch ? Number(quantityMatch[1]!.replace(/,/g, "")) : null;
  const quantityMatched =
    quantityParsed !== null &&
    Number.isFinite(quantityParsed) &&
    Math.abs(quantityParsed - expectedQuantity) <= Math.max(1e-6, expectedQuantity * 0.01);
  const confirmControls = findConfirmControls(modal);
  const finalControl = confirmControls.length === 1 ? confirmControls[0]! : null;
  const finalButtonMatched = finalControl !== null;
  const confidence: "HIGH" | "LOW" =
    actionMatched && quantityMatched && finalButtonMatched && !conflictingActionFound ? "HIGH" : "LOW";
  const evidence = {
    modalFound: true,
    symbolMatched: true,
    actionMatched,
    quantityMatched,
    finalButtonMatched,
    conflictingActionFound,
    confidence,
  };

  if (conflictingActionFound) {
    return {
      ...evidence,
      ready: false,
      blockedReason: "Modal contains short/sell/close/leverage wording unexpected for a buy confirmation.",
      modalTextExcerpt: text.slice(0, 240),
      quantityEvidence: quantityMatch?.[0] ?? null,
      finalControlText: finalControl ? textOf(finalControl) : null,
    };
  }
  if (!actionMatched) {
    return {
      ...evidence,
      ready: false,
      blockedReason: "Modal does not contain positive long/buy action evidence.",
      modalTextExcerpt: text.slice(0, 240),
      quantityEvidence: quantityMatch?.[0] ?? null,
      finalControlText: finalControl ? textOf(finalControl) : null,
    };
  }
  if (!quantityMatched) {
    return {
      ...evidence,
      ready: false,
      blockedReason: `Modal quantity evidence (${quantityMatch?.[0] ?? "none"}) does not match the ${expectedQuantity} we set.`,
      modalTextExcerpt: text.slice(0, 240),
      quantityEvidence: quantityMatch?.[0] ?? null,
      finalControlText: finalControl ? textOf(finalControl) : null,
    };
  }
  if (!finalControl) {
    return {
      ...evidence,
      ready: false,
      blockedReason: `${confirmControls.length} "Confirm" button(s) found; expected exactly one.`,
      modalTextExcerpt: text.slice(0, 240),
      quantityEvidence: quantityMatch?.[0] ?? null,
      finalControlText: null,
    };
  }

  return {
    ...evidence,
    ready: true,
    blockedReason: null,
    modalTextExcerpt: text.slice(0, 240),
    quantityEvidence: quantityMatch?.[0] ?? null,
    finalControlText: textOf(finalControl),
  };
}

async function waitForBuyModal(
  root: ParentNode,
  symbol: string,
  expectedQuantity: number
): Promise<BuyModalValidation> {
  const deadline = Date.now() + MODAL_WAIT_MS;
  let latest = validateBuyModal(root, symbol, expectedQuantity);
  while (!latest.ready && Date.now() < deadline) {
    await sleep(MODAL_POLL_MS);
    latest = validateBuyModal(root, symbol, expectedQuantity);
  }
  return latest;
}

/** Fills the quantity, ensures Buy + Market are selected, and clicks
 * submit — then waits for and validates the resulting confirmation modal.
 * Never clicks the modal's own Confirm button; that's confirmValidatedBuyOrder's
 * job, as a deliberately separate step re-validated immediately before the
 * click, same two-phase discipline as the close flow. */
export async function openKrakenBuyOrder(
  root: ParentNode,
  symbol: string,
  quantityUnits: number
): Promise<BuyOrderReport> {
  const symbolUpper = symbol.toUpperCase();
  const blocked = (reason: string, quantitySet: number | null = null): BuyOrderReport => ({
    symbol: symbolUpper,
    ready: false,
    blockedReason: reason,
    quantitySet,
  });

  if (!Number.isFinite(quantityUnits) || quantityUnits <= 0) {
    return blocked(`Requested quantity ${quantityUnits} is not a positive finite number.`);
  }

  let panel = findOrderEntryPanel(root);
  if (!panel) return blocked("Order entry panel was not found.");
  if (!new RegExp(symbolBoundaryPattern(symbolUpper), "i").test(textOf(panel))) {
    return blocked(`Order entry panel does not appear to reference ${symbolUpper}; wrong page?`);
  }

  const buyTabs = findTabCandidates(panel, "buy");
  if (buyTabs.length !== 1) {
    return blocked(`${buyTabs.length} Buy tab candidate(s) found; expected exactly one.`);
  }
  const buyTab = buyTabs[0]!;
  if (!(buyTab instanceof HTMLElement)) return blocked("Buy tab is not clickable.");
  if (tabSelectedState(buyTab) !== true) {
    buyTab.click();
    await sleep(AFTER_CLICK_SETTLE_MS);
    panel = findOrderEntryPanel(root) ?? panel;
  }

  const marketTabs = findTabCandidates(panel, "market");
  if (marketTabs.length !== 1) {
    return blocked(
      `${marketTabs.length} Market order-type candidate(s) found; refusing to guess order type rather than risk a Limit order.`
    );
  }
  const marketTab = marketTabs[0]!;
  if (!(marketTab instanceof HTMLElement)) return blocked("Market order-type control is not clickable.");
  // Always click, defensively — Market/Limit selected-state could not be
  // read reliably in real diagnostics (came back UNKNOWN), so we never
  // trust an assumed-already-selected state for something this important.
  marketTab.click();
  await sleep(AFTER_CLICK_SETTLE_MS);
  panel = findOrderEntryPanel(root) ?? panel;

  const quantityInput = findQuantityInput(panel);
  if (!quantityInput) return blocked("Quantity input was not found.");

  const formatted = formatQuantity(quantityUnits);
  setReactControlledValue(quantityInput, formatted);
  await sleep(100);
  const readBack = Number(quantityInput.value);
  if (!Number.isFinite(readBack) || Math.abs(readBack - quantityUnits) > Math.max(1e-8, quantityUnits * 0.02)) {
    return blocked(
      `Quantity input reads "${quantityInput.value}" after setting ${formatted}; it did not take as expected.`
    );
  }

  const sellTabs = findTabCandidates(panel, "sell");
  const limitTabs = findTabCandidates(panel, "limit");
  const submitCandidates = findSubmitControlCandidates(panel, [...buyTabs, ...sellTabs, ...marketTabs, ...limitTabs]);
  if (submitCandidates.length !== 1) {
    return blocked(
      `${submitCandidates.length} submit control candidate(s) found; expected exactly one.`,
      readBack
    );
  }
  const submit = submitCandidates[0]!;
  if (!(submit instanceof HTMLElement)) return blocked("Submit control is not an HTMLElement.", readBack);

  submit.focus();
  submit.click();

  const modalValidation = await waitForBuyModal(root, symbolUpper, readBack);
  if (!modalValidation.ready) {
    // Never leave a confirmation dialog this extension itself opened
    // sitting on the page unattended after deciding not to confirm it —
    // same reasoning as the close flow's dangling-modal fix.
    dismissOpenModal();
  }
  return {
    symbol: symbolUpper,
    ready: modalValidation.ready,
    blockedReason: modalValidation.blockedReason,
    quantitySet: readBack,
    modalValidation,
  };
}

/** Re-validates the confirmation modal immediately before clicking its
 * Confirm button — the modal's own state could have changed since
 * openKrakenBuyOrder last checked it (e.g. price moved, user touched the
 * page), so this never trusts a stale earlier validation. */
export function confirmValidatedBuyOrder(
  root: ParentNode,
  symbol: string,
  expectedQuantity: number
): { validation: BuyModalValidation; clicked: boolean } {
  const validation = validateBuyModal(root, symbol, expectedQuantity);
  if (!validation.ready) {
    dismissOpenModal();
    return { validation, clicked: false };
  }
  const symbolUpper = symbol.toUpperCase();
  const modal = findModalCandidates(root).find((candidate) =>
    new RegExp(symbolBoundaryPattern(symbolUpper), "i").test(textOf(candidate))
  );
  const controls = modal ? findConfirmControls(modal) : [];
  if (controls.length !== 1) {
    dismissOpenModal();
    return {
      validation: {
        ...validation,
        ready: false,
        finalButtonMatched: false,
        confidence: "LOW",
        blockedReason: `${controls.length} "Confirm" button(s) found at submit time; expected exactly one.`,
      },
      clicked: false,
    };
  }
  controls[0]!.click();
  return { validation, clicked: true };
}
