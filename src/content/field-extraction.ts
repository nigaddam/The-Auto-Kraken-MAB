/** Pure field-parsing helpers shared by position-parser.ts (production),
 * position-grouping.ts (identity/grouping), and diagnostics.ts (report).
 * Kept in their own module — not in position-parser.ts — so grouping logic
 * can depend on them without position-parser.ts and position-grouping.ts
 * importing each other (a circular import). */

import { SYMBOL_MAP } from "../api/symbols";
import type { Side } from "../shared/types";
import { findLabeledText, parseNumberFromText, textOf } from "./kraken-dom";

const KNOWN_SYMBOLS = new Set(Object.keys(SYMBOL_MAP));
const EXCLUDED_TOKENS = new Set([
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

export function extractSymbol(row: Element): string | null {
  const labeled = findLabeledText(row, [/symbol/i, /market/i, /instrument/i]);
  if (labeled) {
    const cleaned = labeled.trim().toUpperCase().replace(/\/USD.*$/, "");
    if (cleaned.length > 0) return cleaned;
  }

  const leafTokens = Array.from(row.querySelectorAll<Element>("*"))
    .filter((el) => el.children.length === 0)
    .map((el) => textOf(el).toUpperCase())
    .filter((token) => /^[A-Z][A-Z0-9]{1,9}$/.test(token));
  const knownLeaf = leafTokens.find((t) => KNOWN_SYMBOLS.has(t) && !EXCLUDED_TOKENS.has(t));
  if (knownLeaf) return knownLeaf;
  const fallbackLeaf = leafTokens.find((t) => !EXCLUDED_TOKENS.has(t) && !/^\d+X$/.test(t));
  if (fallbackLeaf) return fallbackLeaf;

  const rowText = textOf(row).toUpperCase();
  const tokens = rowText.match(/\b[A-Z]{2,6}\b/g) ?? [];

  const knownMatch = tokens.find((t) => KNOWN_SYMBOLS.has(t) && !EXCLUDED_TOKENS.has(t));
  if (knownMatch) return knownMatch;

  const fallback = tokens.find((t) => !EXCLUDED_TOKENS.has(t));
  return fallback ?? null;
}

export function extractSide(rowText: string): Side | null {
  if (/\bLONG\b/i.test(rowText)) return "LONG";
  if (/\bSHORT\b/i.test(rowText)) return "SHORT";
  return null;
}

function extractSideFromElement(row: Element): Side | null {
  const fromText = extractSide(textOf(row));
  if (fromText) return fromText;
  const leafTexts = Array.from(row.querySelectorAll<Element>("*"))
    .filter((el) => el.children.length === 0)
    .map((el) => textOf(el).toUpperCase());
  if (leafTexts.includes("LONG")) return "LONG";
  if (leafTexts.includes("SHORT")) return "SHORT";
  return null;
}

function directCells(row: Element): Element[] {
  const children = Array.from(row.children);
  if (children.length >= 5) return children;
  const leafChildren = Array.from(row.querySelectorAll<Element>("*")).filter((el) => el.children.length === 0);
  return leafChildren.length >= 5 ? leafChildren : children;
}

function extractSymbolFromText(text: string): string | null {
  const tokens = text.toUpperCase().match(/\b[A-Z][A-Z0-9]{1,9}\b/g) ?? [];
  const knownMatch = tokens.find((t) => KNOWN_SYMBOLS.has(t) && !EXCLUDED_TOKENS.has(t));
  if (knownMatch) return knownMatch;
  return tokens.find((t) => !EXCLUDED_TOKENS.has(t) && !/^\d+X$/.test(t)) ?? null;
}

function extractLeverageFromText(text: string): number | null {
  const match = text.match(/\b(\d+(?:\.\d+)?)\s*x\b/i);
  return match?.[1] ? Number(match[1]) : null;
}

function extractColumnFields(row: Element): Partial<RawPositionFields> {
  const cells = directCells(row);
  const sideIndex = cells.findIndex((cell) => extractSide(textOf(cell)) !== null);
  if (sideIndex < 0) return {};

  const textAt = (index: number): string | null => (cells[index] ? textOf(cells[index]) : null);
  const numberAt = (index: number): number | null => {
    const text = textAt(index);
    return text ? parseNumberFromText(text) : null;
  };
  const marketText = textAt(Math.max(0, sideIndex - 1)) ?? textOf(row);
  const valueUsd = numberAt(sideIndex + 1);
  const entryPrice = numberAt(sideIndex + 2);
  const currentPriceUi = numberAt(sideIndex + 3);
  if (valueUsd === null || entryPrice === null || currentPriceUi === null) {
    return {};
  }

  return {
    symbol: extractSymbolFromText(marketText),
    side: extractSide(textAt(sideIndex) ?? ""),
    valueUsd,
    entryPrice,
    currentPriceUi,
    tpSlText: textAt(sideIndex + 4),
    upnl: numberAt(sideIndex + 5),
    netPnl: numberAt(sideIndex + 6),
    leverage: extractLeverageFromText(marketText) ?? extractLeverageFromText(textOf(row)),
  };
}

export interface RawPositionFields {
  symbol: string | null;
  side: Side | null;
  entryPrice: number | null;
  currentPriceUi: number | null;
  valueUsd: number | null;
  upnl: number | null;
  netPnl: number | null;
  leverage: number | null;
  tpSlText: string | null;
}

/** Every field individually nullable — used by both the strict production
 * parser and the lenient diagnostics report, which wants to show exactly
 * which fields it found rather than an all-or-nothing result. Both read
 * exactly the same way, so diagnostics output reflects reality for the
 * real parser too. */
export function extractRawPositionFields(row: Element): RawPositionFields {
  const entryPriceText = findLabeledText(row, [/entry/i, /open(?:ing)?\s*price/i]);
  const currentPriceText = findLabeledText(row, [/mark\s*price/i, /current\s*price/i, /last\s*price/i]);
  const valueText = findLabeledText(row, [/\bvalue\b/i, /notional/i]);
  const upnlText = findLabeledText(row, [/upnl/i, /u\.?\s*p\s*&?\s*l/i, /unrealized/i]);
  const netPnlText = findLabeledText(row, [/net[\s-]*pnl/i, /net\s*p\s*&?\s*l/i]);
  const leverageText = findLabeledText(row, [/leverage/i]);
  const tpSlText = findLabeledText(row, [/tp\s*\/?\s*sl/i, /take\s*profit/i, /stop\s*loss/i]);
  const columnFields = extractColumnFields(row);

  return {
    symbol: extractSymbol(row) ?? columnFields.symbol ?? null,
    side: extractSideFromElement(row) ?? columnFields.side ?? null,
    entryPrice: (entryPriceText ? parseNumberFromText(entryPriceText) : null) ?? columnFields.entryPrice ?? null,
    currentPriceUi:
      (currentPriceText ? parseNumberFromText(currentPriceText) : null) ?? columnFields.currentPriceUi ?? null,
    valueUsd: (valueText ? parseNumberFromText(valueText) : null) ?? columnFields.valueUsd ?? null,
    upnl: (upnlText ? parseNumberFromText(upnlText) : null) ?? columnFields.upnl ?? null,
    netPnl: (netPnlText ? parseNumberFromText(netPnlText) : null) ?? columnFields.netPnl ?? null,
    leverage: (leverageText ? parseNumberFromText(leverageText) : null) ?? columnFields.leverage ?? null,
    tpSlText: tpSlText ?? columnFields.tpSlText ?? null,
  };
}
