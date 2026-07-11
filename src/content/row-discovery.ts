/** Conservative, DOM-shape-agnostic fallback row discovery.
 *
 * Kraken's real Positions section does not use <tr>/role="row"/treegrid
 * semantics — it's plain divs. This never relies on native table/row
 * semantics, row order, or fixed indices. Instead it starts from exact
 * text anchors ("Long"/"Short", or a supported symbol) and walks *up* the
 * DOM to the smallest ancestor that also carries the other required
 * signals — the same technique described for manual calibration.
 *
 * An "actionable" row candidate is the smallest ancestor of a Long/Short
 * text anchor that also contains an exact supported symbol and at least
 * two distinct parseable numeric fields (price/value). A "summary" row
 * candidate is the smallest ancestor of a symbol anchor that contains no
 * Long/Short text and at least one numeric field.
 */

import { findElementsWithOwnTextWord, parseNumberFromText, textOf } from "./kraken-dom";
import type { Side } from "../shared/types";

const EXCLUDED_SYMBOL_TOKENS = new Set([
  "LONG",
  "SHORT",
  "USD",
  "USDT",
  "USDC",
  "TP",
  "SL",
  "ADD",
  "VALUE",
  "OPENING",
  "CURRENT",
  "PRICE",
  "ENTRY",
  "MARK",
  "NET",
  "PNL",
  "UPNL",
  "LEVERAGE",
]);

function countDistinctNumericFields(el: Element): number {
  const text = textOf(el);
  const matches = text.match(/-?\(?\$?\d[\d,]*(?:\.\d+)?%?\)?/g) ?? [];
  const parsed = new Set<number>();
  for (const m of matches) {
    const n = parseNumberFromText(m);
    if (n !== null) parsed.add(n);
  }
  return parsed.size;
}

function matchedExactSymbol(el: Element, symbols: string[]): string | null {
  const text = textOf(el);
  for (const s of symbols) {
    if (new RegExp(`\\b${s}\\b`, "i").test(text)) return s.toUpperCase();
  }
  return extractLikelySymbol(el);
}

function extractLikelySymbol(el: Element): string | null {
  const leafTokens = Array.from(el.querySelectorAll<Element>("*"))
    .filter((child) => child.children.length === 0)
    .map((child) => textOf(child).toUpperCase())
    .filter((token) => /^[A-Z][A-Z0-9]{1,9}$/.test(token));
  const leafMatch = leafTokens.find(
    (token) => !EXCLUDED_SYMBOL_TOKENS.has(token) && !/^\d+X$/.test(token)
  );
  if (leafMatch) return leafMatch;

  const text = textOf(el).toUpperCase();
  const tokens = text.match(/\b[A-Z][A-Z0-9]{1,9}\b/g) ?? [];
  return tokens.find((token) => !EXCLUDED_SYMBOL_TOKENS.has(token) && !/^\d+X$/.test(token)) ?? null;
}

function matchedExactSide(el: Element): Side | null {
  const text = textOf(el);
  if (/\bLONG\b/i.test(text)) return "LONG";
  if (/\bSHORT\b/i.test(text)) return "SHORT";
  const leafTexts = Array.from(el.querySelectorAll<Element>("*"))
    .filter((child) => child.children.length === 0)
    .map((child) => textOf(child).toUpperCase());
  if (leafTexts.includes("LONG")) return "LONG";
  if (leafTexts.includes("SHORT")) return "SHORT";
  return null;
}

function walkUpToSmallestMatch(
  start: Element,
  boundary: Element,
  predicate: (el: Element) => boolean
): Element | null {
  let el: Element | null = start;
  while (el) {
    if (predicate(el)) return el;
    if (el === boundary) return null;
    el = el.parentElement;
  }
  return null;
}

export type DiscoveredRowKind = "ACTIONABLE" | "SUMMARY";

export interface DiscoveredRow {
  element: Element;
  kind: DiscoveredRowKind;
  symbol: string;
  side: Side | null;
}

export function discoverRowsBySymbolAnchors(
  container: Element,
  supportedSymbols: string[]
): DiscoveredRow[] {
  const sideAnchors = findElementsWithOwnTextWord(container, ["Long", "Short"]);
  const actionableElements = new Set<Element>();
  const actionablePredicate = (el: Element): boolean =>
    matchedExactSymbol(el, supportedSymbols) !== null &&
    matchedExactSide(el) !== null &&
    countDistinctNumericFields(el) >= 2;

  for (const anchor of sideAnchors) {
    const match = walkUpToSmallestMatch(anchor, container, actionablePredicate);
    if (match) actionableElements.add(match);
  }

  if (actionableElements.size === 0) {
    const broadMatches = Array.from(container.querySelectorAll<Element>("*")).filter(actionablePredicate);
    for (const match of broadMatches) {
      if (!broadMatches.some((other) => other !== match && match.contains(other))) {
        actionableElements.add(match);
      }
    }
  }

  const actionableSymbols = Array.from(actionableElements)
    .map((el) => matchedExactSymbol(el, supportedSymbols))
    .filter((symbol): symbol is string => symbol !== null);
  const summarySymbols = [...new Set([...supportedSymbols, ...actionableSymbols])];
  const symbolAnchors = summarySymbols.length > 0 ? findElementsWithOwnTextWord(container, summarySymbols) : [];
  const summaryElements = new Set<Element>();
  for (const anchor of symbolAnchors) {
    const match = walkUpToSmallestMatch(
      anchor,
      container,
      (el) =>
        matchedExactSymbol(el, supportedSymbols) !== null &&
        matchedExactSide(el) === null &&
        countDistinctNumericFields(el) >= 1
    );
    if (match) summaryElements.add(match);
  }

  // A summary candidate that turns out to also be (or contain/be contained
  // by) an actionable candidate is not a separate summary row.
  const actionableList = Array.from(actionableElements);
  const summaryList = Array.from(summaryElements).filter(
    (s) => !actionableList.some((a) => a === s || a.contains(s) || s.contains(a))
  );

  const rows: DiscoveredRow[] = [];
  for (const el of actionableList) {
    rows.push({
      element: el,
      kind: "ACTIONABLE",
      symbol: matchedExactSymbol(el, supportedSymbols) ?? "UNKNOWN",
      side: matchedExactSide(el),
    });
  }
  for (const el of summaryList) {
    rows.push({
      element: el,
      kind: "SUMMARY",
      symbol: matchedExactSymbol(el, supportedSymbols) ?? "UNKNOWN",
      side: null,
    });
  }
  return rows;
}
