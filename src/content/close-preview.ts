import { computeFingerprint } from "../strategy/state-machine";
import type { CloseControlInfo, CloseModalValidation, PreviewCloseReport } from "../shared/types";
import { buildCloseControlInfo } from "./diagnostics";
import { findCloseControlCandidates, findPositionsContainer, resolveOwnedCloseControls } from "./kraken-dom";
import { computeRowEvidence } from "./position-grouping";
import { parsePositionRow, resolveActionableRows } from "./position-parser";

const HIGHLIGHT_ATTR = "data-kraken-guard-preview";
const HIGHLIGHT_STYLE_ID = "kraken-guard-preview-style";
const PREVIEW_MS = 15_000;
const MODAL_WAIT_MS = 5_000;
const MODAL_POLL_MS = 150;

function ensureHighlightStyle(): void {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
    [${HIGHLIGHT_ATTR}="row"] {
      outline: 2px solid #2563eb !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.18) !important;
    }
    [${HIGHLIGHT_ATTR}="control"] {
      outline: 2px solid #dc2626 !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 4px rgba(220, 38, 38, 0.18) !important;
    }
  `;
  document.documentElement.append(style);
}

function clearPreviewHighlights(): void {
  document.querySelectorAll(`[${HIGHLIGHT_ATTR}]`).forEach((el) => el.removeAttribute(HIGHLIGHT_ATTR));
}

function compactText(el: Element | Document): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Best-effort dismissal for a Kraken close dialog this extension itself
 * opened but then decided NOT to confirm (validation failed). Deliberately
 * never clicks any button inside the modal — that risks hitting the wrong
 * control — instead dispatches the standard Escape keydown that virtually
 * all accessible (role="dialog"/aria-modal) implementations respect for
 * dismissal. If Kraken's dialog doesn't honor it, this is a no-op; it never
 * makes things worse than leaving the dialog open, which is today's
 * behavior. Also matters for a second reason: some SPA modal
 * implementations unmount the underlying positions table while their own
 * dialog is open, so a dangling dialog can make the next position scan
 * wrongly read zero positions until the dialog is dismissed. */
export function dismissOpenModal(): void {
  const escEvent = new KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    keyCode: 27,
    which: 27,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(escEvent);
}

function findModalCandidates(root: ParentNode): Element[] {
  return Array.from(
    root.querySelectorAll<Element>(
      '[role="dialog"], [aria-modal="true"], [data-testid*="modal" i], [data-testid*="dialog" i]'
    )
  ).filter((el) => compactText(el).length > 0);
}

function findFinalCloseControls(modal: Element, symbol: string): HTMLElement[] {
  const symbolUpper = symbol.toUpperCase();
  const controls = Array.from(modal.querySelectorAll<HTMLElement>('button, [role="button"]'));
  return controls.filter((control) => {
    const text = compactText(control);
    const label = control.getAttribute("aria-label") ?? control.getAttribute("title") ?? text;
    if (!label) return false;
    return (
      new RegExp(`\\bclose\\s+${symbolUpper}\\s+long\\s+position\\b`, "i").test(label) ||
      (/\bclose\b/i.test(label) && new RegExp(`\\b${symbolUpper}\\b`, "i").test(label))
    );
  });
}

export function validateCloseModal(root: ParentNode, symbol: string): CloseModalValidation {
  const candidates = findModalCandidates(root);
  const symbolUpper = symbol.toUpperCase();
  const matching = candidates.filter((modal) => new RegExp(`\\b${symbolUpper}\\b`, "i").test(compactText(modal)));

  const base = {
    modalFound: matching.length > 0,
    titleMatched: false,
    symbolMatched: matching.length === 1,
    sideMatched: false,
    closeActionMatched: false,
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
      modalTextExcerpt: candidates.map((modal) => compactText(modal).slice(0, 160)).join(" | "),
      symbolEvidence: null,
      actionEvidence: null,
      quantityEvidence: null,
      finalControlText: null,
    };
  }

  const modal = matching[0]!;
  const text = compactText(modal);
  const titleMatched = Array.from(modal.querySelectorAll("h1, h2, h3, [role='heading']"))
    .some((heading) => /^close position$/i.test(compactText(heading)));
  const sideMatched = new RegExp(`\\blong\\s+${symbolUpper}\\b`, "i").test(text);
  const sellToCloseMatched = new RegExp(`\\bsell\\s+[\\d,.]+\\s+${symbolUpper}\\b`, "i").test(text);
  const quantityMatch = text.match(new RegExp(`\\b([\\d,.]+)\\s+${symbolUpper}\\b`, "i"));
  const quantityMatched = quantityMatch !== null;
  const finalControls = findFinalCloseControls(modal, symbolUpper);
  const finalControl = finalControls.length === 1 ? finalControls[0]! : null;
  const finalButtonMatched = finalControl !== null;
  const closeActionMatched = titleMatched || sellToCloseMatched || finalButtonMatched;
  const conflictingActionFound = /\b(open\s+short|increase|add\s+(margin|position|size)|new\s+short|buy\s+[,\d.]*\s*[A-Z0-9]+|change\s+leverage)\b/i.test(text);
  const evidence = {
    modalFound: true,
    titleMatched,
    symbolMatched: true,
    sideMatched,
    closeActionMatched,
    quantityMatched,
    finalButtonMatched,
    conflictingActionFound,
    confidence:
      titleMatched && sideMatched && closeActionMatched && quantityMatched && finalButtonMatched && !conflictingActionFound
        ? "HIGH" as const
        : "LOW" as const,
  };

  if (!closeActionMatched) {
    return {
      ...evidence,
      ready: false,
      blockedReason: "Modal does not contain positive close/sell-to-close action evidence.",
      modalTextExcerpt: text.slice(0, 240),
      symbolEvidence: symbolUpper,
      actionEvidence: null,
      quantityEvidence: quantityMatch?.[0] ?? null,
      finalControlText: finalControl ? compactText(finalControl) : null,
    };
  }
  if (conflictingActionFound) {
    return {
      ...evidence,
      ready: false,
      blockedReason: "Modal contains open/increase/add exposure wording.",
      modalTextExcerpt: text.slice(0, 240),
      symbolEvidence: symbolUpper,
      actionEvidence: sellToCloseMatched ? `Sell ${symbolUpper}` : "close",
      quantityEvidence: quantityMatch?.[0] ?? null,
      finalControlText: finalControl ? compactText(finalControl) : null,
    };
  }
  if (!finalControl) {
    return {
      ...evidence,
      ready: false,
      blockedReason: `${finalControls.length} matching final close button(s) found; expected exactly one.`,
      modalTextExcerpt: text.slice(0, 240),
      symbolEvidence: symbolUpper,
      actionEvidence: sellToCloseMatched ? `Sell ${symbolUpper}` : "close",
      quantityEvidence: quantityMatch?.[0] ?? null,
      finalControlText: null,
    };
  }
  if (!sideMatched) {
    return {
      ...evidence,
      ready: false,
      blockedReason: `Modal does not identify an existing Long ${symbolUpper} position.`,
      modalTextExcerpt: text.slice(0, 240),
      symbolEvidence: symbolUpper,
      actionEvidence: sellToCloseMatched ? `Sell ${symbolUpper}` : "close",
      quantityEvidence: quantityMatch?.[0] ?? null,
      finalControlText: compactText(finalControl) || finalControl.getAttribute("aria-label") || null,
    };
  }

  return {
    ...evidence,
    ready: true,
    blockedReason: null,
    modalTextExcerpt: text.slice(0, 240),
    symbolEvidence: symbolUpper,
    actionEvidence: sellToCloseMatched ? `Sell ${symbolUpper}` : "close",
    quantityEvidence: quantityMatch?.[0] ?? null,
    finalControlText: compactText(finalControl) || finalControl.getAttribute("aria-label") || null,
  };
}

async function waitForCloseModal(root: ParentNode, symbol: string): Promise<CloseModalValidation> {
  const deadline = Date.now() + MODAL_WAIT_MS;
  let latest = validateCloseModal(root, symbol);
  while (!latest.ready && Date.now() < deadline) {
    await sleep(MODAL_POLL_MS);
    latest = validateCloseModal(root, symbol);
  }
  return latest;
}

export function confirmValidatedCloseModal(root: ParentNode, symbol: string): {
  validation: CloseModalValidation;
  clicked: boolean;
} {
  const validation = validateCloseModal(root, symbol);
  if (!validation.ready) {
    dismissOpenModal();
    return { validation, clicked: false };
  }
  const modal = findModalCandidates(root).find((candidate) =>
    new RegExp(`\\b${symbol.toUpperCase()}\\b`, "i").test(compactText(candidate))
  );
  const controls = modal ? findFinalCloseControls(modal, symbol) : [];
  if (controls.length !== 1) {
    dismissOpenModal();
    return {
      validation: {
        ...validation,
        ready: false,
        finalButtonMatched: false,
        confidence: "LOW",
        blockedReason: `${controls.length} matching final close button(s) found at submit time; expected exactly one.`,
      },
      clicked: false,
    };
  }
  controls[0]!.click();
  return { validation, clicked: true };
}

function groupEvidenceForRow(rowIndex: number, evidence: ReturnType<typeof computeRowEvidence>): string[] {
  const rowEvidence = evidence[rowIndex];
  if (!rowEvidence) return ["No row evidence found."];
  const notes: string[] = [];
  if (rowEvidence.descendantOfRowIndexes.length) {
    notes.push(`contained by candidate row(s): ${rowEvidence.descendantOfRowIndexes.join(", ")}`);
  }
  if (rowEvidence.ancestorOfRowIndexes.length) {
    notes.push(`contains candidate row(s): ${rowEvidence.ancestorOfRowIndexes.join(", ")}`);
  }
  if (rowEvidence.sharedDataAttributeMatches.length) {
    notes.push(
      rowEvidence.sharedDataAttributeMatches
        .map((m) => `shares ${m.attribute}="${m.value}" with row ${m.withRowIndex}`)
        .join("; ")
    );
  }
  if (rowEvidence.adjacentRowIndexes.length) {
    notes.push(`adjacent to row(s): ${rowEvidence.adjacentRowIndexes.join(", ")}`);
  }
  if (notes.length === 0) notes.push("standalone actionable row; no summary-row ownership assumed");
  return notes;
}

interface ResolvedCloseTarget {
  report: PreviewCloseReport;
  row: Element;
  control: Element;
}

function resolveCloseTarget(
  root: ParentNode,
  fingerprint: string,
  symbol: string,
  lotLabel: string | null
): ResolvedCloseTarget | PreviewCloseReport {
  clearPreviewHighlights();

  const blocked = (
    reason: string,
    rowEvidence: string[] = [],
    closeControl: CloseControlInfo | null = null
  ): PreviewCloseReport => ({
    fingerprint,
    symbol,
    lotLabel,
    ready: false,
    blockedReason: reason,
    rowEvidence,
    closeControl,
    highlightedUntil: null,
  });

  const container = findPositionsContainer(root);
  if (!container) return blocked("Open positions container was not found.");

  const { rows } = resolveActionableRows(container);
  const parsedRows = rows
    .map((row, index) => ({ row, index, parsed: parsePositionRow(row) }))
    .filter((item): item is { row: Element; index: number; parsed: NonNullable<typeof item.parsed> } => item.parsed !== null);
  const matches = parsedRows.filter((item) => computeFingerprint(item.parsed) === fingerprint);
  if (matches.length !== 1) {
    return blocked(`${matches.length} rows matched fingerprint ${fingerprint}; expected exactly one.`);
  }

  const match = matches[0]!;
  if (match.parsed.symbol !== symbol.toUpperCase()) {
    return blocked(`Matched row symbol ${match.parsed.symbol} did not equal requested symbol ${symbol}.`);
  }

  const ownedControls = resolveOwnedCloseControls(rows);
  const owned = ownedControls[match.index] ?? null;
  const candidateCount = findCloseControlCandidates(match.row).length;
  const evidence = computeRowEvidence(rows);
  const rowEvidence = groupEvidenceForRow(match.index, evidence);

  if (!owned) {
    return blocked("No row-owned close control was found for this exact lot.", rowEvidence);
  }

  const info = buildCloseControlInfo(owned, candidateCount);
  if (info.confidence !== "HIGH") {
    return blocked(info.ambiguityReason ?? "Close-control ownership confidence is not high.", rowEvidence, info);
  }

  ensureHighlightStyle();
  match.row.setAttribute(HIGHLIGHT_ATTR, "row");
  owned.setAttribute(HIGHLIGHT_ATTR, "control");
  match.row.scrollIntoView({ block: "center", inline: "nearest" });
  window.setTimeout(clearPreviewHighlights, PREVIEW_MS);

  const report = {
    fingerprint,
    symbol,
    lotLabel,
    ready: true,
    blockedReason: null,
    rowEvidence,
    closeControl: info,
    highlightedUntil: Date.now() + PREVIEW_MS,
  };
  return { report, row: match.row, control: owned };
}

export function previewClosePosition(
  root: ParentNode,
  fingerprint: string,
  symbol: string,
  lotLabel: string | null
): PreviewCloseReport {
  const resolved = resolveCloseTarget(root, fingerprint, symbol, lotLabel);
  return "report" in resolved ? resolved.report : resolved;
}

export function openKrakenCloseDialog(
  root: ParentNode,
  fingerprint: string,
  symbol: string,
  lotLabel: string | null
): Promise<PreviewCloseReport> {
  const resolved = resolveCloseTarget(root, fingerprint, symbol, lotLabel);
  if (!("report" in resolved)) return Promise.resolve(resolved);

  const control = resolved.control;
  if (!(control instanceof HTMLElement)) {
    return Promise.resolve({
      ...resolved.report,
      ready: false,
      blockedReason: "Resolved close control is not an HTMLElement and cannot be clicked safely.",
    });
  }

  control.focus();
  control.click();
  return waitForCloseModal(root, symbol).then((modalValidation) => {
    if (!modalValidation.ready) {
      // Never leave a dialog this extension itself opened sitting on the
      // page unattended after deciding not to confirm it.
      dismissOpenModal();
    }
    return {
      ...resolved.report,
      ready: modalValidation.ready,
      blockedReason: modalValidation.blockedReason,
      modalValidation,
    };
  });
}
