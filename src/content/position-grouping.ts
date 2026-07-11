/** Groups candidate position rows into PositionGroups using DOM structural
 * evidence — never symbol text alone. Kraken's Positions table may render a
 * non-actionable "summary" row plus one *or more* actionable child rows
 * (lots) for the same symbol — a market can have more than one open lot.
 * Multiple actionable children under one summary is normal, not ambiguous,
 * *as long as the lots are distinguishable* (different opening price,
 * primarily, or failing that, different value). Only genuinely
 * indistinguishable rows are flagged `ambiguous` — callers must treat an
 * ambiguous group as "cannot act here," never "pick one."
 *
 * Grouping evidence is gathered and applied in this priority order
 * (strongest first):
 *   1. DOM parent/child containment
 *   2. aria-expanded / aria-controls linkage
 *   3. a shared data-* attribute value
 *   4. DOM adjacency + matching symbol text (weakest — logged as such)
 */

import { extractRawPositionFields, extractSymbol } from "./field-extraction";
import { resolveOwnedCloseControls } from "./kraken-dom";

/** Opening price is the primary identity signal; this tolerance absorbs
 * only display rounding, not real price differences between lots. */
const OPENING_PRICE_TOLERANCE_PCT = 0.05;
/** Value is a secondary, weaker signal (it drifts with the market), used
 * only when opening price alone can't distinguish two rows. */
const VALUE_TOLERANCE_PCT = 1;

export interface RowEvidence {
  rowIndex: number;
  hasCloseControl: boolean;
  symbol: string | null;
  openingPrice: number | null;
  valueUsd: number | null;
  ancestorOfRowIndexes: number[];
  descendantOfRowIndexes: number[];
  ariaExpanded: string | null;
  ariaControls: string | null;
  id: string | null;
  sharedDataAttributeMatches: { withRowIndex: number; attribute: string; value: string }[];
  adjacentRowIndexes: number[];
}

export interface PositionGroup {
  groupIndex: number;
  symbol: string | null;
  summaryRowIndex: number | null;
  /** One entry per distinct lot. Can legitimately have more than one. */
  actionableChildRowIndexes: number[];
  ambiguous: boolean;
  ambiguityReason: string | null;
  evidence: string[];
}

function getComparableDataAttributes(el: Element): [string, string][] {
  return Array.from(el.attributes)
    .filter((a) => a.name.startsWith("data-"))
    .map((a) => [a.name, a.value] as [string, string])
    .filter(([, value]) => value.length > 2 && !/^(true|false|0|1)$/i.test(value));
}

export function computeRowEvidence(rows: Element[]): RowEvidence[] {
  const ownedCloseControls = resolveOwnedCloseControls(rows);

  return rows.map((row, i) => {
    const ancestorOfRowIndexes: number[] = [];
    const descendantOfRowIndexes: number[] = [];
    const adjacentRowIndexes: number[] = [];
    const sharedDataAttributeMatches: RowEvidence["sharedDataAttributeMatches"] = [];
    const ownDataAttrs = getComparableDataAttributes(row);

    rows.forEach((other, j) => {
      if (i === j) return;
      if (row.contains(other)) ancestorOfRowIndexes.push(j);
      if (other.contains(row)) descendantOfRowIndexes.push(j);
      if (row.previousElementSibling === other || row.nextElementSibling === other) {
        adjacentRowIndexes.push(j);
      }
      const otherDataAttrs = getComparableDataAttributes(other);
      for (const [name, value] of ownDataAttrs) {
        if (otherDataAttrs.some(([n, v]) => n === name && v === value)) {
          sharedDataAttributeMatches.push({ withRowIndex: j, attribute: name, value });
        }
      }
    });

    const fields = extractRawPositionFields(row);

    return {
      rowIndex: i,
      hasCloseControl: ownedCloseControls[i] !== null,
      symbol: extractSymbol(row),
      openingPrice: fields.entryPrice,
      valueUsd: fields.valueUsd,
      ancestorOfRowIndexes,
      descendantOfRowIndexes,
      ariaExpanded: row.getAttribute("aria-expanded"),
      ariaControls: row.getAttribute("aria-controls"),
      id: row.getAttribute("id"),
      sharedDataAttributeMatches,
      adjacentRowIndexes,
    };
  });
}

