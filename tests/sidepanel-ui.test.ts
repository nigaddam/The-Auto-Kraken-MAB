import { describe, expect, it } from "vitest";
import {
  renderAppHeader,
  renderConnectionPanel,
  renderControlsPanel,
  renderMarketDataPanel,
  renderLogsSection,
  renderPositionsSection,
  renderSettingsPanel,
  renderStatusPanel,
  renderTabBar,
} from "../src/sidepanel/components";
import { freshRuntimeState } from "../src/storage/migrations";
import type { AuditLogEntry, MarketDataRow, RuntimeState } from "../src/shared/types";

const NOOP = () => undefined;
const HANDLERS = {
  onStart: NOOP,
  onStop: NOOP,
  onRefresh: NOOP,
  onTestNotification: NOOP,
  onExportLogs: NOOP,
  onRunDiagnostics: NOOP,
};

function makeMarketDataRow(symbol: string): MarketDataRow {
  return {
    symbol,
    apiMarket: `${symbol}/USD`,
    source: "WATCHLIST",
    currentApiPrice: 1.23,
    lastCompletedClose: 1.2,
    smaFast: 1.21,
    smaSlow: 1.19,
    trend: "STRONG",
    vsSmaFastPct: 1.5,
    vsSmaSlowPct: 2.5,
    latestCandleTs: Date.now(),
    completedCandleCount: 100,
    formingCandleExcluded: true,
    lastUpdatedAt: Date.now(),
    apiStatus: "OK",
    errorMessage: null,
  };
}

describe("side panel: no API key UI anywhere", () => {
  it("never renders an <input> element in any panel", () => {
    const state: RuntimeState = {
      ...freshRuntimeState(),
      marketData: { XPL: makeMarketDataRow("XPL"), JTO: makeMarketDataRow("JTO") },
    };
    const now = Date.now();

    const container = document.createElement("div");
    container.append(
      renderConnectionPanel(state, now),
      renderControlsPanel(state, HANDLERS),
      renderStatusPanel(state, now),
      renderMarketDataPanel(state, now),
      renderPositionsSection(state, now)
    );

    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(container.textContent).not.toMatch(/api\s*key/i);
  });
});

describe("side panel: Auto-Close arming is explicit dry-run", () => {
  it("labels Start Monitoring as monitor-only and exposes dry-run arming separately", () => {
    const state: RuntimeState = {
      ...freshRuntimeState(),
      monitoringStatus: "RUNNING",
    };
    const panel = renderControlsPanel(state, HANDLERS);
    const text = panel.textContent ?? "";
    expect(text).toMatch(/Arm Auto-Close Dry Run/i);
    expect(text).toMatch(/Arm LIVE Auto-Close/i);
    expect(text).toMatch(/monitor-only/i);
    expect(text).toMatch(/will not execute trades/i);
  });

  it("shows armed dry-run status without implying live execution", () => {
    const state: RuntimeState = {
      ...freshRuntimeState(),
      monitoringStatus: "RUNNING",
      executionMode: "ARMED_AUTO_CLOSE",
      armedUntil: Date.now() + 60_000,
    };
    const panel = renderControlsPanel(state, HANDLERS);
    const text = panel.textContent ?? "";
    expect(text).toMatch(/Auto-Close Armed/i);
    expect(text).toMatch(/dry-run mode only/i);
    expect(text).toMatch(/does not click Kraken final confirmation/i);
  });

  it("shows live armed status separately from dry-run", () => {
    const state: RuntimeState = {
      ...freshRuntimeState(),
      monitoringStatus: "RUNNING",
      executionMode: "ARMED_AUTO_CLOSE",
      autoCloseLive: true,
      armedUntil: Date.now() + 60_000,
    };
    const panel = renderControlsPanel(state, HANDLERS);
    const text = panel.textContent ?? "";
    expect(text).toMatch(/LIVE Auto-Close is armed/i);
    expect(text).toMatch(/may close Kraken positions automatically/i);
  });
});

