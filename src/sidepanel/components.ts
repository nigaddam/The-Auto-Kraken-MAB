import type {
  AuditLogEntry,
  Decision,
  DiagnosticsReport,
  MarketDataRow,
  OrderFormDiagnosticsReport,
  RuntimeState,
  SessionState,
  Settings,
  TrackedPosition,
} from "../shared/types";
import { DEV_WATCHLIST_SYMBOLS, MAX_WATCHLIST_COINS } from "../shared/constants";
import {
  isPlausibleEmailAddress,
  isSupportedExecutionWebhookUrl,
} from "../background/execution-notify";

export type TabId = "positions" | "market" | "notifications" | "settings";

const TABS: { id: TabId; label: string }[] = [
  { id: "positions", label: "Positions" },
  { id: "market", label: "Market" },
  { id: "notifications", label: "Notifications" },
  { id: "settings", label: "Settings" },
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(label: string, value: string): HTMLElement {
  const r = el("div", "row");
  r.append(el("span", "label", label), el("span", undefined, value));
  return r;
}

function metric(
  label: string,
  value: string,
  tone: "ok" | "warn" | "bad" | "neutral" = "neutral"
): HTMLElement {
  const node = el("div", `metric ${tone}`);
  node.append(el("span", "metric-label", label), el("strong", undefined, value));
  return node;
}

function pill(text: string, tone: "ok" | "warn" | "bad" | "neutral"): HTMLElement {
  return el("span", `pill ${tone}`, text);
}

function decisionLabel(decision: Decision): string {
  if (decision === "CLOSE") return "CLOSE RECOMMENDED";
  return decision;
}

function fmtPct(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function fmtSigned(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function fmtSignedUsd(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "-";
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

function fmtUsd(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "-";
  return `$${value.toFixed(2)}`;
}

function fmtPrice(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "-";
  return value < 1 ? value.toFixed(6) : value.toFixed(4);
}

function fmtAge(ts: number | null, now: number): string {
  if (ts === null) return "never";
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function fmtUntil(ts: number | null, now: number): string {
  if (ts === null) return "-";
  const seconds = Math.max(0, Math.round((ts - now) / 1000));
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

function sessionPill(sessionState: SessionState): HTMLElement {
  switch (sessionState) {
    case "LOGGED_IN":
      return pill("connected", "ok");
    case "LOGGED_OUT":
      return pill("login needed", "bad");
    default:
      return pill("unknown", "neutral");
  }
}

function decisionTone(decision: Decision): "ok" | "warn" | "bad" | "neutral" {
  switch (decision) {
    case "HOLD":
    case "PROTECT":
      return "ok";
    case "WATCH":
    case "BLOCKED":
      return "warn";
    case "CLOSE":
    case "ERROR":
      return "bad";
    case "CLOSED":
      return "neutral";
  }
}

function statusTone(state: RuntimeState): "ok" | "warn" | "bad" | "neutral" {
  const active = Object.values(state.positions).filter((p) => p.status === "ACTIVE");
  if (active.some((p) => p.decision === "CLOSE" || p.decision === "ERROR")) return "bad";
  if (
    state.monitoringStatus === "RUNNING" &&
    (active.some((p) => p.decision === "WATCH" || p.decision === "BLOCKED") ||
      state.missedScheduledChecks > 0)
  ) {
    return "warn";
  }
  return state.monitoringStatus === "RUNNING" ? "ok" : "neutral";
}

function statusLabel(state: RuntimeState): string {
  const tone = statusTone(state);
  if (tone === "bad") return "Warning";
  if (tone === "warn") return "Watching";
  return state.monitoringStatus === "RUNNING" ? "Monitoring" : "Stopped";
}

function computeReturnForDisplay(pos: TrackedPosition, apiPrice: number): number {
  return ((apiPrice - pos.openingPrice) / pos.openingPrice) * 100;
}

function activePositions(state: RuntimeState): TrackedPosition[] {
  return Object.values(state.positions).filter((p) => p.status === "ACTIVE");
}

function uniqueMarkets(positions: TrackedPosition[]): string[] {
  return [...new Set(positions.map((p) => p.symbol))].sort();
}

function currentPnl(state: RuntimeState): number | null {
  const values = activePositions(state)
    .map((p) => p.latest?.netPnl ?? p.latest?.upnl ?? null)
    .filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0);
}

function currentPositionValue(state: RuntimeState): number | null {
  const values = activePositions(state)
    .map((p) => p.latest?.valueUsd ?? null)
    .filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0);
}

function parserLooksFailed(state: RuntimeState): boolean {
  return Boolean(state.pageHealth?.positionsTableReadable && state.lastCandidateRowCount === 0);
}

function lotLabel(index: number): string {
  return `Lot ${String.fromCharCode(65 + index)}`;
}

function reasonLines(pos: TrackedPosition): string[] {
  const diagnostics = pos.strategyDiagnostics;
  if (pos.decision === "HOLD") {
    const lines = [diagnostics?.reason ?? (pos.trend === "STRONG" ? "Above trend baseline" : "No exit rule active")];
    lines.push(
      pos.profitFloorPct === null
        ? "Profit lock inactive"
        : `Profit floor ${fmtPct(pos.profitFloorPct)}`
    );
    if (diagnostics?.nextCloseCondition) lines.push(`Next CLOSE: ${diagnostics.nextCloseCondition}`);
    return lines;
  }
  if (pos.decision === "PROTECT") {
    return [
      pos.reason,
      `Regime ${diagnostics?.regime ?? pos.regime}`,
      diagnostics?.nextCloseCondition ? `Next CLOSE: ${diagnostics.nextCloseCondition}` : "Operationally HOLD; no order is initiated.",
    ];
  }
  if (pos.decision === "WATCH") return [pos.reason, "Waiting for confirmation"];
  if (pos.decision === "CLOSE") return [pos.reason];
  if (pos.decision === "BLOCKED") return [pos.reason];
  if (pos.decision === "ERROR") return [pos.reason];
  return ["Position no longer detected"];
}

export function renderAppHeader(state: RuntimeState): HTMLElement {
  const positions = activePositions(state);
  const markets = uniqueMarkets(positions);
  const holding = positions.filter((p) => p.decision === "HOLD" || p.decision === "PROTECT").length;
  const watching = positions.filter(
    (p) => p.decision === "WATCH" || p.decision === "BLOCKED"
  ).length;
  const closing = positions.filter((p) => p.decision === "CLOSE").length;
  const pnl = currentPnl(state);
  const totalValue = currentPositionValue(state);
  const parserFailed = parserLooksFailed(state);

  const header = el("header", "app-header");
  const titleRow = el("div", "app-title-row");
  const title = el("div", "app-title", "Kraken Overnight Guard");
  title.prepend(document.createTextNode("🌙 "));
  titleRow.append(title, pill(statusLabel(state), statusTone(state)));
  header.append(titleRow);

  const summary = el("div", "summary-grid");
  summary.append(
    metric("Positions", parserFailed ? "-" : String(positions.length)),
    metric("Markets", parserFailed ? "-" : String(markets.length)),
    metric("Value", parserFailed ? "-" : fmtUsd(totalValue)),
    metric(
      "P/L",
      parserFailed ? "-" : fmtSignedUsd(pnl),
      pnl === null || parserFailed ? "neutral" : pnl >= 0 ? "ok" : "bad"
    ),
    metric("Holding", parserFailed ? "-" : String(holding), "ok"),
    metric("Watching", parserFailed ? "-" : String(watching), watching > 0 ? "warn" : "neutral"),
    metric("Ready", parserFailed ? "-" : String(closing), closing > 0 ? "bad" : "neutral")
  );
  header.append(summary);
  return header;
}

export function renderTabBar(activeTab: TabId, onSelect: (tab: TabId) => void): HTMLElement {
  const nav = el("nav", "tabs");
  nav.setAttribute("role", "tablist");
  nav.setAttribute("aria-label", "Kraken Overnight Guard sections");

  const activate = (tabId: TabId): void => {
    onSelect(tabId);
  };

  for (const tabInfo of TABS) {
    const selected = tabInfo.id === activeTab;
    const tab = el("button", selected ? "tab active" : "tab", tabInfo.label);
    tab.type = "button";
    tab.id = `tab-${tabInfo.id}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.setAttribute("aria-controls", `panel-${tabInfo.id}`);
    tab.tabIndex = selected ? 0 : -1;
    tab.dataset.tabId = tabInfo.id;
    tab.addEventListener("click", () => activate(tabInfo.id));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Enter", " "].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Enter" || event.key === " ") {
        activate(tabInfo.id);
        return;
      }
      const currentIndex = TABS.findIndex((t) => t.id === tabInfo.id);
      const offset = event.key === "ArrowRight" ? 1 : -1;
      const next = TABS[(currentIndex + offset + TABS.length) % TABS.length]!;
      activate(next.id);
    });
    nav.append(tab);
  }
  return nav;
}

export function renderTabPanel(tabId: TabId, children: HTMLElement[]): HTMLElement {
  const panel = el("div", "tab-panel");
  panel.id = `panel-${tabId}`;
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", `tab-${tabId}`);
  panel.append(...children);
  return panel;
}

function renderParserStatusPill(state: RuntimeState): HTMLElement {
  const candidateCount = state.lastCandidateRowCount;
  const parsedCount = activePositions(state).length;
  if (candidateCount === null) return pill("not run yet", "neutral");
  if (candidateCount === 0) {
    return state.pageHealth?.positionsTableReadable
      ? pill("FAILED", "bad")
      : pill("NO_POSITIONS", "neutral");
  }
  if (parsedCount < candidateCount) return pill(`PARTIAL ${parsedCount}/${candidateCount}`, "warn");
  return pill(`HEALTHY ${parsedCount} positions`, "ok");
}

function wrapRow(label: string, valueEl: HTMLElement): HTMLElement {
  const r = el("div", "row");
  r.append(el("span", "label", label), valueEl);
  return r;
}

export function renderConnectionPanel(state: RuntimeState, now: number): HTMLElement {
  const panel = el("section", "panel stack");
  panel.append(el("h2", undefined, "Monitoring"));

  const health = state.pageHealth;
  const tabOk = state.krakenTabId !== null && state.lastContentScriptResponseAt !== null;
  panel.append(
    wrapRow("Kraken", tabOk ? pill("connected", "ok") : pill("disconnected", "bad")),
    wrapRow(
      "Prop page",
      health?.propPageDetected ? pill("detected", "ok") : pill("not detected", "bad")
    ),
    wrapRow("Login", sessionPill(health?.sessionState ?? "UNKNOWN")),
    wrapRow("Parser", renderParserStatusPill(state)),
    wrapRow(
      "Public API",
      pill(
        state.lastPriceUpdateAt ? "healthy" : "no data",
        state.lastPriceUpdateAt ? "ok" : "neutral"
      )
    )
  );

  if (health?.checkedAt) panel.append(row("Page checked", fmtAge(health.checkedAt, now)));
  return panel;
}

export interface ControlHandlers {
  onStart: () => void;
  onStop: () => void;
  onArmAutoClose?: (live: boolean) => void;
  onDisarmAutoClose?: () => void;
  onRefresh: () => void;
  onTestNotification: () => void;
  onExportLogs: () => void;
  onRunDiagnostics: () => void;
  onPreviewClose?: (position: TrackedPosition, lotLabel: string | null) => void;
  onRequestManualClose?: (position: TrackedPosition, lotLabel: string | null) => void;
  onCancelManualClose?: () => void;
  onContinueManualClose?: () => void;
  onConfirmManualClose?: () => void;
  onRefreshMarketData?: (symbol?: string) => void;
  onClearLogs?: () => void;
}

export interface MarketRefreshUiState {
  refreshing: { kind: "all" } | { kind: "symbol"; symbol: string } | null;
  message: string | null;
  error: string | null;
}

export interface PreviewCloseUiState {
  message: string | null;
  error: string | null;
}

export interface ManualCloseUiState {
  pending: {
    fingerprint: string;
    symbol: string;
    lotLabel: string;
    entry: number;
    currentPrice: number | null;
    valueUsd: number | null;
    netPnl: number | null;
    phase: "INITIAL_CONFIRM" | "MODAL_VALIDATED" | "SUBMITTING";
    modalSummary: string | null;
  } | null;
}

export function renderControlsPanel(state: RuntimeState, handlers: ControlHandlers): HTMLElement {
  const panel = el("section", "panel stack controls-panel");
  panel.append(el("h2", undefined, "Controls"));

  const isRunning = state.monitoringStatus === "RUNNING";
  const controls = el("div", "controls");

  const startBtn = el("button", "primary", "Start Monitoring");
  startBtn.disabled = isRunning;
  startBtn.addEventListener("click", handlers.onStart);

  const stopBtn = el("button", undefined, "Stop Monitoring");
  stopBtn.disabled = !isRunning;
  stopBtn.addEventListener("click", handlers.onStop);

  const refreshBtn = el("button", undefined, "Refresh Positions");
  refreshBtn.addEventListener("click", handlers.onRefresh);

  const autoCloseArmed = state.executionMode === "ARMED_AUTO_CLOSE" && state.armedUntil !== null;
  const armBtn = el(
    "button",
    undefined,
    autoCloseArmed ? "Auto-Close Armed" : "Arm Auto-Close Dry Run"
  );
  armBtn.disabled = !isRunning || autoCloseArmed;
  armBtn.addEventListener("click", () => handlers.onArmAutoClose?.(false));

  const liveArmBtn = el("button", "primary", "Arm LIVE Auto-Close");
  liveArmBtn.disabled = !isRunning || autoCloseArmed;
  liveArmBtn.addEventListener("click", () => handlers.onArmAutoClose?.(true));

  const disarmBtn = el("button", undefined, "Disarm Auto-Close");
  disarmBtn.disabled = !autoCloseArmed;
  disarmBtn.addEventListener("click", () => handlers.onDisarmAutoClose?.());

  controls.append(startBtn, stopBtn, refreshBtn, armBtn, liveArmBtn, disarmBtn);
  panel.append(controls);
  panel.append(
    el(
      "div",
      autoCloseArmed ? "warn-text" : "success-text",
      autoCloseArmed
        ? state.autoCloseLive
          ? "LIVE Auto-Close is armed. Current validated CLOSE signals may close Kraken positions automatically."
          : "Auto-Close is armed in dry-run mode only. It logs close intents but does not click Kraken final confirmation."
        : "Start Monitoring is monitor-only. It will not execute trades unless Auto-Close is separately armed."
    )
  );
  return panel;
}

export function renderStatusPanel(state: RuntimeState, now: number): HTMLElement {
  const panel = renderConnectionPanel(state, now);
  const positions = activePositions(state);
  const markets = uniqueMarkets(positions);
  const nextUpdateMs = state.lastHeartbeatAt
    ? state.lastHeartbeatAt + state.settings.pollMinutes * 60_000
    : null;

  panel.append(
    row("Monitoring", state.monitoringStatus === "RUNNING" ? "Running" : "Stopped"),
    row("Mode", state.monitoringStatus === "RUNNING" ? state.executionMode : "-"),
    row("Detected positions", String(positions.length)),
    row("Markets", String(markets.length)),
    row("Last scan", fmtAge(state.lastPositionScanAt, now)),
    row("Next scan", fmtUntil(nextUpdateMs, now)),
    row(
      "Keep awake",
      state.keepAwakeStatus === "ERROR"
        ? `Error: ${state.keepAwakeError ?? "unknown"}`
        : state.keepAwakeStatus === "ACTIVE"
          ? "Active"
          : "Inactive"
    ),
    row(
      "Auto-close",
      state.executionMode === "ARMED_AUTO_CLOSE"
        ? `Armed ${state.autoCloseLive ? "LIVE" : "dry-run"} until ${state.armedUntil ? new Date(state.armedUntil).toLocaleTimeString() : "-"}`
        : "Disarmed"
    ),
    row("Last notification test", fmtAge(state.lastNotificationTestAt, now))
  );

  if (state.missedScheduledChecks > 0) {
    panel.append(
      el(
        "div",
        "banner danger",
        `${state.missedScheduledChecks} scheduled check(s) missed. Data was revalidated from scratch.`
      )
    );
  }

  if (state.monitoringStatus === "RUNNING") {
    panel.append(renderHeartbeatBanner(state, now));
  }

  return panel;
}

/** Watchdog indicator: distinguishes "the alarm is firing" from "scans are
 * actually completing" — see consecutiveScanFailures/monitorStalledSince
 * in RuntimeState and recordScanOutcome() in the service worker. */
function renderHeartbeatBanner(state: RuntimeState, now: number): HTMLElement {
  if (state.monitorStalledSince !== null) {
    const stalledMinutes = Math.round((now - state.monitorStalledSince) / 60_000);
    const lines = [
      "STALLED",
      `No successful cycle for ${stalledMinutes} minute${stalledMinutes === 1 ? "" : "s"}`,
    ];
    if (state.executionMode !== "ARMED_AUTO_CLOSE") {
      lines.push("LIVE Auto-Close disarmed");
    }
    const banner = el("div", "banner danger heartbeat-banner");
    for (const line of lines) banner.append(el("div", undefined, line));
    return banner;
  }

  const nextCycleMs = state.lastHeartbeatAt
    ? state.lastHeartbeatAt + state.settings.pollMinutes * 60_000
    : null;
  const lines = [
    "Healthy",
    `Last complete cycle: ${fmtAge(state.lastPositionScanAt, now)}`,
    `Next cycle: ${fmtUntil(nextCycleMs, now)}`,
  ];
  const banner = el("div", "banner ok heartbeat-banner");
  for (const line of lines) banner.append(el("div", undefined, line));
  return banner;
}

function renderPreflightCard(state: RuntimeState): HTMLElement | null {
  const preflight = state.livePreflight;
  if (!preflight) return null;
  const card = el("section", `preflight-card stack ${preflight.allowed ? "ok" : "warn"}`);
  card.append(el("h2", undefined, "Live Preflight"));
  card.append(row("Checked", new Date(preflight.checkedAt).toLocaleTimeString()));
  card.append(
    preflight.allowed
      ? el("div", "success-text", "LIVE arming checks passed.")
      : el("div", "warn-text", "LIVE arming blocked.")
  );
  if (preflight.blockers.length > 0) {
    const list = el("div", "reason-list");
    for (const blocker of preflight.blockers)
      list.append(el("div", "reason-line warn-text", blocker));
    card.append(list);
  }
  return card;
}

function renderExecutionStatusCard(state: RuntimeState): HTMLElement | null {
  const execution = state.closeExecution;
  if (!execution) return null;
  const tone =
    execution.state === "SUCCEEDED"
      ? "success-text"
      : execution.state === "FAILED" ||
          execution.state === "UNCERTAIN" ||
          execution.state === "BLOCKED"
        ? "warn-text"
        : "neutral-text";
  const card = el("section", "execution-status-card stack");
  card.append(el("h2", undefined, "Execution Status"));
  card.append(
    row("Position", `${execution.symbol}${execution.lotLabel ? ` ${execution.lotLabel}` : ""}`),
    row("Trigger", execution.trigger),
    row("Started", new Date(execution.startedAt).toLocaleTimeString()),
    row("Stage", execution.state),
    row("Result", execution.result ?? "In progress")
  );
  if (execution.details.length > 0) {
    const details = el("div", "reason-list");
    for (const detail of execution.details) details.append(el("div", tone, detail));
    card.append(details);
  }
  return card;
}

export function renderPositionCard(
  pos: TrackedPosition,
  _now: number,
  lotName: string | null = null,
  handlers?: Pick<ControlHandlers, "onPreviewClose" | "onRequestManualClose">
): HTMLElement {
  const card = el("article", "lot-card");
  const latest = pos.latest;
  const apiPrice = pos.latestApiPrice;
  const currentReturn = apiPrice !== null ? computeReturnForDisplay(pos, apiPrice) : null;
  const diagnostics = pos.strategyDiagnostics;

  const header = el("div", "lot-header");
  header.append(
    el("strong", undefined, lotName ?? "Lot A"),
    pill(decisionLabel(pos.decision), decisionTone(pos.decision))
  );
  card.append(header);

  const grid = el("div", "lot-metrics");
  grid.append(
    metric("Entry", fmtPrice(pos.openingPrice)),
    metric(
      "Return",
      fmtPct(currentReturn),
      currentReturn === null ? "neutral" : currentReturn >= 0 ? "ok" : "bad"
    ),
    metric("Peak", fmtPct(pos.peakReturnPct), pos.peakReturnPct > 0 ? "ok" : "neutral"),
    metric("Floor", pos.profitFloorPct !== null ? fmtPct(pos.profitFloorPct) : "-"),
    metric("Value", fmtUsd(latest?.valueUsd ?? null)),
    metric("API", fmtPrice(apiPrice)),
    metric("Regime", diagnostics?.regime ?? pos.regime ?? "UNKNOWN"),
    metric("Hard stop", fmtPct(diagnostics?.effectiveHardLossPct ?? null)),
    metric("SMA90", fmtPrice(diagnostics?.sma90 ?? null)),
    metric("ATR%", diagnostics?.atrPct !== null && diagnostics?.atrPct !== undefined ? fmtPct(diagnostics.atrPct * 100) : "-"),
    metric(
      "Slope",
      diagnostics
        ? `7 ${fmtSigned(diagnostics.slope7)} / 30 ${fmtSigned(diagnostics.slope30)} / 90 ${fmtSigned(diagnostics.slope90)}`
        : "-"
    )
  );
  card.append(grid);

  const reason = el("div", "reason-list");
  reason.append(el("span", "reason-title", "Why"));
  for (const line of reasonLines(pos)) {
    reason.append(el("div", "reason-line", line));
  }
  if (pos.autoCloseDisabledReason) {
    reason.append(el("div", "reason-line warn-text", pos.autoCloseDisabledReason));
  }
  reason.append(
    el(
      "div",
      "reason-line neutral-text",
      "Admin manual close can override strategy rules after Preview Close validates the exact Kraken row and close control."
    )
  );
  card.append(reason);

  const actions = el("div", "lot-actions");
  const previewButton = el("button", "small-button", "Preview Close");
  previewButton.addEventListener("click", () =>
    handlers?.onPreviewClose?.(pos, lotName ?? "Lot A")
  );
  actions.append(previewButton);
  const closeButton = el("button", "small-button", "Close Position");
  closeButton.title = "Starts the manual close flow for this exact lot.";
  closeButton.addEventListener("click", () =>
    handlers?.onRequestManualClose?.(pos, lotName ?? "Lot A")
  );
  actions.append(closeButton);
  card.append(actions);
  return card;
}

function renderManualClosePanel(
  state: ManualCloseUiState,
  handlers?: ControlHandlers
): HTMLElement | null {
  const pending = state.pending;
  if (!pending) return null;

  const panel = el("section", "manual-close-panel stack");
  panel.append(
    el(
      "h2",
      undefined,
      pending.phase === "MODAL_VALIDATED" || pending.phase === "SUBMITTING"
        ? "Kraken Close Dialog Validated"
        : `Close ${pending.symbol} ${pending.lotLabel}?`
    )
  );
  panel.append(
    row("Side", "Long"),
    row("Entry", fmtPrice(pending.entry)),
    row("Current price", fmtPrice(pending.currentPrice)),
    row("Position value", fmtUsd(pending.valueUsd)),
    row("Net P&L", fmtSignedUsd(pending.netPnl))
  );
  if (pending.modalSummary) panel.append(el("div", "success-text", pending.modalSummary));

  const actions = el("div", "controls");
  const cancel = el("button", undefined, "Cancel");
  cancel.addEventListener("click", () => handlers?.onCancelManualClose?.());
  const action =
    pending.phase === "MODAL_VALIDATED" || pending.phase === "SUBMITTING"
      ? el("button", "primary", pending.phase === "SUBMITTING" ? "Confirming..." : "Confirm Close")
      : el("button", "primary", "Open Kraken Close Dialog");
  action.disabled = pending.phase === "SUBMITTING";
  action.addEventListener("click", () => {
    if (pending.phase === "MODAL_VALIDATED") handlers?.onConfirmManualClose?.();
    if (pending.phase === "INITIAL_CONFIRM") handlers?.onContinueManualClose?.();
  });
  actions.append(cancel, action);
  panel.append(actions);
  return panel;
}

export function renderPositionsSection(
  state: RuntimeState,
  now: number,
  handlers?: ControlHandlers,
  previewState: PreviewCloseUiState = { message: null, error: null },
  manualCloseState: ManualCloseUiState = { pending: null }
): HTMLElement {
  const section = el("section", "panel stack primary-section");
  section.append(el("h2", undefined, "Positions"));

  if (previewState.message) section.append(el("div", "success-text", previewState.message));
  if (previewState.error) section.append(el("div", "warn-text", previewState.error));
  const preflightCard = renderPreflightCard(state);
  if (preflightCard) section.append(preflightCard);
  const executionCard = renderExecutionStatusCard(state);
  if (executionCard) section.append(executionCard);
  const manualClosePanel = renderManualClosePanel(manualCloseState, handlers);
  if (manualClosePanel) section.append(manualClosePanel);

  const positions = activePositions(state);
  if (positions.length === 0) {
    section.append(el("div", "empty-state", "No active LONG positions detected yet."));
    return section;
  }

  section.append(row("Total position value", fmtUsd(currentPositionValue(state))));

  const bySymbol = new Map<string, TrackedPosition[]>();
  for (const pos of positions) {
    const list = bySymbol.get(pos.symbol) ?? [];
    list.push(pos);
    bySymbol.set(pos.symbol, list);
  }

  for (const symbol of Array.from(bySymbol.keys()).sort()) {
    const lots = bySymbol.get(symbol)!.sort((a, b) => a.firstObservedAt - b.firstObservedAt);
    const market = el("div", "market-group");
    const header = el("div", "market-group-header");
    header.append(
      el("strong", undefined, symbol),
      el("span", undefined, `${lots.length} lot${lots.length === 1 ? "" : "s"}`)
    );
    market.append(header);
    lots.forEach((pos, i) => market.append(renderPositionCard(pos, now, lotLabel(i), handlers)));
    section.append(market);
  }
  return section;
}

function apiStatusTone(status: MarketDataRow["apiStatus"]): "ok" | "warn" | "bad" | "neutral" {
  switch (status) {
    case "OK":
      return "ok";
    case "STALE":
      return "warn";
    case "ERROR":
      return "bad";
  }
}

function trendTone(trend: MarketDataRow["trend"]): "ok" | "warn" | "neutral" {
  if (trend === "STRONG") return "ok";
  if (trend === "WEAK") return "warn";
  return "neutral";
}

function fmtSignedPct(value: number | null): string {
  return fmtPct(value);
}

function tradingViewUrl(apiMarket: string): string {
  const tvSymbol = apiMarket.replace("/", "").toUpperCase();
  return `https://www.tradingview.com/chart/?symbol=KRAKEN:${encodeURIComponent(tvSymbol)}`;
}

export function renderInterestedCoinsPanel(state: RuntimeState, now: number): HTMLElement {
  const panel = el("section", "panel stack");
  panel.append(el("h2", undefined, "Interested Kraken Coins"));
  panel.append(
    el(
      "div",
      "muted",
      "Read-only watchlist for BUY signals only — never auto-bought. Configure up to " +
        `${MAX_WATCHLIST_COINS} symbols in Settings.`
    )
  );

  const symbols = state.settings.watchlistCoins;
  if (symbols.length === 0) {
    panel.append(el("div", "empty-state", "No coins configured yet. Add some in Settings."));
    return panel;
  }

  for (const symbol of symbols) {
    const row_ = state.marketData[symbol];
    const signal = state.watchlistSignals[symbol];
    const card = el("article", "market-card");
    const header = el("div", "market-card-header");
    const confirmed = signal?.signalFiredForThisEpisode ?? false;
    header.append(
      el("strong", undefined, symbol),
      pill(
        confirmed ? "BUY SIGNAL" : row_?.trend === "STRONG" ? "Watching" : "No signal",
        confirmed ? "ok" : row_?.trend === "STRONG" ? "warn" : "neutral"
      )
    );
    card.append(header);
    if (!row_ || row_.apiStatus !== "OK") {
      card.append(el("div", "reason-line warn-text", row_?.errorMessage ?? "Market data not available yet."));
      panel.append(card);
      continue;
    }
    card.append(
      row("Current price", fmtPrice(row_.currentApiPrice)),
      row("SMA7", fmtPrice(row_.smaFast)),
      row("SMA30", fmtPrice(row_.smaSlow)),
      wrapRow("Trend", pill(row_.trend, trendTone(row_.trend))),
      row(
        "Golden-cross progress",
        signal
          ? `${signal.consecutiveClosesAboveSmaFast}/${state.settings.strongTrendConfirmationCloses} closes above SMA7`
          : "Not yet evaluated"
      ),
      row("Last checked", fmtAge(row_.lastUpdatedAt, now))
    );
    panel.append(card);
  }
  return panel;
}

export function renderMarketDataPanel(
  state: RuntimeState,
  now: number,
  handlers?: Pick<ControlHandlers, "onRefreshMarketData">,
  refreshState: MarketRefreshUiState = { refreshing: null, message: null, error: null }
): HTMLElement {
  const panel = el("section", "panel stack");
  panel.append(el("h2", undefined, "Market Data"));

  const rows = Object.values(state.marketData).sort((a, b) => a.symbol.localeCompare(b.symbol));
  const apiOk = rows.length > 0 && rows.every((r) => r.apiStatus === "OK");
  const meta = el("div", "panel-meta");
  meta.append(
    el("span", undefined, `Last refreshed ${fmtAge(state.lastPriceUpdateAt, now)}`),
    el("span", undefined, `Next automatic refresh ${fmtUntil(state.nextMarketRefreshAt, now)}`),
    el("span", undefined, `Auto-refresh every ${state.settings.marketRefreshMinutes} min`),
    el(
      "span",
      undefined,
      `Monitoring ${state.monitoringStatus === "RUNNING" ? "Running" : "Stopped"}`
    ),
    el("span", undefined, `${rows.length} symbols`),
    el("span", undefined, apiOk ? "API Healthy" : "API pending/error")
  );
  panel.append(meta);

  const allRefreshing = refreshState.refreshing?.kind === "all";
  const refreshAll = el(
    "button",
    "primary",
    allRefreshing ? "Refreshing..." : "Refresh Positions + Market Data"
  );
  refreshAll.disabled = refreshState.refreshing !== null;
  refreshAll.addEventListener("click", () => handlers?.onRefreshMarketData?.());
  panel.append(refreshAll);
  if (refreshState.message) panel.append(el("div", "success-text", refreshState.message));
  if (refreshState.error) panel.append(el("div", "warn-text", refreshState.error));

  if (rows.length === 0) {
    panel.append(el("div", "empty-state", "No market data yet."));
    return panel;
  }

  const lotsBySymbol = new Map<string, TrackedPosition[]>();
  for (const pos of activePositions(state)) {
    const list = lotsBySymbol.get(pos.symbol) ?? [];
    list.push(pos);
    lotsBySymbol.set(pos.symbol, list);
  }

  for (const r of rows) {
    const lots = lotsBySymbol.get(r.symbol) ?? [];
    const uiPrices = lots
      .map((p) => p.latest?.currentPriceUi ?? null)
      .filter((price): price is number => price !== null);
    const uiPrice =
      uiPrices.length > 0
        ? uiPrices.reduce((sum, price) => sum + price, 0) / uiPrices.length
        : null;
    const diffPct =
      uiPrice !== null && r.currentApiPrice !== null
        ? ((uiPrice - r.currentApiPrice) / r.currentApiPrice) * 100
        : null;

    const card = el("article", "market-card");
    const header = el("div", "market-card-header");
    const symbolRefreshing =
      refreshState.refreshing?.kind === "symbol" && refreshState.refreshing.symbol === r.symbol;
    const refreshOne = el("button", "small-button", symbolRefreshing ? "Refreshing..." : "Refresh");
    refreshOne.disabled = refreshState.refreshing !== null;
    refreshOne.addEventListener("click", () => handlers?.onRefreshMarketData?.(r.symbol));
    const chartLink = el("a", "small-button", "Chart");
    chartLink.href = tradingViewUrl(r.apiMarket);
    chartLink.target = "_blank";
    chartLink.rel = "noopener noreferrer";
    const headerActions = el("div", "market-actions");
    headerActions.append(
      pill(r.apiStatus === "OK" ? "Healthy" : r.apiStatus, apiStatusTone(r.apiStatus)),
      chartLink,
      refreshOne
    );
    header.append(el("strong", undefined, r.symbol), headerActions);
    card.append(header);
    card.append(
      row("Source", r.source === "DETECTED_POSITION" ? "Detected" : "Watchlist"),
      row("API market", r.apiMarket),
      row("Current price", fmtPrice(r.currentApiPrice)),
      row("Kraken visible price", fmtPrice(uiPrice)),
      row("API/UI difference", fmtSignedPct(diffPct)),
      row("Last 1h close", fmtPrice(r.lastCompletedClose)),
      row("SMA7", fmtPrice(r.smaFast)),
      row("SMA30", fmtPrice(r.smaSlow)),
      wrapRow("Trend", pill(r.trend, trendTone(r.trend))),
      row("Price vs SMA7", fmtSignedPct(r.vsSmaFastPct)),
      row("Price vs SMA30", fmtSignedPct(r.vsSmaSlowPct)),
      row("Last completed candle", fmtAge(r.latestCandleTs, now)),
      row("API data age", fmtAge(r.lastUpdatedAt, now)),
      row("Candles", String(r.completedCandleCount)),
      row("Forming candle excluded", r.formingCandleExcluded ? "yes" : "no")
    );
    if (r.errorMessage) card.append(el("div", "reason-line warn-text", r.errorMessage));
    panel.append(card);
  }
  return panel;
}

function humanizeEvent(entry: AuditLogEntry): string {
  switch (entry.eventType) {
    case "MONITORING_STARTED":
      return "Monitoring started";
    case "MONITORING_STOPPED":
      return "Monitoring stopped";
    case "AUTO_CLOSE_ARMED":
      return "Auto-Close armed";
    case "AUTO_CLOSE_DISARMED":
      return "Auto-Close disarmed";
    case "AUTO_CLOSE_EXPIRED":
      return "Auto-Close expired";
    case "AUTO_CLOSE_DRY_RUN_INTENT":
      return "Auto-Close dry-run intent";
    case "AUTO_CLOSE_EXECUTION_STARTED":
      return "Live Auto-Close started";
    case "AUTO_CLOSE_SUCCEEDED":
      return "Live Auto-Close succeeded";
    case "LOGIN_REQUIRED":
      return "Kraken login required";
    case "TEST_NOTIFICATION":
      return entry.executionResult === "FAILURE"
        ? "Test notification failed"
        : "Test notification sent";
    case "SELL_CONDITION_TRIGGERED":
      return "Exit condition triggered";
    case "STALE_MARKET_DATA":
      return "Market data stale";
    case "UNSUPPORTED_SYMBOL":
      return "Unsupported symbol";
    case "POSITION_CHANGED":
      return "Position changed";
    case "POSITION_SCAN_COMPLETED":
      return "Position scan completed";
    case "DUPLICATE_OR_AMBIGUOUS_ROW":
      return "Ambiguous position row";
    case "API_UI_PRICE_MISMATCH":
      return "API/UI price mismatch";
    case "SLEEP_INTERRUPTION_DETECTED":
      return "Sleep interruption detected";
    case "MARKET_REFRESH_FAILED":
      return "Market refresh failed";
    case "KRAKEN_TAB_MISSING":
      return "Kraken tab missing";
    default:
      return entry.eventType
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (char) => char.toUpperCase());
  }
}

function eventSeverity(entry: AuditLogEntry): "Info" | "Success" | "Warning" | "Critical" {
  if (entry.executionResult === "SUCCESS") return "Success";
  if (entry.executionResult === "FAILURE") return "Critical";
  if (["LOGIN_REQUIRED", "KRAKEN_TAB_MISSING", "CLOSE_FAILED"].includes(entry.eventType))
    return "Critical";
  if (
    [
      "SELL_CONDITION_TRIGGERED",
      "STALE_MARKET_DATA",
      "UNSUPPORTED_SYMBOL",
      "POSITION_CHANGED",
      "DUPLICATE_OR_AMBIGUOUS_ROW",
      "API_UI_PRICE_MISMATCH",
      "SLEEP_INTERRUPTION_DETECTED",
      "AUTO_CLOSE_DRY_RUN_INTENT",
      "AUTO_CLOSE_EXECUTION_STARTED",
    ].includes(entry.eventType)
  ) {
    return "Warning";
  }
  if (["MONITORING_STARTED", "POSITION_CLOSED", "AUTO_CLOSE_SUCCEEDED"].includes(entry.eventType))
    return "Success";
  return "Info";
}

function severityTone(
  severity: "Info" | "Success" | "Warning" | "Critical"
): "ok" | "warn" | "bad" | "neutral" {
  switch (severity) {
    case "Success":
      return "ok";
    case "Warning":
      return "warn";
    case "Critical":
      return "bad";
    default:
      return "neutral";
  }
}

export function renderLogsSection(
  entries: AuditLogEntry[],
  handlers?: ControlHandlers,
  state?: RuntimeState
): HTMLElement {
  const panel = el("section", "panel stack");
  panel.append(el("h2", undefined, "Notifications"));
  if (handlers) {
    const controls = el("div", "controls");
    const test = el("button", undefined, "Test Notification");
    test.addEventListener("click", handlers.onTestNotification);
    const exportBtn = el("button", undefined, "Export Logs");
    exportBtn.addEventListener("click", handlers.onExportLogs);
    const clear = el("button", undefined, "Clear Activity");
    clear.addEventListener("click", () => handlers.onClearLogs?.());
    controls.append(test, exportBtn, clear);
    panel.append(controls);
  }
  if (state) {
    const executionCard = renderExecutionStatusCard(state);
    if (executionCard) panel.append(executionCard);
  }
  if (entries.length === 0) {
    panel.append(el("div", "empty-state", "No activity yet."));
    return panel;
  }
  const timeline = el("div", "timeline");
  const recent = entries.slice(-10).reverse();
  for (const entry of recent) {
    const item = el("div", "timeline-item");
    const body = el("div", "timeline-body");
    const severity = eventSeverity(entry);
    const title = el("div", "timeline-title");
    title.append(
      el("strong", undefined, humanizeEvent(entry)),
      pill(severity, severityTone(severity))
    );
    body.append(title);
    const details = [entry.symbol, entry.reason, entry.errorDetails].filter(Boolean).join(" - ");
    if (details) body.append(el("span", undefined, details));
    item.append(el("time", undefined, new Date(entry.timestamp).toLocaleTimeString()), body);
    timeline.append(item);
  }
  panel.append(timeline);
  return panel;
}

export function renderDiagnosticsSection(
  report: DiagnosticsReport | null,
  error: string | null,
  onCopy: () => void
): HTMLElement {
  const panel = el("section", "panel stack diagnostics-panel");
  panel.append(el("h2", undefined, "Diagnostics"));

  if (error) {
    panel.append(el("div", "banner danger", error));
    return panel;
  }
  if (!report) {
    panel.append(el("div", "empty-state", "Diagnostics have not been run."));
    return panel;
  }

  panel.append(
    row("Logged-in state", report.loggedInState),
    row("Open positions", report.positionsSectionDetected ? "Detected" : "Not detected"),
    row("Rows", `${report.parsedPositionCount}/${report.candidateRowCount} parsed`),
    row("Discovery", report.rowDiscoveryMethod),
    row("URL", report.url)
  );

  const copyBtn = el("button", undefined, "Copy Sanitized Diagnostics");
  copyBtn.addEventListener("click", onCopy);
  panel.append(copyBtn);

  if (report.groups.length > 0) {
    panel.append(el("div", "section-title", `Groups (${report.groups.length})`));
    for (const g of report.groups) {
      const line = el("div", "reason");
      line.append(
        el(
          "div",
          undefined,
          `${g.symbol}: ${g.actionableChildRowIndexes.length} actionable row(s)${
            g.ambiguous ? ` - ambiguous: ${g.ambiguityReason ?? ""}` : ""
          }`
        )
      );
      panel.append(line);
    }
  }
  return panel;
}

function controlSummary(label: string, info: OrderFormDiagnosticsReport["buyTabControl"]): HTMLElement {
  if (!info) return row(label, "Not found");
  const detail = info.ambiguous
    ? `${info.candidateCount} candidates (ambiguous)`
    : (info.accessibleName ?? "found, no accessible name");
  return row(label, detail);
}

/** Read-only report of Kraken's Buy/Open order form + account-equity
 * display — this is calibration data, not a working feature. See
 * order-form-diagnostics.ts's doc comment: nothing here has been clicked,
 * filled, or submitted. */
export function renderOrderFormDiagnosticsSection(
  report: OrderFormDiagnosticsReport | null,
  error: string | null
): HTMLElement {
  const panel = el("section", "panel stack diagnostics-panel");
  panel.append(el("h2", undefined, "Order-Form Diagnostics (read-only, not yet a working feature)"));

  if (error) {
    panel.append(el("div", "banner danger", error));
    return panel;
  }
  if (!report) {
    panel.append(el("div", "empty-state", "Order-form diagnostics have not been run."));
    return panel;
  }

  panel.append(
    row("Order entry panel", report.orderEntryPanelDetected ? "Detected" : "Not detected"),
    controlSummary("Buy tab", report.buyTabControl),
    row("Buy tab selected", String(report.buyTabSelected)),
    controlSummary("Sell tab", report.sellTabControl),
    row("Sell tab selected", String(report.sellTabSelected)),
    row("Quantity input", report.quantityInputDetected ? "Detected" : "Not detected"),
    row("Quantity current value", report.quantityInputCurrentValue ?? "-"),
    row("Quantity step", report.quantityInputStep ?? "-"),
    row("Leverage (read-only)", report.leverageValueText ?? "Not found"),
    row("Order type is Market", String(report.orderTypeIsMarket)),
    row("Order type is Limit", String(report.orderTypeIsLimit)),
    controlSummary("Submit control", report.submitControl),
    row("Account equity label found", report.accountEquityLabelFound ? "Yes" : "No"),
    row("Account equity text", report.accountEquityText ?? "-"),
    row("Account equity parsed", report.accountEquityParsed !== null ? String(report.accountEquityParsed) : "-")
  );

  if (report.rawPanelTextExcerpt) {
    panel.append(el("div", "section-title", "Raw panel text (sanitized excerpt)"));
    panel.append(el("div", "reason", report.rawPanelTextExcerpt));
  }
  return panel;
}

export interface SettingsHandlers {
  onSaveSettings: (settings: Settings) => void;
  onResetSettings: () => void;
  onRunDiagnostics: () => void;
  onRunOrderFormDiagnostics: () => void;
  onExportLogs: () => void;
}

function numberInput(name: keyof Settings, label: string, value: number, step = "1"): HTMLElement {
  const wrapper = el("label", "field");
  wrapper.append(el("span", undefined, label));
  const input = el("input");
  input.name = name;
  input.type = "number";
  input.step = step;
  input.value = String(value);
  wrapper.append(input);
  return wrapper;
}

function textInput(
  name: keyof Settings,
  label: string,
  value: string,
  placeholder?: string
): HTMLElement {
  const wrapper = el("label", "field");
  wrapper.append(el("span", undefined, label));
  const input = el("input");
  input.name = name;
  input.type = "text";
  input.value = value;
  if (placeholder) input.placeholder = placeholder;
  wrapper.append(input);
  return wrapper;
}

function readText(form: HTMLFormElement, key: keyof Settings): string {
  const input = form.elements.namedItem(key) as HTMLInputElement | null;
  return input?.value.trim() ?? "";
}

function checkboxInput(name: keyof Settings, label: string, checked: boolean): HTMLElement {
  const wrapper = el("label", "field checkbox-field");
  const input = el("input");
  input.name = name;
  input.type = "checkbox";
  input.checked = checked;
  wrapper.append(input, el("span", undefined, label));
  return wrapper;
}

function readNumber(form: HTMLFormElement, key: keyof Settings): number {
  const input = form.elements.namedItem(key) as HTMLInputElement | null;
  return input ? Number(input.value) : Number.NaN;
}

function readCheckbox(form: HTMLFormElement, key: keyof Settings): boolean {
  const input = form.elements.namedItem(key) as HTMLInputElement | null;
  return input?.checked ?? false;
}

function parseWatchlistCoinsInput(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[,\s]+/)
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0)
    )
  );
}

