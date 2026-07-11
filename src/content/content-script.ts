import type { ScanResultMessage } from "../shared/messages";
import { isExtensionMessage } from "../shared/messages";
import { confirmValidatedCloseModal, openKrakenCloseDialog, previewClosePosition, validateCloseModal } from "./close-preview";
import { runDiagnostics } from "./diagnostics";
import { checkPageHealth } from "./page-health";
import { parsePositionsFromDocument } from "./position-parser";

// This content script never fills in credentials, never automates
// login/2FA/CAPTCHA, and never opens/increases exposure. The only trade
// controls it may click are validated close controls after explicit arming
// or manual confirmation.

function buildScanResult(): ScanResultMessage {
  const { positions, unparsedRowCount, candidateRowCount, discoveryMethod } =
    parsePositionsFromDocument(document);
  const pageHealth = checkPageHealth(document, window.location.href, positions.length > 0);

  if (unparsedRowCount > 0) {
    console.warn(
      `[kraken-guard] ${unparsedRowCount} position row(s) detected but could not be parsed with confidence.`
    );
  }

  return {
    type: "POSITIONS_SCAN_RESULT",
    positions,
    pageHealth,
    candidateRowCount,
    rowDiscoveryMethod: discoveryMethod,
  };
}

function scanAndReport(): void {
  const message = buildScanResult();
  chrome.runtime.sendMessage(message).catch(() => {
    // Service worker may be asleep between messages; it will ask again on
    // its next alarm tick via REQUEST_SCAN.
  });
}

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (response?: unknown) => void) => {
    if (!isExtensionMessage(message)) return undefined;

    if (message.type === "REQUEST_SCAN") {
      sendResponse(buildScanResult());
      return undefined;
    }

    if (message.type === "RUN_DOM_DIAGNOSTICS") {
      const report = runDiagnostics(document, window.location.href);
      console.log("[kraken-guard] DOM diagnostics report (sanitized):", report);
      sendResponse({ type: "DOM_DIAGNOSTICS_RESULT", report, error: null });
      // Diagnostics is a superset of a regular scan — also refresh the
      // normal pipeline's state (page health, positions) so running
      // diagnostics alone (without ever pressing Start Monitoring) still
      // marks the tab connected and keeps everything else up to date.
      scanAndReport();
      return undefined; // responded synchronously; no need to keep the channel open
    }

    if (message.type === "PREVIEW_CLOSE") {
      const report = previewClosePosition(
        document,
        message.fingerprint,
        message.symbol,
        message.lotLabel ?? null
      );
      sendResponse({ type: "PREVIEW_CLOSE_RESULT", report, error: null });
      return undefined;
    }

    if (message.type === "OPEN_CLOSE_DIALOG") {
      void openKrakenCloseDialog(document, message.fingerprint, message.symbol, message.lotLabel ?? null)
        .then((report) => sendResponse({ type: "OPEN_CLOSE_DIALOG_RESULT", report, error: null }))
        .catch((err) =>
          sendResponse({ type: "OPEN_CLOSE_DIALOG_RESULT", report: null, error: String(err) })
        );
      return true;
    }

    if (message.type === "CONFIRM_CLOSE_DIALOG") {
      try {
        const result = confirmValidatedCloseModal(document, message.symbol);
        sendResponse({
          type: "CONFIRM_CLOSE_DIALOG_RESULT",
          modalValidation: result.validation,
          clicked: result.clicked,
          error: null,
        });
      } catch (err) {
        sendResponse({
          type: "CONFIRM_CLOSE_DIALOG_RESULT",
          modalValidation: null,
          clicked: false,
          error: String(err),
        });
      }
      return undefined;
    }

    if (message.type === "CLOSE_MODAL_STATUS") {
      const validation = validateCloseModal(document, message.symbol);
      const text = (document.body.textContent ?? "").replace(/\s+/g, " ").trim();
      sendResponse({
        type: "CLOSE_MODAL_STATUS_RESULT",
        modalOpen: validation.modalFound,
        successFeedback: /\b(position|order)\s+(closed|submitted|filled|placed)\b/i.test(text),
        error: null,
      });
      return undefined;
    }

    return undefined;
  }
);

// Initial scan so the side panel has data without waiting for the next poll.
scanAndReport();
