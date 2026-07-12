import { isExtensionMessage } from "../shared/messages";
import type { GetStateMessage } from "../shared/messages";
import type {
  DiagnosticsReport,
  OperatingMode,
  OrderFormDiagnosticsReport,
  RuntimeState,
  Settings,
  TrackedPosition,
} from "../shared/types";
import { getAuditLog } from "../storage/audit-log";
import { computeDailyGoalProgress } from "../strategy/daily-goal";
import {
  renderAppHeader,
  renderControlsPanel,
  renderDailyGoalCard,
  renderDiagnosticsSection,
  renderInterestedCoinsPanel,
  renderLogsSection,
  renderOrderFormDiagnosticsSection,
  renderPositionsSection,
  renderSettingsPanel,
  renderStatusPanel,
  renderTabBar,
  renderTabPanel,
  currentPnl,
  type ManualBuyUiState,
  type ManualCloseUiState,
  type PreviewCloseUiState,
  type TabId,
} from "./components";

const SELECTED_TAB_KEY = "kraken_guard_selected_tab";

const app = document.getElementById("app");
if (!app) {
  throw new Error("sidepanel.html is missing #app");
}

let latestState: RuntimeState | null = null;
let latestDiagnosticsReport: DiagnosticsReport | null = null;
let latestDiagnosticsError: string | null = null;
let latestOrderFormDiagnosticsReport: OrderFormDiagnosticsReport | null = null;
let latestOrderFormDiagnosticsError: string | null = null;
let selectedTab: TabId = "positions";
let previewCloseState: PreviewCloseUiState = { message: null, error: null };
let manualCloseState: ManualCloseUiState = { pending: null };
let manualBuyState: ManualBuyUiState = { pending: null };
let manualBuyMessage: { message: string | null; error: string | null } = { message: null, error: null };

function isTabId(value: unknown): value is TabId {
  return value === "positions" || value === "market" || value === "notifications" || value === "settings";
}

async function loadSelectedTab(): Promise<void> {
  const stored = await chrome.storage.local.get(SELECTED_TAB_KEY);
  const value: unknown = stored[SELECTED_TAB_KEY];
  selectedTab = isTabId(value) ? value : "positions";
}

async function selectTab(tab: TabId): Promise<void> {
  selectedTab = tab;
  await chrome.storage.local.set({ [SELECTED_TAB_KEY]: tab });
  await render();
}