function validateSettings(settings: Settings): string[] {
  const errors: string[] = [];
  if (
    !Number.isFinite(settings.pollMinutes) ||
    settings.pollMinutes < 1 ||
    settings.pollMinutes > 60
  ) {
    errors.push("Polling interval must be between 1 and 60 minutes.");
  }
  if (
    !Number.isInteger(settings.marketRefreshMinutes) ||
    settings.marketRefreshMinutes < 1 ||
    settings.marketRefreshMinutes > 60
  ) {
    errors.push("Market refresh interval must be a whole number between 1 and 60 minutes.");
  }
  if (!Number.isInteger(settings.fastSma) || settings.fastSma <= 0) {
    errors.push("SMA fast period must be a positive integer.");
  }
  if (!Number.isInteger(settings.slowSma) || settings.slowSma <= settings.fastSma) {
    errors.push("SMA slow period must be greater than SMA fast.");
  }
  if (
    !Number.isFinite(settings.hardLossPercent) ||
    settings.hardLossPercent > 0 ||
    settings.hardLossPercent < -100
  ) {
    errors.push("Hard-loss threshold must be a negative percentage between -100 and 0.");
  }
  if (
    !Number.isFinite(settings.profitLockActivationPercent) ||
    settings.profitLockActivationPercent < 0 ||
    settings.profitLockActivationPercent > 100
  ) {
    errors.push("Profit-lock activation must be between 0 and 100%.");
  }
  if (
    !Number.isFinite(settings.apiUiPriceTolerancePercent) ||
    settings.apiUiPriceTolerancePercent < 0 ||
    settings.apiUiPriceTolerancePercent > 20
  ) {
    errors.push("API/UI price tolerance must be between 0 and 20%.");
  }
  if (!Number.isInteger(settings.longSma) || settings.longSma <= settings.slowSma) {
    errors.push("SMA90 period must be greater than SMA30.");
  }
  if (!Number.isInteger(settings.atrPeriod) || settings.atrPeriod < 1) {
    errors.push("ATR period must be a positive integer.");
  }
  if (
    !Number.isInteger(settings.slope7LookbackHours) ||
    !Number.isInteger(settings.slope30LookbackHours) ||
    !Number.isInteger(settings.slope90LookbackHours) ||
    settings.slope7LookbackHours < 1 ||
    settings.slope30LookbackHours < 1 ||
    settings.slope90LookbackHours < 1 ||
    settings.slope90LookbackHours >= settings.longSma
  ) {
    errors.push("Slope lookbacks must be positive whole numbers and shorter than SMA90 history.");
  }
  if (
    !Number.isFinite(settings.hardLossFallbackPct) ||
    !Number.isFinite(settings.hardLossMinDistancePct) ||
    !Number.isFinite(settings.hardLossMaxDistancePct) ||
    settings.hardLossMaxDistancePct > settings.hardLossMinDistancePct ||
    settings.hardLossMinDistancePct >= 0 ||
    settings.hardLossMaxDistancePct >= 0
  ) {
    errors.push("Hard-loss thresholds must be negative percentages ordered from max distance to min distance.");
  }
  if (!Number.isFinite(settings.hardLossAtrMultiple) || settings.hardLossAtrMultiple < 0) {
    errors.push("Hard-loss ATR multiple must be non-negative.");
  }
  if (!Number.isInteger(settings.hardLossRequiredObservations) || settings.hardLossRequiredObservations < 1) {
    errors.push("Hard-loss observations must be at least 1.");
  }
  if (!Number.isFinite(settings.hardLossConfirmationSeconds) || settings.hardLossConfirmationSeconds < 0) {
    errors.push("Hard-loss confirmation duration must be non-negative.");
  }
  if (!Number.isFinite(settings.profitActivationPct) || settings.profitActivationPct < 0) {
    errors.push("Profit activation percentage must be non-negative.");
  }
  if (!Number.isFinite(settings.profitActivationAtrMultiple) || settings.profitActivationAtrMultiple < 0) {
    errors.push("Profit activation ATR multiple must be non-negative.");
  }
  for (const [label, value] of [
    ["Major trend ATR buffer", settings.majorTrendBreakAtrBuffer],
    ["Expansion floor ATR buffer", settings.expansionFloorAtrBuffer],
    ["Deterioration ATR buffer", settings.deteriorationAtrBreakBuffer],
    ["Expansion fast-break ATR buffer", settings.expansionFastBreakAtrBuffer],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) errors.push(`${label} must be non-negative.`);
  }
  if (
    !Number.isInteger(settings.strongTrendConfirmationCloses) ||
    settings.strongTrendConfirmationCloses < 1
  ) {
    errors.push("Strong-trend confirmations must be a positive integer.");
  }
  if (
    !Number.isInteger(settings.weakTrendConfirmationCloses) ||
    settings.weakTrendConfirmationCloses < 1
  ) {
    errors.push("Weak-trend confirmations must be a positive integer.");
  }
  if (
    !Number.isInteger(settings.maxLiveClosesPerHour) ||
    settings.maxLiveClosesPerHour < 1 ||
    settings.maxLiveClosesPerHour > 10
  ) {
    errors.push("Max live closes per hour must be a whole number between 1 and 10.");
  }
  if (
    !Number.isInteger(settings.maxLiveClosesPerArmedSession) ||
    settings.maxLiveClosesPerArmedSession < 1 ||
    settings.maxLiveClosesPerArmedSession > 20
  ) {
    errors.push("Max live closes per armed session must be a whole number between 1 and 20.");
  }
  if (
    !Number.isInteger(settings.autoCloseSignalExpiryMinutes) ||
    settings.autoCloseSignalExpiryMinutes < 1 ||
    settings.autoCloseSignalExpiryMinutes > 30
  ) {
    errors.push("Signal expiry must be a whole number between 1 and 30 minutes.");
  }
  if (
    !Number.isInteger(settings.closeVerificationTimeoutSeconds) ||
    settings.closeVerificationTimeoutSeconds < 3 ||
    settings.closeVerificationTimeoutSeconds > 60
  ) {
    errors.push("Close verification timeout must be a whole number between 3 and 60 seconds.");
  }
  if (
    settings.executionWebhookUrl &&
    !isSupportedExecutionWebhookUrl(settings.executionWebhookUrl)
  ) {
    errors.push(
      "Phone notification URL must be an https://ntfy.sh/<topic> URL, or left blank to disable."
    );
  }
  if (settings.executionEmailAddress && !isPlausibleEmailAddress(settings.executionEmailAddress)) {
    errors.push("Execution email address doesn't look valid, or leave it blank to disable.");
  }
  if (settings.watchlistCoins.length > MAX_WATCHLIST_COINS) {
    errors.push(
      `Interested Kraken Coins: at most ${MAX_WATCHLIST_COINS} symbols allowed (entered ${settings.watchlistCoins.length}).`
    );
  }
  const invalidWatchlistSymbols = settings.watchlistCoins.filter(
    (symbol) => !/^[A-Z][A-Z0-9]{1,9}$/.test(symbol)
  );
  if (invalidWatchlistSymbols.length > 0) {
    errors.push(`Interested Kraken Coins: invalid symbol(s): ${invalidWatchlistSymbols.join(", ")}.`);
  }
  return errors;
}