/** Opening price carries more identity weight than value (value drifts
 * with the market). Two rows are "distinguishable" (i.e. provably separate
 * lots) if their opening prices differ beyond rounding tolerance, or —
 * only when opening price can't tell them apart — their values differ
 * beyond tolerance. If neither field is available or both match within
 * tolerance, the rows cannot be proven separate. */
function rowsAreDistinguishable(a: RowEvidence, b: RowEvidence): boolean {
  if (a.openingPrice !== null && b.openingPrice !== null) {
    const base = Math.max(Math.abs(a.openingPrice), Math.abs(b.openingPrice), 1e-9);
    const diffPct = (Math.abs(a.openingPrice - b.openingPrice) / base) * 100;
    if (diffPct > OPENING_PRICE_TOLERANCE_PCT) return true;
  }
  if (a.valueUsd !== null && b.valueUsd !== null) {
    const base = Math.max(Math.abs(a.valueUsd), Math.abs(b.valueUsd), 1e-9);
    const diffPct = (Math.abs(a.valueUsd - b.valueUsd) / base) * 100;
    if (diffPct > VALUE_TOLERANCE_PCT) return true;
  }
  return false;
}

/** Finds any pair among `indexes` that cannot be proven separate. Returns
 * null if every pair is distinguishable (i.e. all rows are legitimately
 * distinct lots). */
function findIndistinguishablePair(
  indexes: number[],
  evidence: RowEvidence[]
): [number, number] | null {
  for (let i = 0; i < indexes.length; i++) {
    for (let j = i + 1; j < indexes.length; j++) {
      const a = evidence[indexes[i]!];
      const b = evidence[indexes[j]!];
      if (a && b && !rowsAreDistinguishable(a, b)) {
        return [indexes[i]!, indexes[j]!];
      }
    }
  }
  return null;
}

interface SummaryLink {
  summaryIndex: number | null;
  note: string;
}

function findSummaryLink(
  actionableIndex: number,
  evidence: RowEvidence[],
  nonActionableIndexes: number[]
): SummaryLink {
  const e = evidence[actionableIndex];
  if (!e) return { summaryIndex: null, note: "no evidence available" };

  const containment = e.descendantOfRowIndexes.filter((i) => nonActionableIndexes.includes(i));
  if (containment.length === 1) {
    return {
      summaryIndex: containment[0]!,
      note: `row ${actionableIndex} is a DOM descendant of row ${containment[0]} (parent/child containment)`,
    };
  }
  if (containment.length > 1) {
    return { summaryIndex: null, note: `row ${actionableIndex} is contained by multiple candidate rows` };
  }

  if (e.id) {
    const ariaCandidates = nonActionableIndexes.filter((i) => evidence[i]?.ariaControls === e.id);
    if (ariaCandidates.length === 1) {
      return {
        summaryIndex: ariaCandidates[0]!,
        note: `row ${ariaCandidates[0]} has aria-controls="${e.id}" referencing row ${actionableIndex}`,
      };
    }
    if (ariaCandidates.length > 1) {
      return { summaryIndex: null, note: `multiple rows reference row ${actionableIndex} via aria-controls` };
    }
  }

  const dataCandidates = e.sharedDataAttributeMatches.filter((m) =>
    nonActionableIndexes.includes(m.withRowIndex)
  );
  if (dataCandidates.length > 0) {
    const uniqueRows = [...new Set(dataCandidates.map((m) => m.withRowIndex))];
    if (uniqueRows.length === 1) {
      const m = dataCandidates[0]!;
      return {
        summaryIndex: uniqueRows[0]!,
        note: `row ${actionableIndex} shares data attribute ${m.attribute}="${m.value}" with row ${uniqueRows[0]}`,
      };
    }
    return { summaryIndex: null, note: `row ${actionableIndex} shares data attributes with multiple rows` };
  }

  const directAdjacency = e.adjacentRowIndexes.filter(
    (i) => nonActionableIndexes.includes(i) && e.symbol !== null && evidence[i]?.symbol === e.symbol
  );
  if (directAdjacency.length === 1) {
    return {
      summaryIndex: directAdjacency[0]!,
      note: `row ${actionableIndex} is DOM-adjacent to row ${directAdjacency[0]} and both show symbol ${e.symbol} (weak evidence: adjacency + symbol match only)`,
    };
  }

  // Weakest tier: nearest same-symbol non-actionable row in document order —
  // not necessarily a direct DOM sibling. This is what links multiple
  // actionable children listed consecutively after one summary row when
  // there is no containment/aria/data-attribute evidence at all.
  if (e.symbol !== null) {
    const sameSymbolSummaries = nonActionableIndexes.filter((i) => evidence[i]?.symbol === e.symbol);
    if (sameSymbolSummaries.length > 0) {
      const nearest = sameSymbolSummaries.reduce((best, i) =>
        Math.abs(i - actionableIndex) < Math.abs(best - actionableIndex) ? i : best
      );
      return {
        summaryIndex: nearest,
        note:
          `row ${actionableIndex} is the nearest row (in document order) to summary row ${nearest}, ` +
          `both showing symbol ${e.symbol} (weak evidence: document-order proximity + symbol match only)`,
      };
    }
  }

  return { summaryIndex: null, note: `no structural evidence links row ${actionableIndex} to any summary row` };
}