async function render(): Promise<void> {
  if (!app || !latestState) return;
  const state = latestState;
  const now = Date.now();

  app.replaceChildren();

  const logs = await getAuditLog();
  const controls = {
    onSetOperatingMode: (mode: OperatingMode) => void setOperatingMode(mode),
    onRefresh: () => void sendAndRefresh({ type: "REFRESH_POSITIONS" }),
    onTestNotification: () => void sendAndRefresh({ type: "TEST_NOTIFICATION" }),
    onExportLogs: () => void exportLogs(),
    onRunDiagnostics: () => void runDiagnosticsAndRender(),
    onPreviewClose: (position: TrackedPosition, lotLabel: string | null) =>
      void previewClose(position.fingerprint, position.symbol, lotLabel),
    onRequestManualClose: (position: TrackedPosition, lotLabel: string | null) =>
      void requestManualClose(position, lotLabel),
    onCancelManualClose: () => {
      manualCloseState = { pending: null };
      previewCloseState = { message: "Manual close cancelled.", error: null };
      void render();
    },
    onContinueManualClose: () => void continueManualClose(),
    onConfirmManualClose: () => void confirmManualClose(),
    onUpdateWatchlist: (symbols: string[]) => void updateWatchlist(symbols),
    onRequestManualBuy: (symbol: string, quantityUnits: number, currentPrice: number | null) =>
      requestManualBuy(symbol, quantityUnits, currentPrice),
    onUpdateManualBuyQuantity: (quantityUnits: number) => updateManualBuyQuantity(quantityUnits),
    onCancelManualBuy: () => {
      manualBuyState = { pending: null };
      manualBuyMessage = { message: "Test buy cancelled.", error: null };
      void render();
    },
    onContinueManualBuy: () => void continueManualBuy(),
    onConfirmManualBuy: () => void confirmManualBuy(),
    onClearLogs: () => void clearLogsWithConfirmation(),
  };

  app.append(renderAppHeader(state), renderTabBar(selectedTab, (tab) => void selectTab(tab)));

  if (selectedTab === "positions") {
    const dayStartMs = new Date().setHours(0, 0, 0, 0);
    const realizedPnlTodayUsd = logs
      .filter(
        (entry) =>
          (entry.eventType === "AUTO_CLOSE_SUCCEEDED" ||
            entry.eventType === "MANUAL_POSITION_CLOSE_SUCCEEDED") &&
          entry.timestamp >= dayStartMs &&
          entry.realizedPnlUsd !== null
      )
      .reduce((sum, entry) => sum + (entry.realizedPnlUsd ?? 0), 0);
    const goal = computeDailyGoalProgress({
      accountEquityUsd: state.accountEquityUsd,
      dailyGoalPct: state.settings.dailyGoalPct,
      realizedPnlTodayUsd,
      unrealizedPnlUsd: currentPnl(state),
    });
    app.append(
      renderTabPanel("positions", [
        renderPositionsSection(state, now, controls, previewCloseState, manualCloseState),
        renderDailyGoalCard({ ...goal, dailyGoalPct: state.settings.dailyGoalPct }),
        renderStatusPanel(state, now),
        renderControlsPanel(state, controls),
      ])
    );
  } else if (selectedTab === "market") {
    app.append(
      renderTabPanel("market", [
        renderInterestedCoinsPanel(state, now, controls, manualBuyState, manualBuyMessage),
      ])
    );
  } else if (selectedTab === "notifications") {
    app.append(renderTabPanel("notifications", [renderLogsSection(logs, controls, state)]));
  } else {
    const children = [
      renderSettingsPanel(state, {
        onSaveSettings: (settings) => void saveSettings(settings),
        onResetSettings: () => void resetSettings(),
        onRunDiagnostics: () => void runDiagnosticsAndRender(),
        onRunOrderFormDiagnostics: () => void runOrderFormDiagnosticsAndRender(),
        onExportLogs: () => void exportLogs(),
      }),
    ];
    if (latestDiagnosticsReport || latestDiagnosticsError) {
      children.push(
        renderDiagnosticsSection(latestDiagnosticsReport, latestDiagnosticsError, () =>
          void copyDiagnosticsToClipboard()
        )
      );
    }
    if (latestOrderFormDiagnosticsReport || latestOrderFormDiagnosticsError) {
      children.push(
        renderOrderFormDiagnosticsSection(latestOrderFormDiagnosticsReport, latestOrderFormDiagnosticsError, () =>
          void copyOrderFormDiagnosticsToClipboard()
        )
      );
    }
    app.append(renderTabPanel("settings", children));
  }
}

async function sendAndRefresh(message: { type: string; [key: string]: unknown }): Promise<void> {
  await chrome.runtime.sendMessage(message);
  await requestState();
}

/** The single Off/Cruise/Autopilot toggle — no prompt()/confirm() ceremony.
 * Autopilot's preflight blockers (if any) surface via the existing
 * non-modal preflight card on the Positions tab instead of a dialog. */
async function setOperatingMode(mode: OperatingMode): Promise<void> {
  await sendAndRefresh({ type: "SET_OPERATING_MODE", mode });
}

async function requestState(): Promise<void> {
  const message: GetStateMessage = { type: "GET_STATE" };
  const response: unknown = await chrome.runtime.sendMessage(message);
  if (isExtensionMessage(response) && response.type === "STATE_SNAPSHOT") {
    latestState = response.state;
    await render();
  }
}

