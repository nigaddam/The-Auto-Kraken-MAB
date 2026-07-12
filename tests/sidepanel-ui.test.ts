import { describe, expect, it } from "vitest";
import {
  renderAppHeader,
  renderConnectionPanel,
  renderControlsPanel,
  renderInterestedCoinsPanel,
  renderLogsSection,
  renderPositionsSection,
  renderSettingsPanel,
  renderStatusPanel,
  renderTabBar,
  type ManualBuyUiState,
} from "../src/sidepanel/components";
import { freshRuntimeState } from "../src/storage/migrations";
import type { AuditLogEntry, MarketDataRow, RuntimeState, TrackedPosition } from "../src/shared/types";

function makeActivePosition(symbol: string): TrackedPosition {
  return {
    fingerprint: `${symbol}-fp`,
    symbol,
    side: "LONG",
    openingPrice: 1,
    openingValueUsd: 100,
    firstObservedAt: Date.now(),
    lastSeenAt: Date.now(),
    status: "ACTIVE",
    latest: null,
    latestApiPrice: null,
    latestApiPriceAt: null,
    highestObservedPrice: 1,
    peakReturnPct: 0,
    profitFloorPct: null,
    smaFast: null,
    smaSlow: null,
    trend: "UNKNOWN",
    consecutiveClosesBelowSmaFast: 0,
    lastProcessedCandleTs: null,
    decision: "HOLD",
    reason: "No exit rule active.",
    autoCloseDisabledReason: null,
  };
}

const NOOP = () => undefined;
const HANDLERS = {
  onSetOperatingMode: NOOP,
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
    suggestedBuyUsd: null,
    suggestedBuyUnits: null,
    atOrAboveSizeCap: false,
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
      renderPositionsSection(state, now)
    );

    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(container.textContent).not.toMatch(/api\s*key/i);
  });
});

