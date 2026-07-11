/** Read-only calibration diagnostics for Kraken's Buy/Open order form and
 * account-equity display. Neither has ever been inspected against a real,
 * logged-in Kraken page before — this extension has so far only ever
 * looked at the Positions table and the Close-position dialog. Never
 * clicks, fills, or hovers (hovering can trigger tooltips or other page
 * interaction) — same rule as diagnostics.ts. This report exists purely so
 * real selectors can be chosen deliberately from real evidence, before any
 * order-placement automation is written; per this project's own history
 * (a regex capture-group bug, a full row-discovery rewrite), guessing
 * selectors for an unseen UI surface produces real bugs, and at
 * buy-order stakes that is not acceptable. Run this against the real Buy
 * tab (with the order form visible, nothing submitted) and the account
 * details panel, then share the report back.
 */

import type { OrderFormControlInfo, OrderFormDiagnosticsReport } from "../shared/types";
import { findLabeledText, parseNumberFromText, textOf } from "./kraken-dom";
import { sanitizeText } from "./diagnostics";

function matchesAnyKeyword(value: string | null | undefined, keywords: RegExp[]): boolean {
  if (!value) return false;
  return keywords.some((re) => re.test(value));
}

/** Best-effort heuristic, deliberately generic (per kraken-dom.ts's own
 * documented convention) since the real Trade/Buy page markup is unknown
 * until this is run for real. Prefers a labeled tablist/form/section over
 * a bare heading match. Returns null rather than guess. */
export function findOrderEntryPanel(root: ParentNode): Element | null {
  const candidates = Array.from(
    root.querySelectorAll<Element>(
      '[role="tablist"], [data-testid*="order" i], [data-testid*="trade" i], form'
    )
  );
  const labeled = candidates.find((el) => {
    const label = el.getAttribute("aria-label") ?? el.getAttribute("title");
    if (matchesAnyKeyword(label, [/buy/i, /order/i, /trade/i])) return true;
    return /\b(buy|sell)\b/i.test(textOf(el));
  });
  if (labeled) return labeled;
  if (candidates.length > 0) return candidates[0]!;

  const headings = Array.from(root.querySelectorAll<Element>("h1, h2, h3, h4"));
  const heading = headings.find((h) => matchesAnyKeyword(textOf(h), [/^trade$/i, /place order/i, /buy\s*\/\s*sell/i]));
  return heading ? (heading.parentElement ?? heading) : null;
}

function findTabCandidates(panel: Element, label: "buy" | "sell" | "market" | "limit"): Element[] {
  const candidates = Array.from(panel.querySelectorAll<Element>('[role="tab"], button, [role="button"]'));
  return candidates.filter((el) => {
    const name = el.getAttribute("aria-label") ?? el.getAttribute("title") ?? textOf(el);
    return new RegExp(`^${label}$`, "i").test(name.trim());
  });
}

function tabSelectedState(tab: Element | null): boolean | "UNKNOWN" {
  if (!tab) return "UNKNOWN";
  const ariaSelected = tab.getAttribute("aria-selected");
  if (ariaSelected === "true") return true;
  if (ariaSelected === "false") return false;
  const ariaPressed = tab.getAttribute("aria-pressed");
  if (ariaPressed === "true") return true;
  if (ariaPressed === "false") return false;
  return "UNKNOWN";
}

function buildControlInfo(candidates: Element[]): OrderFormControlInfo | null {
  if (candidates.length === 0) return null;
  const control = candidates[0]!;
  const ariaLabel = control.getAttribute("aria-label");
  const title = control.getAttribute("title");
  const visibleText = textOf(control);
  return {
    found: true,
    ambiguous: candidates.length !== 1,
    candidateCount: candidates.length,
    ariaLabelPresent: Boolean(ariaLabel),
    titlePresent: Boolean(title),
    dataTestId: control.getAttribute("data-testid"),
    accessibleName: ariaLabel ?? title ?? (visibleText.length > 0 ? sanitizeText(visibleText, 80) : null),
    roleIsButton: control.getAttribute("role") === "button" || control.tagName.toLowerCase() === "button",
  };
}