describe("side panel: connection state reflects any successful content-script response", () => {
  it("shows 'connected' once krakenTabId and lastContentScriptResponseAt are set, even with zero candidate rows", () => {
    const state: RuntimeState = {
      ...freshRuntimeState(),
      krakenTabId: 42,
      lastContentScriptResponseAt: Date.now(),
      lastCandidateRowCount: 0,
      pageHealth: {
        checkedAt: Date.now(),
        propPageDetected: true,
        accountMarkerDetected: false,
        sessionState: "UNKNOWN",
        positionsTableReadable: true,
        loginFormDetected: false,
        sessionExpiredModalDetected: false,
        captchaDetected: false,
        twoFaDetected: false,
        deviceApprovalDetected: false,
      },
    };
    const panel = renderConnectionPanel(state, Date.now());
    const text = panel.textContent ?? "";
    expect(text).toMatch(/connected/i);
    expect(text).not.toMatch(/disconnected/i);
    expect(text).toMatch(/unknown/i);
    expect(text).not.toMatch(/login required/i);
    expect(text).toMatch(/FAILED/i);
  });

  it("shows 'disconnected' when there has never been a successful content-script response", () => {
    const state: RuntimeState = freshRuntimeState();
    const panel = renderConnectionPanel(state, Date.now());
    expect(panel.textContent ?? "").toMatch(/disconnected/i);
  });
});

describe("side panel tabs", () => {
  it("renders Positions selected by default and switches with clicks", () => {
    let selected = "positions";
    const tabs = renderTabBar("positions", (tab) => {
      selected = tab;
    });

    const buttons = Array.from(tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(buttons).toHaveLength(4);
    expect(buttons[0]!.getAttribute("aria-selected")).toBe("true");
    expect(buttons[1]!.disabled).toBe(false);

    buttons[1]!.click();
    expect(selected).toBe("market");
  });

  it("supports arrow-key tab navigation", () => {
    let selected = "positions";
    const tabs = renderTabBar("positions", (tab) => {
      selected = tab;
    });
    const first = tabs.querySelector<HTMLButtonElement>('[role="tab"]')!;
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(selected).toBe("market");
  });
});

describe("side panel tab content", () => {
  it("Market tab renders JTO and XPL watchlist cards without positions", () => {
    const state: RuntimeState = {
      ...freshRuntimeState(),
      marketData: { XPL: makeMarketDataRow("XPL"), JTO: makeMarketDataRow("JTO") },
    };
    const panel = renderMarketDataPanel(state, Date.now());
    const text = panel.textContent ?? "";
    expect(text).toMatch(/JTO/);
    expect(text).toMatch(/XPL/);
    expect(text).toMatch(/Watchlist/i);
  });

  it("Notifications tab humanizes audit entries", () => {
    const entry: AuditLogEntry = {
      timestamp: Date.now(),
      eventType: "MONITORING_STARTED",
      symbol: null,
      fingerprint: null,
      mode: "MONITOR_ONLY",
      entryPrice: null,
      currentPrice: null,
      currentReturnPct: null,
      peakReturnPct: null,
      profitFloorPct: null,
      smaFast: null,
      smaSlow: null,
      closeCounter: null,
      decision: null,
      reason: "Monitoring started.",
      executionResult: "SUCCESS",
      errorDetails: null,
    };
    const panel = renderLogsSection([entry], HANDLERS);
    expect(panel.textContent ?? "").toMatch(/Monitoring started/);
    expect(panel.textContent ?? "").not.toMatch(/MONITORING_STARTED/);
    expect(panel.textContent ?? "").toMatch(/Success/);
  });

  it("Settings loads values, saves valid values, rejects invalid values, and resets", () => {
    const state = freshRuntimeState();
    let savedPollMinutes: number | null = null;
    let reset = false;
    const panel = renderSettingsPanel(state, {
      onSaveSettings: (settings) => {
        savedPollMinutes = settings.pollMinutes;
      },
      onResetSettings: () => {
        reset = true;
      },
      onRunDiagnostics: NOOP,
      onRunOrderFormDiagnostics: NOOP,
      onExportLogs: NOOP,
    });

    const poll = panel.querySelector<HTMLInputElement>('input[name="pollMinutes"]')!;
    expect(poll.value).toBe("5");
    poll.value = "10";
    panel.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true }));
    expect(savedPollMinutes).toBe(10);

    savedPollMinutes = null;
    const slow = panel.querySelector<HTMLInputElement>('input[name="slowSma"]')!;
    slow.value = "1";
    panel.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true }));
    expect(savedPollMinutes).toBeNull();
    expect(panel.textContent ?? "").toMatch(/SMA slow period/);

    panel.querySelector<HTMLButtonElement>("button:not(.primary)")!.click();
    expect(reset).toBe(true);
  });

  it("Settings saves conservative live execution limits", () => {
    const state = freshRuntimeState();
    const saved: RuntimeState["settings"][] = [];
    const panel = renderSettingsPanel(state, {
      onSaveSettings: (settings) => {
        saved.push(settings);
      },
      onResetSettings: NOOP,
      onRunDiagnostics: NOOP,
      onRunOrderFormDiagnostics: NOOP,
      onExportLogs: NOOP,
    });

    panel.querySelector<HTMLInputElement>('input[name="maxLiveClosesPerHour"]')!.value = "2";
    panel.querySelector<HTMLInputElement>('input[name="maxLiveClosesPerArmedSession"]')!.value = "5";
    panel.querySelector<HTMLInputElement>('input[name="autoCloseSignalExpiryMinutes"]')!.value = "5";
    panel.querySelector<HTMLInputElement>('input[name="closeVerificationTimeoutSeconds"]')!.value = "10";
    panel.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true }));

    expect(saved[0]?.maxLiveClosesPerHour).toBe(2);
    expect(saved[0]?.maxLiveClosesPerArmedSession).toBe(5);
    expect(saved[0]?.autoCloseSignalExpiryMinutes).toBe(5);
    expect(saved[0]?.closeVerificationTimeoutSeconds).toBe(10);
  });
});

