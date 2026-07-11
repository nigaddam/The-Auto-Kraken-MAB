/** Read-only DOM diagnostics for validating parsing against a real Kraken
 * Prop page. Never clicks, never hovers (hovering can trigger tooltips or
 * other page interaction), and never reads cookies, localStorage,
 * sessionStorage, request headers, or full account identifiers — anything
 * that looks like one is redacted before this leaves the content script.
 */

import { SYMBOL_MAP } from "../api/symbols";
import { KRAKEN_PROP_URL_PATTERN } from "../shared/constants";
import type {
  CloseControlInfo,
  ControlInfo,
  DiagnosticsReport,
  PositionGroupDiagnostics,
  RowDiagnostics,
  RowDiscoveryMethod,
} from "../shared/types";
import { checkPageHealth } from "./page-health";
import {
  findPositionRows,
  findPositionsContainer,
  findCloseControlCandidates,
  resolveOwnedCloseControls,
  textOf,
} from "./kraken-dom";
import { extractRawPositionFields } from "./field-extraction";
import { computeRowEvidence, groupRows } from "./position-grouping";
import type { PositionGroup, RowEvidence } from "./position-grouping";
import { discoverRowsBySymbolAnchors } from "./row-discovery";
import { buildStructuralCensus } from "./structural-census";

