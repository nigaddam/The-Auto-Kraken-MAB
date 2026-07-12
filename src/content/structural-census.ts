/** Read-only structural inventory of the Open positions section — used when
 * row discovery finds nothing, to see *why* without dumping the page or any
 * sensitive data. Every value here is a count, a tag name, a role, or a
 * data-* attribute *name* (never a value that could carry an account
 * identifier), plus a handful of short sanitized text samples. */

import type { AncestorChainEntry, StructuralCensus, TextAnchorReport } from "../shared/types";
import { findElementsWithOwnTextWord, parseNumberFromText, textOf } from "./kraken-dom";

const CENSUS_KEYWORDS = ["Long", "Short", "XPL", "JTO", "USD", "Add"];
const MAX_ANCHORS_PER_KEYWORD = 5;
const MAX_CHAIN_DEPTH = 6;

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

function matchesExactSymbol(el: Element, symbols: string[]): boolean {
  const text = textOf(el);
  return symbols.some((s) => new RegExp(`\\b${s}\\b`, "i").test(text));
}

function matchesExactSide(el: Element): boolean {
  return /\b(long|short)\b/i.test(textOf(el));
}

function buildAncestorChain(
  anchor: Element,
  container: Element,
  supportedSymbols: string[]
): AncestorChainEntry[] {
  const chain: AncestorChainEntry[] = [];
  let el: Element | null = anchor;
  let depth = 0;
  while (el && depth <= MAX_CHAIN_DEPTH) {
    chain.push({
      depthFromAnchor: depth,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      directChildCount: el.children.length,
      classCount: el.classList.length,
      dataAttributeNames: Array.from(el.attributes)
        .filter((a) => a.name.startsWith("data-"))
        .map((a) => a.name),
      buttonCount: el.querySelectorAll('button, [role="button"]').length,
      containsExactSymbol: matchesExactSymbol(el, supportedSymbols),
      containsExactSide: matchesExactSide(el),
      distinctNumericFieldCount: countDistinctNumericFields(el),
    });
    if (el === container) break;
    el = el.parentElement;
    depth++;
  }
  return chain;
}

function buildTextAnchorReports(
  container: Element,
  words: string[],
  supportedSymbols: string[]
): TextAnchorReport[] {
  const anchors = findElementsWithOwnTextWord(container, words).slice(0, MAX_ANCHORS_PER_KEYWORD);
  return anchors.map((anchor) => ({
    anchorText: words.find((w) => new RegExp(`\\b${w}\\b`, "i").test(anchor.textContent ?? "")) ?? words[0]!,
    ancestorChain: buildAncestorChain(anchor, container, supportedSymbols),
  }));
}

export function buildStructuralCensus(container: Element, supportedSymbols: string[]): StructuralCensus {
  const allDescendants = Array.from(container.querySelectorAll<Element>("*"));

  const totalDivCount = allDescendants.filter((el) => el.tagName.toLowerCase() === "div").length;
  const roledElements = allDescendants.filter((el) => el.hasAttribute("role"));
  const roleValueCounts: Record<string, number> = {};
  for (const el of roledElements) {
    const role = el.getAttribute("role") ?? "";
    roleValueCounts[role] = (roleValueCounts[role] ?? 0) + 1;
  }

  const keywordElementCounts: Record<string, number> = {};
  for (const keyword of CENSUS_KEYWORDS) {
    keywordElementCounts[keyword] = findElementsWithOwnTextWord(container, [keyword]).length;
  }

  const dataAttributeNameSet = new Set<string>();
  for (const el of allDescendants) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("data-") || attr.name === "aria-label" || attr.name === "title") {
        dataAttributeNameSet.add(attr.name);
      }
    }
  }

  const multiNumericFieldElementCount = allDescendants.filter(
    (el) => countDistinctNumericFields(el) >= 2
  ).length;

  return {
    totalDivCount,
    roledElementCount: roledElements.length,
    roleValueCounts,
    keywordElementCounts,
    distinctDataAttributeNames: Array.from(dataAttributeNameSet).sort(),
    multiNumericFieldElementCount,
    longShortTextAnchors: buildTextAnchorReports(container, ["Long", "Short"], supportedSymbols),
    symbolTextAnchors: buildTextAnchorReports(container, supportedSymbols, supportedSymbols),
  };
}
