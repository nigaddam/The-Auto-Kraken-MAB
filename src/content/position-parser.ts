import { SYMBOL_MAP } from "../api/symbols";
import type { ParsedPositionData } from "../shared/types";
import { extractRawPositionFields, extractSymbol } from "./field-extraction";
import {
  findPositionRows,
  findPositionsContainer,
  resolveOwnedCloseControls,
} from "./kraken-dom";
import { discoverRowsBySymbolAnchors } from "./row-discovery";

export interface PositionParseResult {
  positions: ParsedPositionData[];
  /** Rows that looked like a position (had LONG/SHORT text) but couldn't be
   * parsed with confidence — surfaced so the UI/logs can flag "N rows
   * detected but unreadable" instead of silently dropping them. */
  unparsedRowCount: number;
  /** Total candidate rows considered (parsed + unparsed), before any
   * filtering. Lets the UI show "N parsed of M candidates" instead of a
   * single opaque number. */
  candidateRowCount: number;
  /** Which discovery method produced the candidate rows — surfaced so it's
   * obvious when the semantic role-based approach isn't matching Kraken's
   * real markup and the fallback text-anchor approach is doing the work. */
  discoveryMethod: "SEMANTIC_ROLES" | "TEXT_ANCHOR_FALLBACK" | "NONE";
}

const SUPPORTED_SYMBOLS = Object.keys(SYMBOL_MAP);

export function parsePositionRow(row: Element): ParsedPositionData | null {
  const fields = extractRawPositionFields(row);

  // Core fields must be present and confidently parsed; anything ambiguous
  // here means "don't act on this row" rather than filling in a guess.
  if (
    !fields.side ||
    !fields.symbol ||
    fields.entryPrice === null ||
    fields.currentPriceUi === null ||
    fields.valueUsd === null
  ) {
    return null;
  }

  return {
    symbol: fields.symbol,
    side: fields.side,
    entryPrice: fields.entryPrice,
    currentPriceUi: fields.currentPriceUi,
    valueUsd: fields.valueUsd,
    upnl: fields.upnl ?? 0,
    netPnl: fields.netPnl ?? 0,
    leverage: fields.leverage,
    tpSlText: fields.tpSlText,
  };
}

/** Rows to actually parse, using the role/tr-based semantic approach first
 * (preferred: accessible roles are the most stable locator when present),
 * falling back to the text-anchor discovery only when the semantic
 * approach finds nothing — which is what happens on Kraken's real,
 * non-table-based Positions markup. */
export function resolveActionableRows(container: Element): {
  rows: Element[];
  discoveryMethod: PositionParseResult["discoveryMethod"];
} {
  const semanticRows = findPositionRows(container);
  const ownedCloseControls = resolveOwnedCloseControls(semanticRows);
  const semanticActionable = semanticRows.filter((_row, i) => ownedCloseControls[i] !== null);
  if (semanticActionable.length > 0) {
    return { rows: semanticActionable, discoveryMethod: "SEMANTIC_ROLES" };
  }

  const discovered = discoverRowsBySymbolAnchors(container, SUPPORTED_SYMBOLS);
  const actionable = discovered.filter((r) => r.kind === "ACTIONABLE").map((r) => r.element);
  if (actionable.length > 0) {
    return { rows: actionable, discoveryMethod: "TEXT_ANCHOR_FALLBACK" };
  }

  return { rows: [], discoveryMethod: "NONE" };
}

export function parsePositionsFromDocument(root: ParentNode): PositionParseResult {
  const container = findPositionsContainer(root);
  if (!container) {
    return { positions: [], unparsedRowCount: 0, candidateRowCount: 0, discoveryMethod: "NONE" };
  }

  const { rows, discoveryMethod } = resolveActionableRows(container);
  const positions: ParsedPositionData[] = [];
  let unparsedRowCount = 0;

  for (const row of rows) {
    const parsed = parsePositionRow(row);
    if (parsed) {
      positions.push(parsed);
    } else {
      unparsedRowCount++;
    }
  }

  return { positions, unparsedRowCount, candidateRowCount: rows.length, discoveryMethod };
}

/** Re-exported for content-script.ts / close-executor.ts (Stage-gated,
 * Iteration 3+): finding the row for a specific already-validated symbol so
 * a later stage can locate its Close control. Not used for clicking in
 * Iteration 1/2. */
export function findRowForSymbol(root: ParentNode, uiSymbol: string): Element | null {
  const container = findPositionsContainer(root);
  if (!container) return null;
  const { rows } = resolveActionableRows(container);
  const matches = rows.filter((row) => extractSymbol(row) === uiSymbol.toUpperCase());
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export { extractRawPositionFields, extractSymbol };