const SUPPORTED_SYMBOLS = Object.keys(SYMBOL_MAP);

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ACCOUNT_LABEL_RE = /(account[\s:#-]*)([A-Za-z0-9_-]{4,})/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ACCOUNT_PATH_RE = /(\/account\/)([^/?#]+)/i;

export function sanitizeText(text: string, maxLength = 200): string {
  let sanitized = text
    .replace(UUID_RE, "[REDACTED_ID]")
    .replace(ACCOUNT_LABEL_RE, "$1[REDACTED]")
    .replace(EMAIL_RE, "[REDACTED_EMAIL]");
  if (sanitized.length > maxLength) {
    sanitized = `${sanitized.slice(0, maxLength)}…`;
  }
  return sanitized;
}

function redactUrl(url: string): string {
  return sanitizeText(url.replace(ACCOUNT_PATH_RE, "$1[REDACTED_ACCOUNT_ID]"), 300);
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function buildEvidenceStrings(e: RowEvidence): string[] {
  const notes: string[] = [];
  if (e.ancestorOfRowIndexes.length) notes.push(`DOM ancestor of row(s): ${e.ancestorOfRowIndexes.join(", ")}`);
  if (e.descendantOfRowIndexes.length)
    notes.push(`DOM descendant of row(s): ${e.descendantOfRowIndexes.join(", ")}`);
  if (e.ariaExpanded !== null) notes.push(`aria-expanded="${e.ariaExpanded}"`);
  if (e.ariaControls !== null) notes.push(`aria-controls="${e.ariaControls}"`);
  for (const m of e.sharedDataAttributeMatches) {
    notes.push(`shares data attribute ${m.attribute}="${m.value}" with row ${m.withRowIndex}`);
  }
  if (e.adjacentRowIndexes.length) notes.push(`DOM-adjacent to row(s): ${e.adjacentRowIndexes.join(", ")}`);
  if (notes.length === 0) notes.push("no structural relationship evidence found for this row");
  return notes;
}

export function buildCloseControlInfo(control: Element, candidateCount = 1): CloseControlInfo {
  const ariaLabel = control.getAttribute("aria-label");
  const title = control.getAttribute("title");
  const visibleText = textOf(control);
  const dataTestId = control.getAttribute("data-testid");
  const role = control.getAttribute("role");
  const accessibleNameAvailableWithoutHover = Boolean(
    ariaLabel ?? title ?? (visibleText.length > 0 ? visibleText : null)
  );
  const accessibleName = ariaLabel ?? title ?? (visibleText.length > 0 ? sanitizeText(visibleText, 80) : null);
  const roleIsButton = role === "button" || control.tagName.toLowerCase() === "button";
  const highConfidence = candidateCount === 1 && accessibleNameAvailableWithoutHover && roleIsButton;

  return {
    ariaLabelPresent: Boolean(ariaLabel),
    titlePresent: Boolean(title),
    accessibleNameAvailableWithoutHover,
    accessibleName,
    dataTestId,
    roleIsButton,
    candidateCount,
    confidence: highConfidence ? "HIGH" : "LOW",
    ambiguityReason: highConfidence
      ? null
      : candidateCount !== 1
        ? `${candidateCount} close-control candidates found for this row.`
        : "Close control lacks a non-hover accessible name or button semantics.",
    note: accessibleNameAvailableWithoutHover
      ? "Accessible name is available without hovering."
      : "No aria-label, title, or visible text found. This looks like an icon-only control — its accessible " +
        "name may only be exposed via a hover tooltip. Diagnostics does not hover automatically; report this so " +
        "the real close-control selector can be chosen deliberately once a stable attribute is identified.",
  };
}

function buildControls(row: Element): ControlInfo[] {
  const nodes = Array.from(
    row.querySelectorAll<Element>('button, [role="button"], a, [role="menuitem"], [tabindex]')
  );
  return nodes.slice(0, 15).map((el) => ({
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role"),
    ariaLabel: el.getAttribute("aria-label") ? sanitizeText(el.getAttribute("aria-label")!, 80) : null,
    title: el.getAttribute("title") ? sanitizeText(el.getAttribute("title")!, 80) : null,
    visibleText: sanitizeText(textOf(el), 80),
    dataTestId: el.getAttribute("data-testid"),
  }));
}

function buildRowDiagnostics(
  row: Element,
  index: number,
  evidence: RowEvidence,
  ownedCloseControl: Element | null
): RowDiagnostics {
  const fields = extractRawPositionFields(row);
  const candidateCount = findCloseControlCandidates(row).length;

  return {
    index,
    rawVisibleText: sanitizeText(textOf(row)),
    parsedSymbol: fields.symbol ?? "UNKNOWN",
    parsedSide: fields.side ?? "UNKNOWN",
    parsedValue: fields.valueUsd ?? "UNKNOWN",
    parsedOpeningPrice: fields.entryPrice ?? "UNKNOWN",
    parsedCurrentPrice: fields.currentPriceUi ?? "UNKNOWN",
    parsedUpnl: fields.upnl ?? "UNKNOWN",
    parsedNetPnl: fields.netPnl ?? "UNKNOWN",
    leverage: fields.leverage ?? "UNKNOWN",
    hasCloseControl: ownedCloseControl !== null,
    closeControlInfo: ownedCloseControl ? buildCloseControlInfo(ownedCloseControl, candidateCount) : null,
    controls: buildControls(row),
    groupingEvidence: buildEvidenceStrings(evidence),
  };
}

function toGroupDiagnostics(g: PositionGroup): PositionGroupDiagnostics {
  return {
    groupId: g.groupIndex,
    symbol: g.symbol ?? "UNKNOWN",
    summaryRowIndex: g.summaryRowIndex,
    actionableChildRowIndexes: g.actionableChildRowIndexes,
    ambiguous: g.ambiguous,
    ambiguityReason: g.ambiguityReason,
    evidence: g.evidence,
  };
}

function portfolioHeadingPresent(root: ParentNode): boolean {
  const headings = Array.from(root.querySelectorAll("h1, h2, h3, h4"));
  return headings.some((h) => /portfolio/i.test(textOf(h)));
}

/** Prefers the semantic role/tr-based approach; falls back to the
 * text-anchor discovery (row-discovery.ts) only when semantics find
 * nothing at all — which is what happens against Kraken's real,
 * non-table-based Positions markup. Reports which one actually worked. */
function resolveCandidateRows(container: Element): {
  rows: Element[];
  discoveryMethod: RowDiscoveryMethod;
} {
  const semanticRows = findPositionRows(container);
  if (semanticRows.length > 0) {
    return { rows: semanticRows, discoveryMethod: "SEMANTIC_ROLES" };
  }

  const discovered = discoverRowsBySymbolAnchors(container, SUPPORTED_SYMBOLS);
  if (discovered.length > 0) {
    return { rows: discovered.map((d) => d.element), discoveryMethod: "TEXT_ANCHOR_FALLBACK" };
  }

  return { rows: [], discoveryMethod: "NONE" };
}

export function runDiagnostics(root: ParentNode, url: string): DiagnosticsReport {
  const health = checkPageHealth(root, url);
  const container = findPositionsContainer(root);
  const { rows: candidateRows, discoveryMethod } = container
    ? resolveCandidateRows(container)
    : { rows: [] as Element[], discoveryMethod: "NONE" as RowDiscoveryMethod };

  const evidence = computeRowEvidence(candidateRows);
  const ownedCloseControls = resolveOwnedCloseControls(candidateRows);
  const groups = groupRows(evidence);
  const parsedPositionCount = groups.reduce(
    (sum, g) => (g.ambiguous ? sum : sum + g.actionableChildRowIndexes.length),
    0
  );

  // Never infer logged-out merely because nothing parsed; DO upgrade to
  // logged-in on strong positive evidence (real position rows resolved).
  let loggedInState: "YES" | "NO" | "UNKNOWN";
  if (health.sessionState === "LOGGED_OUT") {
    loggedInState = "NO";
  } else if (health.sessionState === "LOGGED_IN" || candidateRows.length > 0) {
    loggedInState = "YES";
  } else {
    loggedInState = "UNKNOWN";
  }

  const structuralCensus = container
    ? buildStructuralCensus(container, SUPPORTED_SYMBOLS)
    : {
        totalDivCount: 0,
        roledElementCount: 0,
        roleValueCounts: {},
        keywordElementCounts: {},
        distinctDataAttributeNames: [],
        multiNumericFieldElementCount: 0,
        longShortTextAnchors: [],
        symbolTextAnchors: [],
      };

  return {
    generatedAt: Date.now(),
    url: redactUrl(url),
    currentPageDetected: true,
    krakenDomainDetected: /(^|\.)kraken\.com$/i.test(safeHostname(url)),
    propUrlDetected: url.startsWith(KRAKEN_PROP_URL_PATTERN.replace(/\*$/, "")),
    portfolioPageDetected: /portfolio/i.test(url) || portfolioHeadingPresent(root),
    loggedInState,
    positionsSectionDetected: container !== null,
    candidateRowCount: candidateRows.length,
    parsedPositionCount,
    rowDiscoveryMethod: discoveryMethod,
    rows: candidateRows.map((row, i) => buildRowDiagnostics(row, i, evidence[i]!, ownedCloseControls[i]!)),
    groups: groups.map(toGroupDiagnostics),
    structuralCensus,
  };
}