describe("side panel: simplified Off/Cruise/Autopilot mode control", () => {
  it("shows all three mode buttons and describes OFF as fully stopped", () => {
    const state: RuntimeState = { ...freshRuntimeState(), operatingMode: "OFF" };
    const panel = renderControlsPanel(state, HANDLERS);
    const buttonLabels = Array.from(panel.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttonLabels).toContain("Off");
    expect(buttonLabels).toContain("Cruise");
    expect(buttonLabels).toContain("Autopilot");
    expect(panel.textContent ?? "").toMatch(/stopped/i);
  });

  it("describes CRUISE as watch-and-notify only, no orders placed", () => {
    const state: RuntimeState = {
      ...freshRuntimeState(),
      monitoringStatus: "RUNNING",
      operatingMode: "CRUISE",
    };
    const panel = renderControlsPanel(state, HANDLERS);
    const text = panel.textContent ?? "";
    expect(text).toMatch(/notifications/i);
    expect(text).toMatch(/no orders are placed/i);
  });

  it("describes AUTOPILOT as armed once executionMode/autoCloseLive confirm it", () => {
    const state: RuntimeState = {
      ...freshRuntimeState(),
      monitoringStatus: "RUNNING",
      operatingMode: "AUTOPILOT",
      executionMode: "ARMED_AUTO_CLOSE",
      autoCloseLive: true,
      armedUntil: Date.now() + 60_000,
    };
    const panel = renderControlsPanel(state, HANDLERS);
    const text = panel.textContent ?? "";
    expect(text).toMatch(/Autopilot is armed/i);
    expect(text).toMatch(/no confirmation prompts/i);
  });

  it("describes AUTOPILOT as not yet armed when executionMode hasn't caught up", () => {
    const state: RuntimeState = {
      ...freshRuntimeState(),
      monitoringStatus: "RUNNING",
      operatingMode: "AUTOPILOT",
    };
    const panel = renderControlsPanel(state, HANDLERS);
    const text = panel.textContent ?? "";
    expect(text).toMatch(/not yet armed/i);
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
  it("Market tab (Interested Kraken Coins) renders cards for manually-added watchlist symbols", () => {
    const state: RuntimeState = {
      ...freshRuntimeState(),
      marketData: { XPL: makeMarketDataRow("XPL"), JTO: makeMarketDataRow("JTO") },
      settings: { ...freshRuntimeState().settings, watchlistCoins: ["XPL", "JTO"] },
    };
    const panel = renderInterestedCoinsPanel(state, Date.now());
    const text = panel.textContent ?? "";
    expect(text).toMatch(/JTO/);
    expect(text).toMatch(/XPL/);
  });

  it("shows symbols with an open position as auto-tracked without consuming a manual slot", () => {
    const state: RuntimeState = {
      ...freshRuntimeState(),
      positions: { "XPL-fp": makeActivePosition("XPL") },
      settings: { ...freshRuntimeState().settings, watchlistCoins: ["SOL"] },
    };
    const panel = renderInterestedCoinsPanel(state, Date.now());
    const text = panel.textContent ?? "";
    expect(text).toMatch(/Auto-tracked/i);
    expect(text).toMatch(/XPL/);
    expect(text).toMatch(/Tracking 2 of 5 slots/i);
  });

  it("lets the user add and remove manual watchlist symbols from the Market tab", () => {
    let latest: string[] | null = null;
    const state: RuntimeState = {
      ...freshRuntimeState(),
      settings: { ...freshRuntimeState().settings, watchlistCoins: ["SOL"] },
    };
    const panel = renderInterestedCoinsPanel(state, Date.now(), {
      ...HANDLERS,
      onUpdateWatchlist: (symbols) => {
        latest = symbols;
      },
    });

    const input = panel.querySelector<HTMLInputElement>(".watchlist-add-row input");
    const addBtn = panel.querySelector<HTMLButtonElement>(".watchlist-add-row button");
    expect(input).not.toBeNull();
    expect(addBtn).not.toBeNull();
    input!.value = "avax";
    addBtn!.click();
    expect(latest).toEqual(["SOL", "AVAX"]);

    const removeBtn = panel.querySelector<HTMLButtonElement>(".chip-remove");
    expect(removeBtn).not.toBeNull();
    removeBtn!.click();
    expect(latest).toEqual([]);
  });

  it("disables adding once all 5 slots are used (positions + manual entries)", () => {
    const state: RuntimeState = {
      ...freshRuntimeState(),
      positions: {
        "A-fp": makeActivePosition("AAA"),
        "B-fp": makeActivePosition("BBB"),
      },
      settings: { ...freshRuntimeState().settings, watchlistCoins: ["CCC", "DDD", "EEE"] },
    };
    const panel = renderInterestedCoinsPanel(state, Date.now(), { ...HANDLERS, onUpdateWatchlist: () => {} });
    const input = panel.querySelector<HTMLInputElement>(".watchlist-add-row input");
    const addBtn = panel.querySelector<HTMLButtonElement>(".watchlist-add-row button");
    expect(input?.disabled).toBe(true);
    expect(addBtn?.disabled).toBe(true);
    expect(panel.textContent ?? "").toMatch(/Tracking 5 of 5 slots/i);
  });

  it("shows a Test Buy button on a manual watchlist card with valid price data and wires it up", () => {
    let requested: [string, number, number | null] | null = null;
    const state: RuntimeState = {
      ...freshRuntimeState(),
      settings: { ...freshRuntimeState().settings, watchlistCoins: ["SOL"] },
      marketData: { SOL: { ...makeMarketDataRow("SOL"), suggestedBuyUnits: 2.5 } },
    };
    const panel = renderInterestedCoinsPanel(state, Date.now(), {
      ...HANDLERS,
      onRequestManualBuy: (symbol, quantityUnits, currentPrice) => {
        requested = [symbol, quantityUnits, currentPrice];
      },
    });
    const buttons = Array.from(panel.querySelectorAll("button"));
    const testBuyBtn = buttons.find((b) => b.textContent === "Test Buy");
    expect(testBuyBtn).toBeDefined();
    testBuyBtn!.click();
    expect(requested).toEqual(["SOL", 2.5, 1.23]);
  });

  it("does not show a Test Buy button when market data is unavailable", () => {
    const state: RuntimeState = {
      ...freshRuntimeState(),
      settings: { ...freshRuntimeState().settings, watchlistCoins: ["SOL"] },
    };
    const panel = renderInterestedCoinsPanel(state, Date.now(), HANDLERS);
    const buttons = Array.from(panel.querySelectorAll("button"));
    expect(buttons.some((b) => b.textContent === "Test Buy")).toBe(false);
  });

  it("renders the manual buy panel's INITIAL_CONFIRM phase with an editable quantity", () => {
    let updated: number | null = null;
    const manualBuyState: ManualBuyUiState = {
      pending: { symbol: "SOL", quantityUnits: 2.5, currentPrice: 100, phase: "INITIAL_CONFIRM", modalSummary: null },
    };
    const state: RuntimeState = { ...freshRuntimeState() };
    const panel = renderInterestedCoinsPanel(state, Date.now(), {
      ...HANDLERS,
      onUpdateManualBuyQuantity: (quantityUnits) => {
        updated = quantityUnits;
      },
    }, manualBuyState);

    expect(panel.textContent).toMatch(/Test Buy SOL\?/);
    const qtyInput = panel.querySelector<HTMLInputElement>('input[type="number"]');
    expect(qtyInput).not.toBeNull();
    expect(qtyInput!.value).toBe("2.5");
    qtyInput!.value = "1.25";
    qtyInput!.dispatchEvent(new Event("input"));
    expect(updated).toBe(1.25);

    const buttons = Array.from(panel.querySelectorAll("button"));
    expect(buttons.some((b) => b.textContent === "Open Kraken Buy Order")).toBe(true);
  });

  it("renders the manual buy panel's MODAL_VALIDATED phase with a Confirm Buy button", () => {
    let confirmed = false;
    const manualBuyState: ManualBuyUiState = {
      pending: {
        symbol: "SOL",
        quantityUnits: 2.5,
        currentPrice: 100,
        phase: "MODAL_VALIDATED",
        modalSummary: "Quantity 2.5 SOL. Confirm button found.",
      },
    };
    const state: RuntimeState = { ...freshRuntimeState() };
    const panel = renderInterestedCoinsPanel(state, Date.now(), {
      ...HANDLERS,
      onConfirmManualBuy: () => {
        confirmed = true;
      },
    }, manualBuyState);

    expect(panel.textContent).toMatch(/Kraken Buy Confirmation Validated/);
    expect(panel.textContent).toMatch(/Confirm button found/);
    const confirmBtn = Array.from(panel.querySelectorAll("button")).find((b) => b.textContent === "Confirm Buy");
    expect(confirmBtn).toBeDefined();
    confirmBtn!.click();
    expect(confirmed).toBe(true);
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
      realizedPnlUsd: null,
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