export function renderSettingsPanel(state: RuntimeState, handlers: SettingsHandlers): HTMLElement {
  const panel = el("section", "panel stack settings-panel");
  panel.append(el("h2", undefined, "Settings"));

  const form = el("form", "settings-form");
  const errorBox = el("div", "settings-errors");
  errorBox.hidden = true;

  form.append(
    el("div", "section-title", "Monitoring"),
    numberInput("pollMinutes", "Polling interval (minutes)", state.settings.pollMinutes),
    numberInput(
      "marketRefreshMinutes",
      "Market refresh interval (minutes)",
      state.settings.marketRefreshMinutes
    ),
    el("div", "section-title", "Indicators"),
    row("Candle timeframe", "1 hour (fixed for now)"),
    numberInput("fastSma", "SMA fast period", state.settings.fastSma),
    numberInput("slowSma", "SMA slow period", state.settings.slowSma),
    numberInput("longSma", "SMA long period", state.settings.longSma),
    numberInput("atrPeriod", "ATR period", state.settings.atrPeriod),
    numberInput("slope7LookbackHours", "SMA7 slope lookback", state.settings.slope7LookbackHours),
    numberInput("slope30LookbackHours", "SMA30 slope lookback", state.settings.slope30LookbackHours),
    numberInput("slope90LookbackHours", "SMA90 slope lookback", state.settings.slope90LookbackHours),
    el("div", "section-title", "Risk"),
    numberInput("hardLossFallbackPct", "Hard-loss fallback %", state.settings.hardLossFallbackPct, "0.1"),
    numberInput("hardLossMinDistancePct", "Hard-loss min distance %", state.settings.hardLossMinDistancePct, "0.1"),
    numberInput("hardLossMaxDistancePct", "Hard-loss max distance %", state.settings.hardLossMaxDistancePct, "0.1"),
    numberInput("hardLossAtrMultiple", "Hard-loss ATR multiple", state.settings.hardLossAtrMultiple, "0.1"),
    numberInput("hardLossConfirmationSeconds", "Hard-loss confirmation seconds", state.settings.hardLossConfirmationSeconds),
    numberInput("hardLossRequiredObservations", "Hard-loss observations", state.settings.hardLossRequiredObservations),
    numberInput("profitActivationPct", "Profit activation %", state.settings.profitActivationPct, "0.1"),
    numberInput("profitActivationAtrMultiple", "Profit activation ATR multiple", state.settings.profitActivationAtrMultiple, "0.1"),
    numberInput("majorTrendBreakAtrBuffer", "Major trend ATR buffer", state.settings.majorTrendBreakAtrBuffer, "0.01"),
    numberInput("expansionFloorAtrBuffer", "Expansion floor ATR buffer", state.settings.expansionFloorAtrBuffer, "0.01"),
    numberInput("deteriorationAtrBreakBuffer", "Deterioration ATR buffer", state.settings.deteriorationAtrBreakBuffer, "0.01"),
    numberInput("expansionFastBreakAtrBuffer", "Expansion fast-break ATR buffer", state.settings.expansionFastBreakAtrBuffer, "0.01"),
    el("div", "profit-tiers"),
    row("3% to below 7%", "retain 50%"),
    row("7% to below 15%", "retain 65%"),
    row("15% and above", "retain 75%"),
    el("div", "section-title", "SMA confirmation"),
    numberInput(
      "strongTrendConfirmationCloses",
      "Strong trend closes",
      state.settings.strongTrendConfirmationCloses
    ),
    numberInput(
      "weakTrendConfirmationCloses",
      "Weak trend closes",
      state.settings.weakTrendConfirmationCloses
    ),
    el("div", "section-title", "Data validation"),
    numberInput(
      "apiUiPriceTolerancePercent",
      "API/UI tolerance %",
      state.settings.apiUiPriceTolerancePercent,
      "0.1"
    ),
    row("Stale-data threshold", `${state.settings.candleIntervalMinutes + 30} minutes (derived)`),
    el("div", "section-title", "Live execution limits"),
    numberInput(
      "maxLiveClosesPerHour",
      "Max live closes per hour",
      state.settings.maxLiveClosesPerHour
    ),
    numberInput(
      "maxLiveClosesPerArmedSession",
      "Max live closes per armed session",
      state.settings.maxLiveClosesPerArmedSession
    ),
    numberInput(
      "autoCloseSignalExpiryMinutes",
      "Signal expiry (minutes)",
      state.settings.autoCloseSignalExpiryMinutes
    ),
    numberInput(
      "closeVerificationTimeoutSeconds",
      "Verification timeout (seconds)",
      state.settings.closeVerificationTimeoutSeconds
    ),
    el("div", "section-title", "Notifications"),
    row("Chrome notifications", "enabled by browser permission"),
    checkboxInput("alarmSoundEnabled", "Alarm sound enabled", state.settings.alarmSoundEnabled),
    textInput(
      "executionWebhookUrl",
      "Phone notification URL (ntfy.sh)",
      state.settings.executionWebhookUrl,
      "https://ntfy.sh/your-private-topic"
    ),
    el(
      "div",
      "muted",
      "Optional. Fires ONLY when a close execution finishes (success, failure, or uncertain) — never for " +
        "monitoring start/stop, signals, or arming. Get the free ntfy app, subscribe to a topic name you make up, " +
        "and paste https://ntfy.sh/<that-topic> here. Leave blank to disable."
    ),
    textInput(
      "executionEmailAddress",
      "Also email execution alerts to",
      state.settings.executionEmailAddress,
      "you@example.com"
    ),
    el(
      "div",
      "muted",
      "Optional add-on to the ntfy URL above (only works if that's set) — ntfy.sh relays the same alert to " +
        "this address for free, no extra signup. Rate-limited by ntfy.sh's own free tier. Leave blank to skip email."
    ),
    el("div", "section-title", "Interested Kraken Coins"),
    textInput(
      "watchlistCoins",
      `Coins to watch for BUY signals (max ${MAX_WATCHLIST_COINS})`,
      state.settings.watchlistCoins.join(", "),
      "SOL, AVAX, LINK"
    ),
    el(
      "div",
      "muted",
      `Comma or space separated, up to ${MAX_WATCHLIST_COINS} symbols. Entirely separate from open positions — ` +
        "tracked read-only for a golden-cross (SMA7 crosses above SMA30, confirmed) pattern. Sends a clearly " +
        "distinct \"BUY SIGNAL\" push to the same phone notification URL above — never an order. Kraken can " +
        "never auto-buy; you place any order yourself. Leave blank to disable."
    ),
    el("div", "section-title", "Start Monitoring behavior"),
    checkboxInput(
      "startMonitoringWithLiveAutoClose",
      "Start Monitoring with LIVE Auto-Close",
      state.settings.startMonitoringWithLiveAutoClose
    ),
    el(
      "div",
      "muted",
      "Default OFF. When ON, Start Monitoring shows one live-trading confirmation and, if you accept, " +
        "arms LIVE Auto-Close automatically once monitoring passes preflight. The separate two-step flow " +
        "(Start Monitoring, then Arm LIVE Auto-Close) always remains available regardless of this setting."
    ),
    el("div", "section-title", "Developer / testing"),
    row("Watchlist symbols", DEV_WATCHLIST_SYMBOLS.join(", ")),
    errorBox
  );

  const actions = el("div", "controls");
  const save = el("button", "primary", "Save Settings");
  save.type = "submit";
  const reset = el("button", undefined, "Reset to Defaults");
  reset.type = "button";
  reset.addEventListener("click", handlers.onResetSettings);
  const diagnostics = el("button", undefined, "Diagnostics");
  diagnostics.type = "button";
  diagnostics.addEventListener("click", handlers.onRunDiagnostics);
  const orderFormDiagnostics = el("button", undefined, "Run Order-Form Diagnostics");
  orderFormDiagnostics.type = "button";
  orderFormDiagnostics.title =
    "Read-only. Open the real Buy tab and account details on Kraken first, then run this — never clicks/fills/submits anything.";
  orderFormDiagnostics.addEventListener("click", handlers.onRunOrderFormDiagnostics);
  const exportLogs = el("button", undefined, "Export Logs");
  exportLogs.type = "button";
  exportLogs.addEventListener("click", handlers.onExportLogs);
  actions.append(save, reset, diagnostics, orderFormDiagnostics, exportLogs);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const next: Settings = {
      ...state.settings,
      pollMinutes: readNumber(form, "pollMinutes"),
      marketRefreshMinutes: readNumber(form, "marketRefreshMinutes"),
      fastSma: readNumber(form, "fastSma"),
      slowSma: readNumber(form, "slowSma"),
      longSma: readNumber(form, "longSma"),
      atrPeriod: readNumber(form, "atrPeriod"),
      slope7LookbackHours: readNumber(form, "slope7LookbackHours"),
      slope30LookbackHours: readNumber(form, "slope30LookbackHours"),
      slope90LookbackHours: readNumber(form, "slope90LookbackHours"),
      hardLossFallbackPct: readNumber(form, "hardLossFallbackPct"),
      hardLossMinDistancePct: readNumber(form, "hardLossMinDistancePct"),
      hardLossMaxDistancePct: readNumber(form, "hardLossMaxDistancePct"),
      hardLossAtrMultiple: readNumber(form, "hardLossAtrMultiple"),
      hardLossConfirmationSeconds: readNumber(form, "hardLossConfirmationSeconds"),
      hardLossRequiredObservations: readNumber(form, "hardLossRequiredObservations"),
      profitActivationPct: readNumber(form, "profitActivationPct"),
      profitActivationAtrMultiple: readNumber(form, "profitActivationAtrMultiple"),
      majorTrendBreakAtrBuffer: readNumber(form, "majorTrendBreakAtrBuffer"),
      expansionFloorAtrBuffer: readNumber(form, "expansionFloorAtrBuffer"),
      deteriorationAtrBreakBuffer: readNumber(form, "deteriorationAtrBreakBuffer"),
      expansionFastBreakAtrBuffer: readNumber(form, "expansionFastBreakAtrBuffer"),
      strongTrendConfirmationCloses: readNumber(form, "strongTrendConfirmationCloses"),
      weakTrendConfirmationCloses: readNumber(form, "weakTrendConfirmationCloses"),
      apiUiPriceTolerancePercent: readNumber(form, "apiUiPriceTolerancePercent"),
      maxLiveClosesPerHour: readNumber(form, "maxLiveClosesPerHour"),
      maxLiveClosesPerArmedSession: readNumber(form, "maxLiveClosesPerArmedSession"),
      autoCloseSignalExpiryMinutes: readNumber(form, "autoCloseSignalExpiryMinutes"),
      closeVerificationTimeoutSeconds: readNumber(form, "closeVerificationTimeoutSeconds"),
      alarmSoundEnabled: readCheckbox(form, "alarmSoundEnabled"),
      startMonitoringWithLiveAutoClose: readCheckbox(form, "startMonitoringWithLiveAutoClose"),
      executionWebhookUrl: readText(form, "executionWebhookUrl"),
      executionEmailAddress: readText(form, "executionEmailAddress"),
      watchlistCoins: parseWatchlistCoinsInput(readText(form, "watchlistCoins")),
    };
    const errors = validateSettings(next);
    if (errors.length > 0) {
      errorBox.hidden = false;
      errorBox.replaceChildren(...errors.map((message) => el("div", "warn-text", message)));
      return;
    }
    errorBox.hidden = true;
    errorBox.replaceChildren();
    handlers.onSaveSettings(next);
  });

  panel.append(form, actions);
  return panel;
}