async function exportLogs(): Promise<void> {
  const response: unknown = await chrome.runtime.sendMessage({ type: "EXPORT_LOGS" });
  if (!isExtensionMessage(response) || response.type !== "EXPORT_LOGS_RESULT") return;

  const blob = new Blob([response.json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `kraken-guard-audit-log-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function clearLogsWithConfirmation(): Promise<void> {
  if (!confirm("Clear local activity history? This only removes the extension audit log.")) return;
  await sendAndRefresh({ type: "CLEAR_LOGS" });
}

/** No panel displays market-refresh progress/errors anymore (the Market
 * Data table was removed — Positions already shows equivalent per-symbol
 * data for anything you hold), so this just fires the refresh and lets the
 * subsequent state broadcast update the UI. */
async function refreshMarketData(): Promise<void> {
  await chrome.runtime.sendMessage({ type: "REFRESH_MARKET_DATA" });
  await requestState();
}

async function saveSettings(settings: Settings): Promise<void> {
  await sendAndRefresh({ type: "UPDATE_SETTINGS", settings });
  // Same reasoning as updateWatchlist: a newly-added watchlist symbol
  // shouldn't have to wait for the next scheduled refresh to show data.
  await refreshMarketData();
}

/** Symbols with an open position are never included here — they're tracked
 * automatically and don't consume a manual watchlist slot (see
 * renderInterestedCoinsPanel's slot accounting). Immediately triggers a
 * market-data refresh afterward so a newly-added symbol shows real data
 * right away instead of sitting at "not available yet" until the next
 * scheduled refresh (up to marketRefreshMinutes later). */
async function updateWatchlist(symbols: string[]): Promise<void> {
  if (!latestState) return;
  await sendAndRefresh({
    type: "UPDATE_SETTINGS",
    settings: { ...latestState.settings, watchlistCoins: symbols },
  });
  await refreshMarketData();
}

async function resetSettings(): Promise<void> {
  await sendAndRefresh({ type: "RESET_SETTINGS" });
}

async function runDiagnosticsAndRender(): Promise<void> {
  const response: unknown = await chrome.runtime.sendMessage({ type: "RUN_DOM_DIAGNOSTICS" });
  if (isExtensionMessage(response) && response.type === "DOM_DIAGNOSTICS_RESULT") {
    latestDiagnosticsReport = response.report;
    latestDiagnosticsError = response.error;
  } else {
    latestDiagnosticsReport = null;
    latestDiagnosticsError = "Unexpected response while running diagnostics.";
  }
  await render();
}

async function runOrderFormDiagnosticsAndRender(): Promise<void> {
  const response: unknown = await chrome.runtime.sendMessage({ type: "RUN_ORDER_FORM_DIAGNOSTICS" });
  if (isExtensionMessage(response) && response.type === "ORDER_FORM_DIAGNOSTICS_RESULT") {
    latestOrderFormDiagnosticsReport = response.report;
    latestOrderFormDiagnosticsError = response.error;
  } else {
    latestOrderFormDiagnosticsReport = null;
    latestOrderFormDiagnosticsError = "Unexpected response while running order-form diagnostics.";
  }
  await render();
}

async function previewClose(fingerprint: string, symbol: string, lotLabel: string | null): Promise<void> {
  previewCloseState = { message: `Checking ${symbol} ${lotLabel ?? ""}...`.trim(), error: null };
  await render();
  const response: unknown = await chrome.runtime.sendMessage({
    type: "PREVIEW_CLOSE",
    fingerprint,
    symbol,
    lotLabel,
  });
  if (isExtensionMessage(response) && response.type === "PREVIEW_CLOSE_RESULT") {
    if (response.report?.ready) {
      previewCloseState = {
        message: `Highlighted ${symbol} ${lotLabel ?? ""} on Kraken for 15 seconds. Click the highlighted Kraken close control manually to close it.`,
        error: null,
      };
    } else {
      previewCloseState = {
        message: null,
        error: response.report?.blockedReason ?? response.error ?? "Preview Close was blocked.",
      };
    }
  } else {
    previewCloseState = { message: null, error: "Unexpected Preview Close response." };
  }
  await requestState();
}

async function requestManualClose(position: TrackedPosition, lotLabel: string | null): Promise<void> {
  const label = lotLabel ?? "Lot A";
  manualCloseState = {
    pending: {
      fingerprint: position.fingerprint,
      symbol: position.symbol,
      lotLabel: label,
      entry: position.openingPrice,
      currentPrice: position.latest?.currentPriceUi ?? position.latestApiPrice,
      valueUsd: position.latest?.valueUsd ?? null,
      netPnl: position.latest?.netPnl ?? null,
      phase: "INITIAL_CONFIRM",
      modalSummary: null,
    },
  };
  previewCloseState = { message: null, error: null };
  await render();
}

async function continueManualClose(): Promise<void> {
  const pending = manualCloseState.pending;
  if (!pending) return;
  await openCloseDialog(pending.fingerprint, pending.symbol, pending.lotLabel);
}

async function openCloseDialog(fingerprint: string, symbol: string, lotLabel: string | null): Promise<void> {
  previewCloseState = { message: `Opening Kraken close dialog for ${symbol} ${lotLabel ?? ""}...`.trim(), error: null };
  await render();
  const response: unknown = await chrome.runtime.sendMessage({
    type: "OPEN_CLOSE_DIALOG",
    fingerprint,
    symbol,
    lotLabel,
  });
  if (isExtensionMessage(response) && response.type === "OPEN_CLOSE_DIALOG_RESULT") {
    if (response.report?.ready) {
      if (manualCloseState.pending) {
        manualCloseState = {
          pending: {
            ...manualCloseState.pending,
            phase: "MODAL_VALIDATED",
            modalSummary:
              `${symbol} ${lotLabel ?? ""} Long. ` +
              `${response.report.modalValidation?.quantityEvidence ?? "Quantity detected"}. ` +
              `Action: ${response.report.modalValidation?.actionEvidence ?? "close at market"}.`,
          },
        };
      }
      previewCloseState = {
        message:
          `Clicked the validated ${symbol} ${lotLabel ?? ""} close control. Kraken close dialog validated.`,
        error: null,
      };
    } else {
      previewCloseState = {
        message: null,
        error: response.report?.blockedReason ?? response.error ?? "Close dialog was blocked.",
      };
    }
  } else {
    previewCloseState = { message: null, error: "Unexpected close-dialog response." };
  }
  await requestState();
}

async function confirmManualClose(): Promise<void> {
  const pending = manualCloseState.pending;
  if (!pending || pending.phase !== "MODAL_VALIDATED") return;
  manualCloseState = { pending: { ...pending, phase: "SUBMITTING" } };
  previewCloseState = { message: `Submitting final close for ${pending.symbol} ${pending.lotLabel}...`, error: null };
  await render();

  const response: unknown = await chrome.runtime.sendMessage({
    type: "CONFIRM_CLOSE_DIALOG",
    fingerprint: pending.fingerprint,
    symbol: pending.symbol,
  });
  if (isExtensionMessage(response) && response.type === "CONFIRM_CLOSE_DIALOG_RESULT") {
    if (response.clicked && response.modalValidation?.ready) {
      manualCloseState = { pending: null };
      previewCloseState = {
        message: `Clicked the validated final close button for ${pending.symbol}. Verifying the position scan now.`,
        error: null,
      };
    } else {
      manualCloseState = { pending: { ...pending, phase: "MODAL_VALIDATED" } };
      previewCloseState = {
        message: null,
        error: response.modalValidation?.blockedReason ?? response.error ?? "Final close was blocked.",
      };
    }
  } else {
    manualCloseState = { pending: { ...pending, phase: "MODAL_VALIDATED" } };
    previewCloseState = { message: null, error: "Unexpected final close response." };
  }
  await requestState();
}

/** Starts a supervised, manual test of the real buy-execution path — the
 * only way to trigger a buy today besides Autopilot's fully-automatic one.
 * quantityUnits defaults to the suggested size but is editable in the
 * INITIAL_CONFIRM phase, since this is for proving out the mechanism, not
 * necessarily committing to the full suggested amount. */
function requestManualBuy(symbol: string, quantityUnits: number, currentPrice: number | null): void {
  manualBuyState = {
    pending: { symbol, quantityUnits, currentPrice, phase: "INITIAL_CONFIRM", modalSummary: null },
  };
  manualBuyMessage = { message: null, error: null };
  void render();
}

function updateManualBuyQuantity(quantityUnits: number): void {
  if (!manualBuyState.pending) return;
  manualBuyState = { pending: { ...manualBuyState.pending, quantityUnits } };
}

async function continueManualBuy(): Promise<void> {
  const pending = manualBuyState.pending;
  if (!pending) return;
  manualBuyMessage = { message: `Opening buy order for ${pending.symbol}...`, error: null };
  await render();

  const response: unknown = await chrome.runtime.sendMessage({
    type: "OPEN_BUY_ORDER",
    symbol: pending.symbol,
    quantityUnits: pending.quantityUnits,
  });
  if (isExtensionMessage(response) && response.type === "OPEN_BUY_ORDER_RESULT") {
    if (response.report?.ready) {
      const confirmedQuantity = response.report.quantitySet ?? pending.quantityUnits;
      manualBuyState = {
        pending: {
          ...pending,
          quantityUnits: confirmedQuantity,
          phase: "MODAL_VALIDATED",
          modalSummary:
            `Quantity ${confirmedQuantity} ${pending.symbol}. ` +
            `${response.report.modalValidation?.finalControlText ?? "Confirm button found."}`,
        },
      };
      manualBuyMessage = { message: "Kraken buy confirmation validated.", error: null };
    } else {
      manualBuyMessage = {
        message: null,
        error: response.report?.blockedReason ?? response.error ?? "Open Buy Order was blocked.",
      };
    }
  } else {
    manualBuyMessage = { message: null, error: "Unexpected open-buy-order response." };
  }
  await requestState();
}

async function confirmManualBuy(): Promise<void> {
  const pending = manualBuyState.pending;
  if (!pending || pending.phase !== "MODAL_VALIDATED") return;
  manualBuyState = { pending: { ...pending, phase: "SUBMITTING" } };
  manualBuyMessage = { message: `Submitting buy for ${pending.symbol}...`, error: null };
  await render();

  const response: unknown = await chrome.runtime.sendMessage({
    type: "CONFIRM_BUY_ORDER",
    symbol: pending.symbol,
    quantityUnits: pending.quantityUnits,
  });
  if (isExtensionMessage(response) && response.type === "CONFIRM_BUY_ORDER_RESULT") {
    if (response.clicked && response.modalValidation?.ready) {
      manualBuyState = { pending: null };
      manualBuyMessage = {
        message: `Clicked Confirm for ${pending.symbol}. Verify the order on Kraken.`,
        error: null,
      };
    } else {
      manualBuyState = { pending: { ...pending, phase: "MODAL_VALIDATED" } };
      manualBuyMessage = {
        message: null,
        error: response.modalValidation?.blockedReason ?? response.error ?? "Confirm Buy was blocked.",
      };
    }
  } else {
    manualBuyState = { pending: { ...pending, phase: "MODAL_VALIDATED" } };
    manualBuyMessage = { message: null, error: "Unexpected confirm-buy response." };
  }
  await requestState();
}

async function copyDiagnosticsToClipboard(): Promise<void> {
  if (!latestDiagnosticsReport) return;
  const json = JSON.stringify(latestDiagnosticsReport, null, 2);
  try {
    await navigator.clipboard.writeText(json);
  } catch (err) {
    console.warn("[kraken-guard] clipboard write failed", err);
  }
}

async function copyOrderFormDiagnosticsToClipboard(): Promise<void> {
  if (!latestOrderFormDiagnosticsReport) return;
  const json = JSON.stringify(latestOrderFormDiagnosticsReport, null, 2);
  try {
    await navigator.clipboard.writeText(json);
  } catch (err) {
    console.warn("[kraken-guard] clipboard write failed", err);
  }
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isExtensionMessage(message)) return;
  if (message.type === "STATE_SNAPSHOT") {
    latestState = message.state;
    void render();
  }
});

void (async () => {
  await loadSelectedTab();
  await requestState();
})();
// Keep the dashboard reasonably fresh even if a broadcast is missed.
setInterval(() => void requestState(), 30_000);