describe("side panel: production hardening status", () => {
  it("renders live preflight blockers in Positions", () => {
    const state: RuntimeState = {
      ...freshRuntimeState(),
      livePreflight: {
        allowed: false,
        checkedAt: Date.now(),
        blockers: ["Keep-awake is not active.", "Kraken session is UNKNOWN."],
      },
    };
    const panel = renderPositionsSection(state, Date.now());
    const text = panel.textContent ?? "";
    expect(text).toMatch(/Live Preflight/i);
    expect(text).toMatch(/Keep-awake is not active/i);
    expect(text).toMatch(/Kraken session is UNKNOWN/i);
  });

  it("renders the latest close execution result in Positions and Notifications", () => {
    const state: RuntimeState = {
      ...freshRuntimeState(),
      closeExecution: {
        intentId: "intent-1",
        fingerprint: "AAVE:LONG:95.330000:95:2",
        symbol: "AAVE",
        lotLabel: "Lot A",
        trigger: "Current return breached the hard-loss threshold.",
        startedAt: Date.now(),
        updatedAt: Date.now(),
        state: "SUCCEEDED",
        result: "SUCCESS",
        details: ["Exact lot removed", "Other 5 lots unchanged"],
      },
    };
    const positions = renderPositionsSection(state, Date.now());
    const notifications = renderLogsSection([], HANDLERS, state);
    expect(positions.textContent ?? "").toMatch(/Execution Status/i);
    expect(positions.textContent ?? "").toMatch(/Exact lot removed/i);
    expect(notifications.textContent ?? "").toMatch(/Execution Status/i);
    expect(notifications.textContent ?? "").toMatch(/Other 5 lots unchanged/i);
  });
});

describe("side panel header metrics", () => {
  it("shows dashes instead of false zeroes when parser failed against a readable positions section", () => {
    const state: RuntimeState = {
      ...freshRuntimeState(),
      lastCandidateRowCount: 0,
      pageHealth: {
        checkedAt: Date.now(),
        propPageDetected: true,
        accountMarkerDetected: false,
        sessionState: "UNKNOWN",
        positionsTableReadable: true,
        loginFormDetected: false,
        sessionExpiredModalDetected: false,
        captchaDetected: false,
        twoFaDetected: false,
        deviceApprovalDetected: false,
      },
    };
    const header = renderAppHeader(state);
    expect(header.textContent ?? "").toMatch(/Positions-/);
    expect(header.textContent ?? "").toMatch(/Markets-/);
  });
});
