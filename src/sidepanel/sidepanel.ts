import { isExtensionMessage } from "../shared/messages";
import type { GetStateMessage } from "../shared/messages";
import type { DiagnosticsReport, RuntimeState, Settings, TrackedPosition } from "../shared/types";
import { getAuditLog } from "../storage/audit-log";
import {
  renderAppHeader,
  renderControlsPanel,
  renderDiagnosticsSection,
  renderInterestedCoinsPanel,
  renderLogsSection,
  renderMarketDataPanel,
  renderPositionsSection,
  renderSettingsPanel,
  renderStatusPanel,
  renderTabBar,
  renderTabPanel,
  type ManualCloseUiState,
  type MarketRefreshUiState,
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
let selectedTab: TabId = "positions";
let marketRefreshState: MarketRefreshUiState = { refreshing: null, message: null, error: null };
let previewCloseState: PreviewCloseUiState = { message: null, error: null };
let manualCloseState: ManualCloseUiState = { pending: null };

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
    onStart: () => void startMonitoring(),
    onStop: () => void sendAndRefresh({ type: "STOP_MONITORING" }),
    onArmAutoClose: (live: boolean) => void armAutoClose(live),
    onDisarmAutoClose: () => void sendAndRefresh({ type: "DISARM_AUTO_CLOSE" }),
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
    onClearLogs: () => void clearLogsWithConfirmation(),
    onRefreshMarketData: (symbol?: string) => void refreshMarketData(symbol),
  };

  app.append(renderAppHeader(state), renderTabBar(selectedTab, (tab) => void selectTab(tab)));

  if (selectedTab === "positions") {
    app.append(
      renderTabPanel("positions", [
        renderPositionsSection(state, now, controls, previewCloseState, manualCloseState),
        renderStatusPanel(state, now),
        renderControlsPanel(state, controls),
      ])
    );
  } else if (selectedTab === "market") {
    app.append(
      renderTabPanel("market", [
        renderInterestedCoinsPanel(state, now),
        renderMarketDataPanel(state, now, controls, marketRefreshState),
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
    app.append(renderTabPanel("settings", children));
  }
}

async function sendAndRefresh(message: { type: string; [key: string]: unknown }): Promise<void> {
  await chrome.runtime.sendMessage(message);
  await requestState();
}

/** Routes Start Monitoring through the combined one-click flow when
 * Settings.startMonitoringWithLiveAutoClose is on; otherwise behaves
 * exactly like the plain two-step Start Monitoring always has. LIVE
 * preflight cannot run before monitoring has produced a fresh scan, so —
 * unlike armAutoClose(true) — confirmation here is collected up front,
 * before monitoring even starts; the service worker runs the real
 * preflight afterward and only arms if it passes. */
async function startMonitoring(): Promise<void> {
  if (!latestState) return;
  if (!latestState.settings.startMonitoringWithLiveAutoClose) {
    await sendAndRefresh({ type: "START_MONITORING" });
    return;
  }

  let durationHours = latestState.settings.autoCloseDurationHours;
  const entered = prompt(
    "LIVE Auto-Close duration in hours (monitoring starts first; LIVE only arms if preflight passes)",
    String(durationHours)
  );
  if (entered === null) return;
  const parsed = Number(entered);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    previewCloseState = { message: null, error: "LIVE Auto-Close duration must be a positive number of hours." };
    await render();
    return;
  }
  durationHours = parsed;
  if (
    !confirm(
      "Start Monitoring will also try to arm LIVE Auto-Close. I understand that qualifying live positions may be closed automatically."
    )
  ) {
    return;
  }

  const response: unknown = await chrome.runtime.sendMessage({
    type: "START_MONITORING_WITH_LIVE_AUTO_CLOSE",
    durationHours,
  });
  if (isExtensionMessage(response) && response.type === "START_MONITORING_WITH_LIVE_AUTO_CLOSE_RESULT") {
    if (!response.monitoringStarted) {
      previewCloseState = { message: null, error: "Monitoring could not start (Kraken tab not found)." };
    } else if (response.liveArmed) {
      previewCloseState = { message: "Monitoring started and LIVE Auto-Close armed.", error: null };
    } else {
      previewCloseState = {
        message: "Monitoring started in Monitor Only mode.",
        error: `LIVE Auto-Close was not armed: ${response.preflightBlockers.join(" ")}`,
      };
    }
  }
  await requestState();
}

async function armAutoClose(live: boolean): Promise<void> {
  if (!latestState) return;
  let durationHours = latestState.settings.autoCloseDurationHours;
  if (live) {
    const preflightResponse: unknown = await chrome.runtime.sendMessage({ type: "RUN_LIVE_PREFLIGHT" });
    await requestState();
    if (
      !isExtensionMessage(preflightResponse) ||
      preflightResponse.type !== "RUN_LIVE_PREFLIGHT_RESULT" ||
      !preflightResponse.result.allowed
    ) {
      return;
    }
    const entered = prompt("LIVE Auto-Close duration in hours", String(durationHours));
    if (entered === null) return;
    const parsed = Number(entered);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      previewCloseState = { message: null, error: "LIVE Auto-Close duration must be a positive number of hours." };
      await render();
      return;
    }
    durationHours = parsed;
    if (
      !confirm(
        "I understand that qualifying live positions may be closed automatically."
      )
    ) {
      return;
    }
  }
  await sendAndRefresh({
    type: "ARM_AUTO_CLOSE",
    durationHours,
    live,
  });
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

async function refreshMarketData(symbol?: string): Promise<void> {
  marketRefreshState = {
    refreshing: symbol ? { kind: "symbol", symbol } : { kind: "all" },
    message: null,
    error: null,
  };
  await render();
  const response: unknown = await chrome.runtime.sendMessage({
    type: "REFRESH_MARKET_DATA",
    symbol,
  });
  if (isExtensionMessage(response) && response.type === "REFRESH_MARKET_DATA_RESULT") {
    marketRefreshState = {
      refreshing: null,
      message: response.ok ? "Updated just now" : null,
      error: response.error,
    };
  } else {
    marketRefreshState = {
      refreshing: null,
      message: null,
      error: "Unexpected market refresh response.",
    };
  }
  await requestState();
}

async function saveSettings(settings: Settings): Promise<void> {
  await sendAndRefresh({ type: "UPDATE_SETTINGS", settings });
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

async function copyDiagnosticsToClipboard(): Promise<void> {
  if (!latestDiagnosticsReport) return;
  const json = JSON.stringify(latestDiagnosticsReport, null, 2);
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