export function groupRows(evidence: RowEvidence[]): PositionGroup[] {
  const actionableIndexes = evidence.filter((e) => e.hasCloseControl).map((e) => e.rowIndex);
  const nonActionableIndexes = evidence.filter((e) => !e.hasCloseControl).map((e) => e.rowIndex);

  const summaryToActionable = new Map<number, number[]>();
  const summaryToNotes = new Map<number, string[]>();
  const standalone: { index: number; note: string }[] = [];

  for (const a of actionableIndexes) {
    const link = findSummaryLink(a, evidence, nonActionableIndexes);
    if (link.summaryIndex !== null) {
      const list = summaryToActionable.get(link.summaryIndex) ?? [];
      list.push(a);
      summaryToActionable.set(link.summaryIndex, list);
      const notes = summaryToNotes.get(link.summaryIndex) ?? [];
      notes.push(link.note);
      summaryToNotes.set(link.summaryIndex, notes);
    } else {
      standalone.push({ index: a, note: link.note });
    }
  }

  const groups: PositionGroup[] = [];
  let groupIndex = 0;

  for (const [summaryIndex, actionableList] of summaryToActionable) {
    const collision = findIndistinguishablePair(actionableList, evidence);
    groups.push({
      groupIndex: groupIndex++,
      symbol: evidence[actionableList[0]!]?.symbol ?? null,
      summaryRowIndex: summaryIndex,
      actionableChildRowIndexes: actionableList,
      ambiguous: collision !== null,
      ambiguityReason: collision
        ? `rows ${collision[0]} and ${collision[1]} share the same summary row (row ${summaryIndex}) but cannot be distinguished by opening price or value — cannot confirm these are separate lots.`
        : null,
      evidence: summaryToNotes.get(summaryIndex) ?? [],
    });
  }

  for (const { index, note } of standalone) {
    groups.push({
      groupIndex: groupIndex++,
      symbol: evidence[index]?.symbol ?? null,
      summaryRowIndex: null,
      actionableChildRowIndexes: [index],
      ambiguous: false,
      ambiguityReason: null,
      evidence: [note],
    });
  }

  // Cross-group symbol collision: groups that were never structurally
  // linked to a common summary but share a symbol. If their rows are all
  // pairwise distinguishable by opening price/value, treat them as
  // legitimately separate lots that simply lack a detected shared summary.
  // Otherwise, this is unresolved ambiguity — never assume either way.
  const bySymbol = new Map<string, PositionGroup[]>();
  for (const g of groups) {
    if (!g.symbol) continue;
    const list = bySymbol.get(g.symbol) ?? [];
    list.push(g);
    bySymbol.set(g.symbol, list);
  }
  for (const [symbol, list] of bySymbol) {
    if (list.length <= 1) continue;
    const allRowIndexes = list.flatMap((g) => g.actionableChildRowIndexes);
    const collision = findIndistinguishablePair(allRowIndexes, evidence);
    if (collision) {
      for (const g of list) {
        g.ambiguous = true;
        g.ambiguityReason = `${list.length} independent position groups found for symbol ${symbol}, and rows ${collision[0]}/${collision[1]} cannot be distinguished — cannot confirm whether these are the same or different positions.`;
      }
    }
  }

  return groups;
}