function findQuantityInput(panel: Element): HTMLInputElement | null {
  const inputs = Array.from(panel.querySelectorAll<HTMLInputElement>("input"));
  const match = inputs.find((el) => {
    const label =
      el.getAttribute("aria-label") ??
      el.getAttribute("placeholder") ??
      el.getAttribute("name") ??
      el.getAttribute("data-testid");
    return matchesAnyKeyword(label, [/quantity/i, /amount/i, /size/i]);
  });
  return match ?? null;
}

function findOrderTypeState(panel: Element): { isMarket: boolean | "UNKNOWN"; isLimit: boolean | "UNKNOWN" } {
  return {
    isMarket: tabSelectedState(findTabCandidates(panel, "market")[0] ?? null),
    isLimit: tabSelectedState(findTabCandidates(panel, "limit")[0] ?? null),
  };
}

function findSubmitControlCandidates(panel: Element): Element[] {
  const candidates = Array.from(panel.querySelectorAll<Element>('button, [role="button"]'));
  return candidates.filter((el) => {
    const name = el.getAttribute("aria-label") ?? el.getAttribute("title") ?? textOf(el);
    return /\b(buy|place\s*order|submit|open\s*long)\b/i.test(name);
  });
}

/** findLabeledText's own last-resort branch reads `row.textContent` — which
 * is always null on a Document node per the DOM spec, only meaningful on an
 * Element. Scope to `document.body` (or documentElement as a fallback) so
 * that branch actually sees the page's text, same precedent as
 * findPositionsContainer never calling textOf(root) directly. */
function scopeToElement(root: ParentNode): Element | null {
  if (root instanceof Document) return root.body ?? root.documentElement ?? null;
  return root instanceof Element ? root : null;
}

export function findAccountEquityText(root: ParentNode): string | null {
  const scoped = scopeToElement(root);
  if (!scoped) return null;
  return findLabeledText(scoped, [/total\s*equity/i, /account\s*equity/i, /^equity$/i]);
}

export function runOrderFormDiagnostics(root: ParentNode, url: string): OrderFormDiagnosticsReport {
  const panel = findOrderEntryPanel(root);

  const buyTabCandidates = panel ? findTabCandidates(panel, "buy") : [];
  const sellTabCandidates = panel ? findTabCandidates(panel, "sell") : [];

  const quantityInput = panel ? findQuantityInput(panel) : null;
  const orderType = panel ? findOrderTypeState(panel) : { isMarket: "UNKNOWN" as const, isLimit: "UNKNOWN" as const };
  const submitCandidates = panel ? findSubmitControlCandidates(panel) : [];

  const leverageText = panel
    ? findLabeledText(panel, [/leverage/i])
    : null;

  const equityText = findAccountEquityText(root);

  return {
    generatedAt: Date.now(),
    url: sanitizeText(url, 300),
    orderEntryPanelDetected: panel !== null,
    buyTabControl: buildControlInfo(buyTabCandidates),
    buyTabSelected: tabSelectedState(buyTabCandidates[0] ?? null),
    sellTabControl: buildControlInfo(sellTabCandidates),
    sellTabSelected: tabSelectedState(sellTabCandidates[0] ?? null),
    quantityInputDetected: quantityInput !== null,
    quantityInputCurrentValue: quantityInput?.value ?? null,
    quantityInputStep: quantityInput?.getAttribute("step") ?? null,
    leverageValueText: leverageText,
    orderTypeIsMarket: orderType.isMarket,
    orderTypeIsLimit: orderType.isLimit,
    submitControl: buildControlInfo(submitCandidates),
    accountEquityLabelFound: equityText !== null,
    accountEquityText: equityText,
    accountEquityParsed: equityText ? parseNumberFromText(equityText) : null,
    rawPanelTextExcerpt: panel ? sanitizeText(textOf(panel), 500) : null,
  };
}
