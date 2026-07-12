import {
  fetchCompletedHourlyCandles,
  fetchCurrentPrice,
  MarketDataError,
} from "../api/kraken-public";
import { resolvePublicMarket } from "../api/symbols";
import {
  ALARM_NAME_MARKET_REFRESH,
  ALARM_NAME_POLL,
  DEFAULT_SETTINGS,
  KRAKEN_PROP_URL_PATTERN,
} from "../shared/constants";
import type {
  DomDiagnosticsResultMessage,
  ExportLogsResultMessage,
  ExtensionMessage,
  ConfirmCloseDialogResultMessage,
  ConfirmBuyOrderResultMessage,
  OpenBuyOrderResultMessage,
  OpenCloseDialogResultMessage,
  OrderFormDiagnosticsResultMessage,
  PreviewCloseResultMessage,
  RefreshMarketDataResultMessage,
  ScanResultMessage,
  StateSnapshotMessage,
} from "../shared/messages";
import { isExtensionMessage } from "../shared/messages";
import type {
  AuditEventType,
  AuditLogEntry,
  CloseExecutionRecord,
  CloseExecutionState,
  LiveAutoClosePreflightResult,
  OperatingMode,
  RuntimeState,
  TrackedPosition,
} from "../shared/types";
import { checkPriceTolerance, validateCandles } from "../shared/validation";
import {
  computeCurrentReturnPct,
  determineTrend,
  evaluateVolatilityAdjustedStrategy,
  isNewCloseTransition,
} from "../strategy/exit-strategy";
import { reconcilePositions } from "../strategy/state-machine";
import { classifySignalTier, isNewSignalEscalation } from "../strategy/signal-engine";
import { appendAuditEntry, clearAuditLog, exportAuditLogAsJson } from "../storage/audit-log";
import { getState, updateState } from "../storage/state";
import { buildMarketDataTable } from "./market-data-table";
import {
  detectSleepGap,
  startMarketDataPolling,
  startPolling,
  stopMarketDataPolling,
  stopPolling,
} from "./scheduler";
import { notify } from "./notifications";
import { releaseSystemKeepAwake, requestSystemKeepAwake } from "./power";
import { checkStall } from "./watchdog";
import { sendBuySignalWebhook, sendExecutionWebhook, sendSignalTierWebhook } from "./execution-notify";
import { evaluateWatchlistBuySignals } from "./watchlist-buy-signals";

let pendingManualPositionRefresh = false;
let autoCloseInFlight = false;
let autoBuyInFlight = false;

function makeAuditEntry(
  state: RuntimeState,
  eventType: AuditEventType,
  reason: string,
  partial: Partial<AuditLogEntry> = {}
): AuditLogEntry {
  return {
    timestamp: Date.now(),
    eventType,
    symbol: null,
    fingerprint: null,
    mode: state.monitoringStatus === "RUNNING" ? state.executionMode : "STOPPED",
    entryPrice: null,
    currentPrice: null,
    currentReturnPct: null,
    peakReturnPct: null,
    profitFloorPct: null,
    smaFast: null,
    smaSlow: null,
    closeCounter: null,
    decision: null,
    reason,
    executionResult: null,
    errorDetails: null,
    realizedPnlUsd: null,
    ...partial,
  };
}

async function broadcastState(state: RuntimeState): Promise<void> {
  const message: StateSnapshotMessage = { type: "STATE_SNAPSHOT", state };
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // No side panel listening right now; that's fine, it will pull GET_STATE on open.
  }
}

async function findKrakenTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ url: KRAKEN_PROP_URL_PATTERN });
  return tabs[0] ?? null;
}

function isMissingContentScriptError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /receiving end does not exist|could not establish connection/i.test(message);
}

async function sendMessageToKrakenTab(tabId: number, message: ExtensionMessage): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    if (!isMissingContentScriptError(err)) throw err;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-script.js"],
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

/** Runs on chrome.runtime.onInstalled / onStartup — i.e. a real browser
 * restart or an extension reload/update, NOT routine service-worker
 * suspend/wake (which doesn't fire either event and is handled fine by
 * alarms + persisted state alone). Per the product requirement that LIVE
 * Auto-Close must always come back disarmed after a restart, while
 * monitoring itself should resume if it was running:
 *   1. Detect an execution that was interrupted mid-flight (state was not
 *      terminal) and mark it UNCERTAIN with an urgent notification — never
 *      silently discard it, since its real outcome on Kraken is unknown.
 *   2. Unconditionally disarm LIVE Auto-Close.
 *   3. If monitoring was RUNNING before the restart and the Kraken tab is
 *      still open, resume monitor-only monitoring: recreate both alarms,
 *      reassert keep-awake, and kick off an immediate scan. If the tab is
 *      gone, monitoring stops (there's nothing to resume) and says so.
 *   4. Notify separately if LIVE was armed before, since it now requires a
 *      fresh manual re-arm. */
async function resetToSafeDefaultsOnRestart(): Promise<void> {
  await stopPolling();
  await stopMarketDataPolling();
  releaseSystemKeepAwake();

  const before = await getState();
  const hadInterruptedExecution =
    before.closeExecution !== null && !isExecutionTerminal(before.closeExecution.state);
  const wasArmed = before.executionMode === "ARMED_AUTO_CLOSE";
  const wasLiveArmed = wasArmed && before.autoCloseLive;
  const wasMonitoring = before.monitoringStatus === "RUNNING";

  if (hadInterruptedExecution && before.closeExecution) {
    const interrupted = before.closeExecution;
    await appendAuditEntry(
      makeAuditEntry(
        before,
        "EXECUTION_INTERRUPTED_BY_RESTART",
        `Execution for ${interrupted.symbol} was interrupted mid-flight (state was ${interrupted.state}) by a restart. Its outcome on Kraken is UNKNOWN — verify manually.`,
        {
          symbol: interrupted.symbol,
          fingerprint: interrupted.fingerprint,
          executionResult: "FAILURE",
          errorDetails: `Interrupted while ${interrupted.state}.`,
        }
      )
    );
    await notify(
      "Execution interrupted by restart",
      `An automatic close for ${interrupted.symbol} was interrupted while ${interrupted.state}. Its outcome on Kraken is UNKNOWN — check your Kraken Prop account manually before re-arming.`,
      { urgent: true }
    );
  }

  const tab = wasMonitoring ? await findKrakenTab() : null;
  const resumeTabId = tab?.id ?? null;
  const canResume = wasMonitoring && resumeTabId !== null;

  const reset = await updateState((s) => ({
    ...s,
    monitoringStatus: canResume ? "RUNNING" : "STOPPED",
    executionMode: "MONITOR_ONLY",
    armedUntil: null,
    autoCloseLive: false,
    krakenTabId: canResume ? resumeTabId : null,
    nextMarketRefreshAt: null,
    keepAwakeStatus: "INACTIVE",
    keepAwakeError: null,
    autoCloseDryRunIntents: {},
    livePreflight: null,
    closeExecution: null,
    consecutiveScanFailures: 0,
    monitorStalledSince: null,
    liveAutoCloseStats: {
      armedSessionStartedAt: null,
      closesThisSession: 0,
      closeTimestamps: [],
      unresolvedSleepGap: false,
      previousExecutionUncertain:
        hadInterruptedExecution || before.liveAutoCloseStats.previousExecutionUncertain,
    },
  }));

  if (canResume) {
    const keepAwake = requestSystemKeepAwake();
    const withKeepAwake = await updateState((s) => ({
      ...s,
      keepAwakeStatus: keepAwake.ok ? "ACTIVE" : "ERROR",
      keepAwakeError: keepAwake.ok ? null : keepAwake.error,
    }));
    await startPolling(withKeepAwake.settings.pollMinutes);
    await startMarketDataPolling(withKeepAwake.settings.marketRefreshMinutes);
    await appendAuditEntry(
      makeAuditEntry(
        withKeepAwake,
        "MONITORING_STARTED",
        "Monitoring resumed after restart (Monitor Only)."
      )
    );
    await notify(
      "Monitoring resumed",
      wasLiveArmed
        ? "Monitoring resumed in Monitor Only mode after a restart. LIVE Auto-Close was disarmed and requires a manual re-arm."
        : "Monitoring resumed in Monitor Only mode after a restart."
    );
    await broadcastState(withKeepAwake);
    await runScanCycle({ autopilotResetStats: true });
  } else if (wasMonitoring) {
    await appendAuditEntry(
      makeAuditEntry(
        reset,
        "MONITORING_STOPPED",
        "Monitoring could not resume after restart: Kraken tab not found."
      )
    );
    await notify(
      "Monitoring stopped",
      "Monitoring was running before this restart but the Kraken tab is no longer open. Reopen it and press Start Monitoring.",
      { urgent: true }
    );
    await broadcastState(reset);
  } else if (wasLiveArmed) {
    await notify(
      "LIVE Auto-Close disarmed",
      "LIVE Auto-Close was armed before this restart and now requires a manual re-arm.",
      { urgent: true }
    );
  }
}

async function disarmAutoClose(
  reason: string,
  eventType: "AUTO_CLOSE_DISARMED" | "AUTO_CLOSE_EXPIRED" = "AUTO_CLOSE_DISARMED"
): Promise<void> {
  const next = await updateState((s) => ({
    ...s,
    executionMode: "MONITOR_ONLY",
    armedUntil: null,
    autoCloseLive: false,
    autoCloseDryRunIntents: {},
  }));
  await appendAuditEntry(makeAuditEntry(next, eventType, reason));
  await notify(
    eventType === "AUTO_CLOSE_EXPIRED" ? "Auto-Close expired" : "Auto-Close disarmed",
    reason
  );
  await broadcastState(next);
}

async function disarmLiveAutoClose(
  reason: string,
  options: { uncertain?: boolean; failed?: boolean } = {}
): Promise<void> {
  const next = await updateState((s) => ({
    ...s,
    executionMode: "MONITOR_ONLY",
    armedUntil: null,
    autoCloseLive: false,
    autoCloseDryRunIntents: {},
    liveAutoCloseStats: {
      ...s.liveAutoCloseStats,
      previousExecutionUncertain:
        s.liveAutoCloseStats.previousExecutionUncertain || options.uncertain === true,
    },
  }));
  await appendAuditEntry(
    makeAuditEntry(
      next,
      options.uncertain ? "AUTO_CLOSE_UNCERTAIN" : "AUTO_CLOSE_DISARMED",
      reason,
      {
        executionResult: options.uncertain ? "FAILURE" : options.failed ? "FAILURE" : "BLOCKED",
        errorDetails: reason,
      }
    )
  );
  // In AUTOPILOT, this disarm is expected to be transient — runScanCycle's
  // tryAutopilotArm re-attempts every cycle and has its own one-shot "still
  // waiting to arm" notification (autopilotReArmFailedSince) so a blip
  // doesn't produce two urgent pushes. Outside AUTOPILOT (e.g. the old
  // direct ARM_AUTO_CLOSE flow), this is still the only disarm notice.
  if (next.operatingMode !== "AUTOPILOT") {
    await notify("LIVE Auto-Close disarmed", reason, { urgent: true });
  }
  await broadcastState(next);
}

function isExecutionTerminal(state: CloseExecutionState | null | undefined): boolean {
  return (
    state === "SUCCEEDED" || state === "FAILED" || state === "BLOCKED" || state === "UNCERTAIN"
  );
}

async function updateCloseExecution(
  partial: Partial<CloseExecutionRecord>
): Promise<CloseExecutionRecord | null> {
  const now = Date.now();
  const next = await updateState((s) => {
    if (!s.closeExecution) return s;
    return {
      ...s,
      closeExecution: {
        ...s.closeExecution,
        ...partial,
        details: partial.details ?? s.closeExecution.details,
        updatedAt: now,
      },
    };
  });
  await broadcastState(next);
  return next.closeExecution;
}

function freshEnough(ts: number | null, maxAgeMs: number, now: number): boolean {
  return ts !== null && now - ts <= maxAgeMs;
}

/** Watchdog: called after every scan attempt (success or failure) while
 * monitoring is RUNNING. `lastHeartbeatAt` alone cannot detect "the alarm
 * keeps firing but scans keep failing" because it is bumped every cycle
 * regardless of outcome — this tracks the last *successful* scan
 * (`lastPositionScanAt`, only ever set by processScanResult) against the
 * required threshold instead, and flips a one-shot STALLED flag so the
 * disarm/notification/audit fire exactly once per stall onset, not every
 * cycle while still stalled. */
async function recordScanOutcome(success: boolean): Promise<void> {
  const state = await getState();
  if (state.monitoringStatus !== "RUNNING") return;
  const now = Date.now();

  if (success) {
    const wasStalled = state.monitorStalledSince !== null;
    const next = await updateState((s) => ({
      ...s,
      consecutiveScanFailures: 0,
      monitorStalledSince: null,
    }));
    if (wasStalled) {
      await appendAuditEntry(
        makeAuditEntry(
          next,
          "MONITOR_RECOVERED",
          "A scan cycle completed successfully after a stall."
        )
      );
      await notify("Monitoring recovered", "A scan cycle completed successfully after a stall.");
      await broadcastState(next);
    }
    return;
  }

  const failures = state.consecutiveScanFailures + 1;
  if (state.monitorStalledSince !== null) {
    // Already flagged; just keep the failure count current, don't re-notify.
    await updateState((s) => ({ ...s, consecutiveScanFailures: failures }));
    return;
  }

  const { stalled, stalledForMs } = checkStall({
    lastSuccessfulScanAt: state.lastPositionScanAt,
    fallbackReferenceAt: state.monitoringStartedAt,
    pollMinutes: state.settings.pollMinutes,
    now,
  });

  if (!stalled) {
    await updateState((s) => ({ ...s, consecutiveScanFailures: failures }));
    return;
  }

  const stalledMinutes = (stalledForMs / 60_000).toFixed(0);
  const wasLive = state.executionMode === "ARMED_AUTO_CLOSE" && state.autoCloseLive;
  const next = await updateState((s) => ({
    ...s,
    consecutiveScanFailures: failures,
    monitorStalledSince: now,
  }));
  if (wasLive) {
    await disarmLiveAutoClose(
      `Monitoring stalled: no successful scan for ${stalledMinutes} minutes.`
    );
  }
  await appendAuditEntry(
    makeAuditEntry(
      next,
      "MONITOR_STALLED",
      `No successful scan cycle for ${stalledMinutes} minutes.`
    )
  );
  await notify(
    "Monitoring STALLED",
    `No successful scan cycle for ${stalledMinutes} minutes.${wasLive ? " LIVE Auto-Close has been disarmed." : ""} Check the Kraken tab and that you're still logged in.`,
    { urgent: true }
  );
  await broadcastState(next);
}

function activeAutoClosePositions(state: RuntimeState): TrackedPosition[] {
  return Object.values(state.positions).filter(
    (pos) => pos.status === "ACTIVE" && pos.side === "LONG" && !pos.autoCloseDisabledReason
  );
}

function marketRowHealthyForPosition(
  state: RuntimeState,
  pos: TrackedPosition,
  now: number,
  maxAgeMs: number
): string | null {
  const row = state.marketData[pos.symbol];
  if (!row) return `${pos.symbol}: no public market row`;
  if (row.apiStatus !== "OK") return `${pos.symbol}: public API status ${row.apiStatus}`;
  if (!freshEnough(row.lastUpdatedAt, maxAgeMs, now))
    return `${pos.symbol}: public API data is stale`;
  if (row.currentApiPrice === null) return `${pos.symbol}: missing public API price`;
  const uiPrice = pos.latest?.currentPriceUi ?? null;
  if (uiPrice === null) return `${pos.symbol}: missing visible Kraken price`;
  const tolerance = checkPriceTolerance(
    uiPrice,
    row.currentApiPrice,
    state.settings.apiUiPriceTolerancePercent
  );
  if (!tolerance.withinTolerance) {
    return `${pos.symbol}: API/UI price differ by ${tolerance.diffPercent.toFixed(2)}%`;
  }
  return null;
}

function triggerFamily(reason: string): "HARD_LOSS" | "PROFIT_LOCK" | "SMA" | "UNKNOWN" {
  if (/hard-loss/i.test(reason)) return "HARD_LOSS";
  if (/profit floor/i.test(reason)) return "PROFIT_LOCK";
  if (/SMA7|SMA30|trend/i.test(reason)) return "SMA";
  return "UNKNOWN";
}

function valueWithinTolerance(
  before: number | null | undefined,
  after: number | null | undefined
): boolean {
  if (before === null || before === undefined || after === null || after === undefined)
    return false;
  const diff = Math.abs(before - after);
  return diff <= Math.max(5, Math.abs(before) * 0.1);
}

async function revalidateCloseCandidateBeforeSubmit(
  intent: CloseExecutionRecord,
  tabId: number
): Promise<{ ok: boolean; reason: string; position: TrackedPosition | null }> {
  const state = await getState();
  const now = Date.now();
  if (now - intent.startedAt > state.settings.autoCloseSignalExpiryMinutes * 60_000) {
    return { ok: false, reason: "Execution intent expired before final submit.", position: null };
  }
  if (state.krakenTabId !== tabId)
    return { ok: false, reason: "Kraken tab changed before final submit.", position: null };

  const scan = await requestScanFromTab(tabId);
  if (!scan)
    return {
      ok: false,
      reason: "Could not freshly rescan Kraken DOM before final submit.",
      position: null,
    };
  if (!scan.pageHealth.propPageDetected || scan.pageHealth.sessionState !== "LOGGED_IN") {
    return {
      ok: false,
      reason: "Kraken page/session is not authenticated before final submit.",
      position: null,
    };
  }
  await processScanResult(scan, tabId, { skipLiveAutoClose: true, skipMarketRefresh: true });
  const fresh = await getState();
  const pos = fresh.positions[intent.fingerprint] ?? null;
  if (!pos || pos.status !== "ACTIVE")
    return { ok: false, reason: "Exact lot is no longer active.", position: null };
  if (pos.symbol !== intent.symbol || pos.side !== "LONG")
    return { ok: false, reason: "Exact lot symbol/side changed.", position: pos };
  if (
    !valueWithinTolerance(
      state.positions[intent.fingerprint]?.latest?.valueUsd,
      pos.latest?.valueUsd
    )
  ) {
    return { ok: false, reason: "Exact lot value changed beyond tolerance.", position: pos };
  }
  if (pos.autoCloseDisabledReason)
    return { ok: false, reason: pos.autoCloseDisabledReason, position: pos };

  const resolution = await resolvePublicMarket(pos.symbol);
  if (resolution.status !== "SUPPORTED")
    return { ok: false, reason: `${pos.symbol} market mapping unresolved.`, position: pos };

  let apiPrice: number;
  let candles;
  try {
    apiPrice = await fetchCurrentPrice(resolution.pairParam);
    candles = await fetchCompletedHourlyCandles(resolution.pairParam, 120);
  } catch (err) {
    return { ok: false, reason: `Fresh public market fetch failed: ${String(err)}`, position: pos };
  }
  const uiPrice = pos.latest?.currentPriceUi ?? null;
  if (uiPrice === null) return { ok: false, reason: "Fresh UI price is missing.", position: pos };
  const tolerance = checkPriceTolerance(
    uiPrice,
    apiPrice,
    fresh.settings.apiUiPriceTolerancePercent
  );
  if (!tolerance.withinTolerance) {
    return {
      ok: false,
      reason: `Fresh API/UI price mismatch ${tolerance.diffPercent.toFixed(2)}%.`,
      position: pos,
    };
  }
  const validation = validateCandles(candles, {
    minRequired: Math.max(
      fresh.settings.longSma + fresh.settings.slope90LookbackHours,
      fresh.settings.slowSma + fresh.settings.slope30LookbackHours,
      fresh.settings.fastSma + fresh.settings.slope7LookbackHours,
      fresh.settings.atrPeriod + 1
    ),
    intervalMinutes: fresh.settings.candleIntervalMinutes,
    maxDataAgeMinutes: fresh.settings.candleIntervalMinutes + 30,
    now,
  });
  if (!validation.ok)
    return {
      ok: false,
      reason: `Fresh candles invalid: ${validation.errors.join("; ")}`,
      position: pos,
    };

  const decision = evaluateVolatilityAdjustedStrategy({
    position: pos,
    candles,
    apiPrice,
    settings: fresh.settings,
    now,
    blockingReasons: [],
  });
  if (decision.decision !== "CLOSE")
    return {
      ok: false,
      reason: `Fresh strategy is ${decision.decision}: ${decision.reason}`,
      position: pos,
    };
  if (triggerFamily(decision.reason) !== triggerFamily(intent.trigger)) {
    return {
      ok: false,
      reason: "Fresh CLOSE trigger no longer matches the original execution intent.",
      position: pos,
    };
  }

  const modalRaw = await sendMessageToKrakenTab(tabId, {
    type: "CONFIRM_CLOSE_DIALOG",
    fingerprint: intent.fingerprint,
    symbol: intent.symbol,
  });
  if (!isExtensionMessage(modalRaw) || modalRaw.type !== "CONFIRM_CLOSE_DIALOG_RESULT") {
    return { ok: false, reason: "Could not revalidate modal before final submit.", position: pos };
  }
  if (!modalRaw.modalValidation?.ready || !modalRaw.clicked) {
    return {
      ok: false,
      reason:
        modalRaw.modalValidation?.blockedReason ??
        modalRaw.error ??
        "Final modal validation failed.",
      position: pos,
    };
  }
  return {
    ok: true,
    reason: "Fresh revalidation passed and final close button clicked.",
    position: pos,
  };
}

async function verifyCloseSubmitted(
  tabId: number,
  candidate: TrackedPosition,
  beforeFingerprints: string[]
): Promise<{ ok: boolean; uncertain: boolean; details: string[] }> {
  const state = await getState();
  const timeoutMs = state.settings.closeVerificationTimeoutSeconds * 1000;
  const deadline = Date.now() + timeoutMs;
  const unrelated = beforeFingerprints.filter((fp) => fp !== candidate.fingerprint);
  let latestDetails: string[] = [];

  while (Date.now() <= deadline) {
    const scan = await requestScanFromTab(tabId);
    if (!scan) {
      latestDetails = ["Could not rescan Kraken DOM during verification."];
    } else {
      await processScanResult(scan, tabId, { skipLiveAutoClose: true, skipMarketRefresh: true });
      const current = await getState();
      const active = Object.values(current.positions).filter((pos) => pos.status === "ACTIVE");
      const activeSet = new Set(active.map((pos) => pos.fingerprint));
      const exactRemoved = !activeSet.has(candidate.fingerprint);
      const activeCountDecreased = active.length === Math.max(0, beforeFingerprints.length - 1);
      const unrelatedStillPresent = unrelated.every((fp) => activeSet.has(fp));
      const wrongLotRemoved = unrelated.some((fp) => !activeSet.has(fp));
      const oppositeShort = scan.positions.some(
        (pos) => pos.symbol === candidate.symbol && pos.side === "SHORT"
      );
      const statusRaw = await sendMessageToKrakenTab(tabId, {
        type: "CLOSE_MODAL_STATUS",
        symbol: candidate.symbol,
      });
      const status =
        isExtensionMessage(statusRaw) && statusRaw.type === "CLOSE_MODAL_STATUS_RESULT"
          ? statusRaw
          : null;
      const modalResolved = status ? !status.modalOpen || status.successFeedback : false;

      latestDetails = [
        exactRemoved ? "Exact lot removed" : "Exact lot still active",
        activeCountDecreased ? "Lot count decreased by one" : "Lot count did not decrease by one",
        unrelatedStillPresent ? "Unrelated lots unchanged" : "Unrelated lot changed",
        modalResolved ? "Close modal resolved" : "Close modal still present or unknown",
      ];
      if (oppositeShort) latestDetails.push("Opposite SHORT appeared");
      if (wrongLotRemoved || oppositeShort)
        return { ok: false, uncertain: true, details: latestDetails };
      if (exactRemoved && activeCountDecreased && unrelatedStillPresent && modalResolved) {
        return { ok: true, uncertain: false, details: latestDetails };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return {
    ok: false,
    uncertain: true,
    details: latestDetails.length ? latestDetails : ["Verification timed out."],
  };
}

async function canArmLiveAutoClose(): Promise<LiveAutoClosePreflightResult> {
  const checkedAt = Date.now();
  const blockers: string[] = [];
  let state = await getState();
  const maxAgeMs = state.settings.pollMinutes * 2 * 60_000;

  if (state.monitoringStatus !== "RUNNING") blockers.push("Monitoring is not running.");
  if (
    autoCloseInFlight ||
    (state.closeExecution && !isExecutionTerminal(state.closeExecution.state))
  ) {
    blockers.push("A close execution is already in flight.");
  }
  if (
    state.closeExecution?.state === "UNCERTAIN" ||
    state.liveAutoCloseStats.previousExecutionUncertain
  ) {
    blockers.push("A previous close execution is uncertain.");
  }
  if (state.liveAutoCloseStats.unresolvedSleepGap)
    blockers.push("A sleep/interruption gap is unresolved.");
  if (state.keepAwakeStatus !== "ACTIVE") blockers.push("Keep-awake is not active.");

  const tab = await findKrakenTab();
  if (!tab || tab.id === undefined) {
    blockers.push("Kraken Prop tab is not present.");
  } else {
    const scan = await requestScanFromTab(tab.id);
    if (!scan) {
      blockers.push("Content script did not respond from the Kraken tab.");
    } else {
      await processScanResult(scan, tab.id, { skipLiveAutoClose: true, skipMarketRefresh: true });
      state = await getState();
    }
  }

  const page = state.pageHealth;
  if (!page?.propPageDetected) blockers.push("Kraken Prop portfolio page is not detected.");
  if (page?.sessionState !== "LOGGED_IN")
    blockers.push(`Kraken session is ${page?.sessionState ?? "UNKNOWN"}.`);
  if (!page?.positionsTableReadable) blockers.push("Positions table is not readable.");
  if ((state.lastCandidateRowCount ?? 0) <= 0)
    blockers.push("No actionable LONG position rows were found.");
  if (!freshEnough(state.lastPositionScanAt, maxAgeMs, checkedAt)) {
    blockers.push("Latest position scan is stale.");
  }
  if (!freshEnough(state.lastPriceUpdateAt, maxAgeMs, checkedAt)) {
    blockers.push("Latest public market-data refresh is stale.");
  }

  // A symbol can be tracked as an active position before the next scheduled
  // market-data-refresh timer catches up to include it (that timer runs
  // independently of position scans), which would otherwise wrongly block
  // arming with "no public market row" for a perfectly fine, just-newly-
  // detected symbol. Force one refresh here, scoped to whatever symbols are
  // active right now, so the check below sees current data.
  await refreshMarketData({ automatic: false });
  state = await getState();

  const active = activeAutoClosePositions(state);
  if (active.length === 0) blockers.push("No auto-close-eligible active LONG positions exist.");
  for (const pos of active) {
    const marketProblem = marketRowHealthyForPosition(state, pos, checkedAt, maxAgeMs);
    if (marketProblem) blockers.push(marketProblem);
    const resolution = await resolvePublicMarket(pos.symbol);
    if (resolution.status !== "SUPPORTED")
      blockers.push(`${pos.symbol}: market mapping unresolved.`);
  }

  const closeCandidates = active.filter((pos) => pos.decision === "CLOSE");
  if (tab?.id !== undefined) {
    for (const pos of closeCandidates) {
      const raw = await sendMessageToKrakenTab(tab.id, {
        type: "PREVIEW_CLOSE",
        fingerprint: pos.fingerprint,
        symbol: pos.symbol,
        lotLabel: null,
      });
      if (!isExtensionMessage(raw) || raw.type !== "PREVIEW_CLOSE_RESULT" || !raw.report?.ready) {
        blockers.push(`${pos.symbol}: close-control ownership could not be validated.`);
      }
    }
  }

  const result: LiveAutoClosePreflightResult = {
    allowed: blockers.length === 0,
    blockers,
    checkedAt,
  };
  const next = await updateState((s) => ({ ...s, livePreflight: result }));
  await broadcastState(next);
  return result;
}

async function handleArmAutoClose(
  durationHours: number,
  live: boolean,
  resetStats = true
): Promise<void> {
  const now = Date.now();
  const state = await getState();
  if (state.monitoringStatus !== "RUNNING") {
    await appendAuditEntry(
      makeAuditEntry(
        state,
        "AUTO_CLOSE_DISARMED",
        "Auto-Close arm blocked: monitoring is not running.",
        {
          executionResult: "BLOCKED",
        }
      )
    );
    return;
  }
  if (live) {
    const preflight = await canArmLiveAutoClose();
    if (!preflight.allowed) {
      const blocked = await getState();
      await appendAuditEntry(
        makeAuditEntry(
          blocked,
          "AUTO_CLOSE_BLOCKED",
          `LIVE Auto-Close arm blocked: ${preflight.blockers.join(" ")}`,
          {
            executionResult: "BLOCKED",
            errorDetails: preflight.blockers.join("; "),
          }
        )
      );
      if (blocked.operatingMode !== "AUTOPILOT") {
        await notify("LIVE Auto-Close blocked", preflight.blockers.join(" "), { urgent: true });
      }
      return;
    }
  }
  const hours =
    Number.isFinite(durationHours) && durationHours > 0
      ? Math.min(durationHours, 24)
      : state.settings.autoCloseDurationHours;
  const armedUntil = now + hours * 60 * 60_000;
  const next = await updateState((s) => ({
    ...s,
    executionMode: "ARMED_AUTO_CLOSE",
    armedUntil,
    autoCloseLive: live,
    autoCloseDryRunIntents: {},
    // Correctness-critical: resetStats is only true for a fresh, explicit
    // arm (user turning Autopilot on, or the old direct ARM_AUTO_CLOSE
    // flow). Autopilot's own self-healing re-arm (tryAutopilotArm, after a
    // transient disarm) passes false so a brief blip can't silently wipe
    // the hourly/session rate-limit counters and defeat
    // maxLiveClosesPerHour/maxLiveClosesPerArmedSession.
    liveAutoCloseStats: resetStats
      ? {
          armedSessionStartedAt: now,
          closesThisSession: 0,
          closeTimestamps: [],
          unresolvedSleepGap: false,
          previousExecutionUncertain: false,
        }
      : s.liveAutoCloseStats,
  }));
  await appendAuditEntry(
    makeAuditEntry(
      next,
      "AUTO_CLOSE_ARMED",
      `Auto-Close ${live ? "LIVE" : "dry-run"} armed for ${hours} hour(s).`
    )
  );
  if (resetStats) {
    await notify(
      live ? "LIVE Auto-Close armed" : "Auto-Close armed",
      live
        ? "Live mode is armed. Current validated CLOSE signals may close Kraken positions automatically."
        : "Dry-run mode is armed. It will log validated close intents but will not click final Kraken confirmation.",
      { urgent: live }
    );
  }
  await broadcastState(next);
}

async function handleStartMonitoring(): Promise<void> {
  const tab = await findKrakenTab();
  if (!tab || tab.id === undefined) {
    await notify(
      "Kraken tab missing",
      "Open the Kraken Prop Portfolio page and log in before starting monitoring.",
      { urgent: true }
    );
    return;
  }

  const now = Date.now();
  const keepAwake = requestSystemKeepAwake();
  const next = await updateState((s) => ({
    ...s,
    monitoringStatus: "RUNNING",
    executionMode: "MONITOR_ONLY",
    armedUntil: null,
    autoCloseLive: false,
    monitoringStartedAt: now,
    lastHeartbeatAt: now,
    krakenTabId: tab.id ?? null,
    keepAwakeStatus: keepAwake.ok ? "ACTIVE" : "ERROR",
    keepAwakeError: keepAwake.ok ? null : keepAwake.error,
    autoCloseDryRunIntents: {},
    livePreflight: null,
    liveAutoCloseStats: {
      ...s.liveAutoCloseStats,
      unresolvedSleepGap: false,
    },
  }));
  await startPolling(next.settings.pollMinutes);
  await startMarketDataPolling(next.settings.marketRefreshMinutes);
  await appendAuditEntry(makeAuditEntry(next, "MONITORING_STARTED", "Monitoring started."));
  if (!keepAwake.ok) {
    await notify("Keep-awake failed", keepAwake.error, { urgent: true });
  }
  await notify("Monitoring started", `kraken-guard is monitoring in ${next.executionMode} mode.`);
  const scheduled = await updateState((s) => ({
    ...s,
    nextMarketRefreshAt: now + s.settings.marketRefreshMinutes * 60_000,
  }));
  await broadcastState(scheduled);
  await runScanCycle();
  await refreshMarketData({ automatic: false });
}

/** One-click combined flow (Settings.startMonitoringWithLiveAutoClose).
 * Starts monitoring first — LIVE preflight requires a fresh scan/tab, which
 * doesn't exist until monitoring has actually run once — then, only if
 * that succeeded, runs the same preflight+arm ARM_AUTO_CLOSE uses. If
 * preflight fails, monitoring is left running in Monitor Only; nothing
 * about this path skips or weakens the preflight LIVE arming always
 * requires. */
async function handleStartMonitoringWithLiveAutoClose(
  durationHours: number
): Promise<{ monitoringStarted: boolean; liveArmed: boolean; preflightBlockers: string[] }> {
  await handleStartMonitoring();
  const afterStart = await getState();
  if (afterStart.monitoringStatus !== "RUNNING") {
    return { monitoringStarted: false, liveArmed: false, preflightBlockers: [] };
  }

  const preflight = await canArmLiveAutoClose();
  if (!preflight.allowed) {
    await updateState((s) => ({ ...s, livePreflight: preflight }));
    await broadcastState(await getState());
    return { monitoringStarted: true, liveArmed: false, preflightBlockers: preflight.blockers };
  }

  await handleArmAutoClose(durationHours, true);
  const afterArm = await getState();
  const liveArmed = afterArm.executionMode === "ARMED_AUTO_CLOSE" && afterArm.autoCloseLive;
  return {
    monitoringStarted: true,
    liveArmed,
    preflightBlockers: liveArmed ? [] : preflight.blockers,
  };
}

async function handleStopMonitoring(): Promise<void> {
  await stopPolling();
  await stopMarketDataPolling();
  releaseSystemKeepAwake();
  const next = await updateState((s) => ({
    ...s,
    monitoringStatus: "STOPPED",
    executionMode: "MONITOR_ONLY",
    armedUntil: null,
    autoCloseLive: false,
    nextMarketRefreshAt: null,
    keepAwakeStatus: "INACTIVE",
    keepAwakeError: null,
    autoCloseDryRunIntents: {},
    livePreflight: null,
  }));
  await appendAuditEntry(makeAuditEntry(next, "MONITORING_STOPPED", "Monitoring stopped."));
  await notify("Monitoring stopped", "kraken-guard has stopped monitoring.");
  await broadcastState(next);
}

/** Autopilot's self-healing (re-)arm: called once when the user turns
 * Autopilot on (resetStats: true) and again at the end of every scan cycle
 * (resetStats: false) so a transient disarm (stale data, sleep gap, tab
 * hiccup, etc.) recovers on its own next cycle instead of requiring a
 * manual re-arm click. Only ever a no-op or a real preflight-gated arm —
 * never skips or weakens canArmLiveAutoClose. */
async function tryAutopilotArm(options: { resetStats: boolean }): Promise<void> {
  const state = await getState();
  if (state.operatingMode !== "AUTOPILOT") return;
  if (state.executionMode === "ARMED_AUTO_CLOSE" && state.autoCloseLive) return;

  const preflight = await canArmLiveAutoClose();
  if (!preflight.allowed) {
    if (state.autopilotReArmFailedSince === null) {
      await notify("Autopilot paused", `Waiting to (re-)arm: ${preflight.blockers.join(" ")}`, {
        urgent: true,
      });
      const marked = await updateState((s) => ({ ...s, autopilotReArmFailedSince: Date.now() }));
      await broadcastState(marked);
    }
    return;
  }

  await handleArmAutoClose(state.settings.autoCloseDurationHours, true, options.resetStats);
  const cleared = await updateState((s) => ({ ...s, autopilotReArmFailedSince: null }));
  await broadcastState(cleared);
}

/** The simplified Off/Cruise/Autopilot control. A thin layer on top of the
 * existing monitoringStatus/executionMode/autoCloseLive/armedUntil
 * machinery — none of that internal shape changes. */
async function setOperatingMode(mode: OperatingMode): Promise<void> {
  const before = await getState();

  if (mode === "OFF") {
    if (before.monitoringStatus === "RUNNING") await handleStopMonitoring();
    const next = await updateState((s) => ({
      ...s,
      operatingMode: "OFF",
      autopilotReArmFailedSince: null,
    }));
    await broadcastState(next);
    return;
  }

  if (before.monitoringStatus !== "RUNNING") await handleStartMonitoring();

  if (mode === "CRUISE") {
    const running = await getState();
    if (running.executionMode === "ARMED_AUTO_CLOSE") {
      await disarmAutoClose("Switched to Cruise mode.");
    }
    const next = await updateState((s) => ({
      ...s,
      operatingMode: "CRUISE",
      autopilotReArmFailedSince: null,
    }));
    await broadcastState(next);
    return;
  }

  // AUTOPILOT
  await updateState((s) => ({ ...s, operatingMode: "AUTOPILOT" }));
  await tryAutopilotArm({ resetStats: true });
  await broadcastState(await getState());
}

async function requestScanFromTab(tabId: number): Promise<ScanResultMessage | null> {
  try {
    const raw: unknown = await sendMessageToKrakenTab(tabId, { type: "REQUEST_SCAN" });
    return isExtensionMessage(raw) && raw.type === "POSITIONS_SCAN_RESULT" ? raw : null;
  } catch (err) {
    console.warn("[kraken-guard] failed to request scan from tab", err);
    return null;
  }
}

async function runScanCycle(options: { autopilotResetStats?: boolean } = {}): Promise<void> {
  await runScanCycleInner();
  // Always give Autopilot a chance to (re-)arm at the end of the cycle,
  // regardless of which path above returned — this is what turns every
  // disarm condition into auto-pause/auto-resume instead of a hard stop
  // requiring a manual click. resetStats is only true right after a real
  // restart resumes Autopilot (see resetToSafeDefaultsOnRestart) — every
  // routine cycle here is a self-heal, not a fresh arm.
  await tryAutopilotArm({ resetStats: options.autopilotResetStats ?? false });
}

async function runScanCycleInner(): Promise<void> {
  const now = Date.now();
  const state = await getState();
  if (state.monitoringStatus !== "RUNNING") return;
  if (
    state.executionMode === "ARMED_AUTO_CLOSE" &&
    state.armedUntil !== null &&
    state.armedUntil <= now
  ) {
    if (state.operatingMode === "AUTOPILOT") {
      // Self-renewing: Autopilot has no fixed-duration arming ceremony —
      // roll the window forward instead of expiring. Every other disarm
      // condition below is completely unaffected by this.
      const hours =
        Number.isFinite(state.settings.autoCloseDurationHours) &&
        state.settings.autoCloseDurationHours > 0
          ? Math.min(state.settings.autoCloseDurationHours, 24)
          : 8;
      const renewed = await updateState((s) => ({
        ...s,
        armedUntil: now + hours * 3600_000,
      }));
      await broadcastState(renewed);
    } else if (state.autoCloseLive) {
      await disarmLiveAutoClose("LIVE Auto-Close arming duration expired.");
      return;
    } else {
      await disarmAutoClose("Auto-Close arming duration expired.", "AUTO_CLOSE_EXPIRED");
      return;
    }
  }
  if (
    state.executionMode === "ARMED_AUTO_CLOSE" &&
    state.autoCloseLive &&
    state.keepAwakeStatus !== "ACTIVE"
  ) {
    await disarmLiveAutoClose(
      "Keep-awake became inactive or errored while LIVE Auto-Close was armed."
    );
    return;
  }

  const { gapDetected, gapMinutes } = detectSleepGap(
    state.lastHeartbeatAt,
    Math.max(state.settings.pollMinutes * 2, state.settings.sleepGapWarningMinutes),
    now
  );

  let missed = state.missedScheduledChecks;
  if (gapDetected) {
    missed += Math.max(1, Math.round(gapMinutes / state.settings.pollMinutes) - 1);
    await appendAuditEntry(
      makeAuditEntry(
        state,
        "SLEEP_INTERRUPTION_DETECTED",
        `Gap of ${gapMinutes.toFixed(1)} minutes since last check.`
      )
    );
    await notify(
      "Possible sleep interruption",
      `Detected a ${gapMinutes.toFixed(0)}-minute gap since the last check. Re-validating all data before acting on anything.`,
      { urgent: true }
    );
    const gapState = await updateState((s) => ({
      ...s,
      liveAutoCloseStats: { ...s.liveAutoCloseStats, unresolvedSleepGap: true },
    }));
    await broadcastState(gapState);
    if (state.executionMode === "ARMED_AUTO_CLOSE" && state.autoCloseLive) {
      await disarmLiveAutoClose(
        `Sleep/interruption gap of ${gapMinutes.toFixed(1)} minutes detected.`
      );
    }
  }

  const tab = await findKrakenTab();
  const next = await updateState((s) => ({
    ...s,
    lastHeartbeatAt: now,
    missedScheduledChecks: missed,
    krakenTabId: tab?.id ?? null,
  }));

  if (!tab || tab.id === undefined) {
    if (state.krakenTabId !== null) {
      await appendAuditEntry(
        makeAuditEntry(next, "KRAKEN_TAB_MISSING", "Kraken Prop tab not found.")
      );
      await notify(
        "Kraken tab missing",
        "The Kraken Prop tab was closed or navigated away. Reopen it to resume monitoring.",
        { urgent: true }
      );
    }
    if (next.executionMode === "ARMED_AUTO_CLOSE" && next.autoCloseLive) {
      await disarmLiveAutoClose("Kraken Prop tab disappeared.");
    }
    await broadcastState(next);
    await recordScanOutcome(false);
    return;
  }

  const scan = await requestScanFromTab(tab.id);
  if (scan) {
    await processScanResult(scan, tab.id);
    await recordScanOutcome(true);
  } else {
    if (next.executionMode === "ARMED_AUTO_CLOSE" && next.autoCloseLive) {
      await disarmLiveAutoClose("Content script became unavailable after reconnect attempt.");
    }
    await recordScanOutcome(false);
  }
}

async function runPositionRefreshCycle(): Promise<boolean> {
  const tab = await findKrakenTab();
  const next = await updateState((s) => ({
    ...s,
    krakenTabId: tab?.id ?? null,
  }));
  if (!tab || tab.id === undefined) {
    await broadcastState(next);
    return false;
  }
  const scan = await requestScanFromTab(tab.id);
  if (!scan) return false;
  await processScanResult(scan, tab.id);
  return true;
}

async function evaluatePositions(
  positions: Record<string, TrackedPosition>,
  state: RuntimeState,
  now: number
): Promise<Record<string, TrackedPosition>> {
  const settings = state.settings;
  const next = { ...positions };

  const activeBySymbol = new Map<string, TrackedPosition[]>();
  for (const pos of Object.values(next)) {
    if (pos.status !== "ACTIVE") continue;
    const list = activeBySymbol.get(pos.symbol) ?? [];
    list.push(pos);
    activeBySymbol.set(pos.symbol, list);
  }

  for (const [symbol, group] of activeBySymbol) {
    const resolution = await resolvePublicMarket(symbol);

    if (resolution.status === "UNSUPPORTED") {
      for (const pos of group) {
        const isNewly = !(pos.decision === "ERROR" && pos.reason.includes("Unsupported symbol"));
        next[pos.fingerprint] = {
          ...pos,
          decision: "ERROR",
          reason: `Unsupported symbol: ${resolution.reason}`,
        };
        if (isNewly) {
          await appendAuditEntry(
            makeAuditEntry(state, "UNSUPPORTED_SYMBOL", `${symbol}: ${resolution.reason}`, {
              symbol,
              fingerprint: pos.fingerprint,
            })
          );
        }
      }
      continue;
    }

    // A market can have more than one open lot (e.g. two XPL LONG rows with
    // different opening prices) — that is normal, not ambiguous. Each lot
    // in `group` is evaluated independently below, sharing only the
    // symbol's SMA/candle data. Genuinely indistinguishable rows are
    // caught earlier, in reconcilePositions (state-machine.ts), which
    // flags them BLOCKED via status "CHANGED"/ambiguity before they ever
    // reach this point with more than one truly-identical fingerprint.

    let candles;
    let apiPrice;
    try {
      candles = await fetchCompletedHourlyCandles(resolution.pairParam, 120);
      apiPrice = await fetchCurrentPrice(resolution.pairParam);
    } catch (err) {
      const message = err instanceof MarketDataError ? err.message : String(err);
      for (const pos of group) {
        next[pos.fingerprint] = {
          ...pos,
          decision: "ERROR",
          reason: `Market data error: ${message}`,
        };
      }
      await appendAuditEntry(makeAuditEntry(state, "STALE_MARKET_DATA", message, { symbol }));
      continue;
    }

    const validation = validateCandles(candles, {
      minRequired: Math.max(
        settings.longSma + settings.slope90LookbackHours,
        settings.slowSma + settings.slope30LookbackHours,
        settings.fastSma + settings.slope7LookbackHours,
        settings.atrPeriod + 1
      ),
      intervalMinutes: settings.candleIntervalMinutes,
      maxDataAgeMinutes: settings.candleIntervalMinutes + 30,
      now,
    });
    if (!validation.ok) {
      for (const pos of group) {
        next[pos.fingerprint] = {
          ...pos,
          decision: "ERROR",
          reason: `Market data invalid: ${validation.errors.join("; ")}`,
        };
      }
      await appendAuditEntry(
        makeAuditEntry(state, "STALE_MARKET_DATA", validation.errors.join("; "), { symbol })
      );
      continue;
    }

    for (const pos of group) {
      const uiPrice = pos.latest?.currentPriceUi ?? apiPrice;
      const tolerance = checkPriceTolerance(uiPrice, apiPrice, settings.apiUiPriceTolerancePercent);
      const blockingReasons: string[] = [];
      if (!tolerance.withinTolerance) {
        blockingReasons.push(
          `UI/API price differ by ${tolerance.diffPercent.toFixed(2)}% (tolerance ${settings.apiUiPriceTolerancePercent}%)`
        );
      }
      if (pos.status === "CHANGED") {
        blockingReasons.push("position changed manually; awaiting acknowledgment");
      }
      if (pos.autoCloseDisabledReason) {
        blockingReasons.push(pos.autoCloseDisabledReason);
      }

      const strategy = evaluateVolatilityAdjustedStrategy({
        position: pos,
        candles,
        apiPrice,
        settings,
        now,
        blockingReasons,
      });

      const tierResult = classifySignalTier({
        regime: strategy.diagnostics.regime,
        trend: determineTrend(strategy.diagnostics.sma7, strategy.diagnostics.sma30),
        slope7: strategy.diagnostics.slope7,
        goldenCrossNewlyConfirmed: false,
        goldenCrossEpisodeActive: false,
        exitDecision: strategy.decision,
      });
      const previousTier = state.signalStates[pos.symbol]?.tier ?? null;
      const tierEscalated = isNewSignalEscalation(previousTier, tierResult.tier);
      await updateState((s) => ({
        ...s,
        signalStates: {
          ...s.signalStates,
          [pos.symbol]: { tier: tierResult.tier, reason: tierResult.reason, updatedAt: now },
        },
      }));

      if (isNewCloseTransition(pos.decision, strategy.decision)) {
        await appendAuditEntry(
          makeAuditEntry(state, "SELL_CONDITION_TRIGGERED", strategy.reason, {
            symbol: pos.symbol,
            fingerprint: pos.fingerprint,
            entryPrice: pos.openingPrice,
            currentPrice: apiPrice,
            currentReturnPct: strategy.diagnostics.currentReturnPct,
            peakReturnPct: strategy.peakReturnPct,
            profitFloorPct: strategy.profitFloorPct,
            smaFast: strategy.diagnostics.sma7,
            smaSlow: strategy.diagnostics.sma30,
            closeCounter: strategy.consecutiveClosesBelowSma7,
            decision: strategy.decision,
          })
        );
        if (state.operatingMode === "CRUISE") {
          await notify(`${pos.symbol}: sell condition triggered`, strategy.reason);
        }
      } else if (tierEscalated && tierResult.tier !== "HOLD" && state.operatingMode === "CRUISE") {
        await appendAuditEntry(
          makeAuditEntry(
            state,
            "SIGNAL_TIER_CHANGED",
            `${pos.symbol}: ${previousTier ?? "HOLD"} -> ${tierResult.tier} (${tierResult.reason})`,
            { symbol: pos.symbol, fingerprint: pos.fingerprint, decision: strategy.decision }
          )
        );
        await notify(`${pos.symbol}: ${tierResult.tier}`, tierResult.reason);
        await sendSignalTierWebhook(
          state.settings.executionWebhookUrl,
          { symbol: pos.symbol, tier: tierResult.tier, reason: tierResult.reason, timestamp: Date.now() },
          state.settings.executionEmailAddress
        );
      }
      if (
        state.executionMode === "ARMED_AUTO_CLOSE" &&
        !state.autoCloseLive &&
        state.armedUntil !== null &&
        state.armedUntil > now &&
        strategy.decision === "CLOSE" &&
        !state.autoCloseDryRunIntents[pos.fingerprint]
      ) {
        await appendAuditEntry(
          makeAuditEntry(
            state,
            "AUTO_CLOSE_DRY_RUN_INTENT",
            `Dry-run auto-close intent: ${strategy.reason}`,
            {
              symbol: pos.symbol,
              fingerprint: pos.fingerprint,
              entryPrice: pos.openingPrice,
              currentPrice: apiPrice,
              currentReturnPct: strategy.diagnostics.currentReturnPct,
              peakReturnPct: strategy.peakReturnPct,
              profitFloorPct: strategy.profitFloorPct,
              smaFast: strategy.diagnostics.sma7,
              smaSlow: strategy.diagnostics.sma30,
              closeCounter: strategy.consecutiveClosesBelowSma7,
              decision: strategy.decision,
              executionResult: "BLOCKED",
              errorDetails: "Dry-run only: automatic final close execution is not enabled.",
            }
          )
        );
        await updateState((s) => ({
          ...s,
          autoCloseDryRunIntents: { ...s.autoCloseDryRunIntents, [pos.fingerprint]: now },
        }));
        await notify(
          `${pos.symbol}: Auto-Close dry-run intent`,
          "A CLOSE signal is current. Dry-run mode logged the intent; no Kraken control was clicked.",
          { urgent: true }
        );
      }

      next[pos.fingerprint] = {
        ...pos,
        latestApiPrice: apiPrice,
        latestApiPriceAt: now,
        highestObservedPrice: Math.max(pos.highestObservedPrice, apiPrice, strategy.peakPrice),
        peakReturnPct: strategy.peakReturnPct,
        peakPrice: strategy.peakPrice,
        profitFloorPct: strategy.profitFloorPct,
        smaFast: strategy.diagnostics.sma7,
        smaSlow: strategy.diagnostics.sma30,
        trend:
          strategy.diagnostics.sma7 === null || strategy.diagnostics.sma30 === null
            ? "UNKNOWN"
            : strategy.diagnostics.sma7 > strategy.diagnostics.sma30
              ? "STRONG"
              : "WEAK",
        regime: strategy.diagnostics.regime,
        consecutiveClosesBelowSmaFast: strategy.consecutiveClosesBelowSma7,
        lastProcessedCandleTs: strategy.lastProcessedCandleTs,
        hardLossObservedSince: strategy.hardLossObservedSince,
        hardLossObservationCount: strategy.hardLossObservationCount,
        strategyDiagnostics: strategy.diagnostics,
        decision: strategy.decision,
        reason: strategy.reason,
      };
    }
  }

  return next;
}

/** Extracts "/prop/account/<id>" from a Kraken Prop URL's pathname, so a
 * trade-page or portfolio-page URL can be rebuilt from whatever page the
 * tab is currently on, without ever hardcoding an account ID. */
function krakenAccountPathPrefix(url: string): string | null {
  try {
    const match = new URL(url).pathname.match(/^(\/prop\/account\/[^/]+)\//);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

/** Kraken's own web UI uses the plain UI symbol in its Trade URLs (e.g.
 * "btc-usd", "jto-usd" — confirmed via a real diagnostics run), which is
 * NOT always the same as the public API's pair naming (BTC's API pair is
 * XBTUSD) — deliberately does not reuse resolvePublicMarket's pairParam
 * here for that reason. */
function buildTradeUrl(currentUrl: string, symbol: string): string | null {
  const prefix = krakenAccountPathPrefix(currentUrl);
  if (!prefix) return null;
  try {
    const url = new URL(currentUrl);
    url.pathname = `${prefix}/trade/${symbol.toLowerCase()}-usd`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function buildPortfolioUrl(currentUrl: string): string | null {
  const prefix = krakenAccountPathPrefix(currentUrl);
  if (!prefix) return null;
  try {
    const url = new URL(currentUrl);
    url.pathname = `${prefix}/portfolio`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Navigates the Kraken tab to a specific URL (a real browser navigation,
 * not a synthetic click on any in-page search widget — deliberately chosen
 * over automating Kraken's own market-search box, which would be a whole
 * additional unvalidated DOM surface). Polls chrome.tabs.get for
 * status "complete" rather than relying on onUpdated event timing, mirroring
 * this file's existing simple-polling style (see verifyCloseSubmitted). */
async function navigateKrakenTab(tabId: number, url: string, timeoutMs = 10_000): Promise<boolean> {
  try {
    await chrome.tabs.update(tabId, { url });
  } catch {
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** After a navigation, the content script re-injects and the SPA needs a
 * moment to render the Trade page's order form — polls the existing
 * read-only Order-Form Diagnostics message (never clicks/fills anything)
 * until the panel is detected and clearly references the target symbol,
 * rather than assuming the page is ready the instant tab status flips to
 * "complete". */
async function waitForOrderFormReady(tabId: number, symbol: string, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const symbolPattern = new RegExp(`\\b${symbol.toUpperCase()}\\b`, "i");
  while (Date.now() < deadline) {
    try {
      const raw = await sendMessageToKrakenTab(tabId, { type: "RUN_ORDER_FORM_DIAGNOSTICS" });
      if (
        isExtensionMessage(raw) &&
        raw.type === "ORDER_FORM_DIAGNOSTICS_RESULT" &&
        raw.report?.orderEntryPanelDetected &&
        raw.report.buyTabControl?.found &&
        symbolPattern.test(raw.report.rawPanelTextExcerpt ?? "")
      ) {
        return true;
      }
    } catch {
      // Content script may not be re-injected yet immediately after
      // navigation; keep retrying until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

/** Picks at most one Autopilot buy candidate per cycle — a watchlist
 * symbol (no existing position; once bought, position detection excludes
 * it from this list entirely on its own) at BUY/STRONG_BUY tier, under its
 * position-size cap, not on cooldown. Deliberately conservative for this
 * first pass: exactly one buy attempt per scan cycle (never a batch loop
 * like processLiveAutoClose's), using the normal cycle cadence itself as
 * the rate limiter while this surface is new. Gated on the exact same
 * "really armed" flag (executionMode/autoCloseLive) the sell side already
 * uses, so buy execution inherits every existing precondition (preflight
 * pass, keep-awake active, session logged in, no unresolved sleep gap,
 * tab present) for free. */
async function processAutopilotBuys(state: RuntimeState): Promise<void> {
  if (state.operatingMode !== "AUTOPILOT") return;
  if (state.executionMode !== "ARMED_AUTO_CLOSE" || !state.autoCloseLive) return;
  if (autoBuyInFlight) return;
  if (state.closeExecution && !isExecutionTerminal(state.closeExecution.state)) return;

  const now = Date.now();
  const cooldownMs = Math.max(state.settings.pollMinutes * 3, 15) * 60_000;
  const activeSymbols = new Set(
    Object.values(state.positions)
      .filter((p) => p.status === "ACTIVE")
      .map((p) => p.symbol)
  );

  const tierRank: Record<string, number> = { STRONG_BUY: 2, BUY: 1 };
  const candidate = state.settings.watchlistCoins
    .filter((symbol) => !activeSymbols.has(symbol))
    .map((symbol) => ({ symbol, tier: state.signalStates[symbol]?.tier, row: state.marketData[symbol] }))
    .filter(
      (c): c is { symbol: string; tier: "BUY" | "STRONG_BUY"; row: NonNullable<typeof c.row> } =>
        (c.tier === "BUY" || c.tier === "STRONG_BUY") &&
        c.row !== undefined &&
        c.row.apiStatus === "OK" &&
        !c.row.atOrAboveSizeCap &&
        c.row.suggestedBuyUnits !== null &&
        c.row.suggestedBuyUnits > 0
    )
    .filter((c) => {
      const last = state.autoBuyIntents[c.symbol];
      return !last || now - last > cooldownMs;
    })
    .sort((a, b) => tierRank[b.tier]! - tierRank[a.tier]!)[0];

  if (!candidate) return;
  const quantityUnits = candidate.row.suggestedBuyUnits!;

  autoBuyInFlight = true;
  try {
    await updateState((s) => ({
      ...s,
      autoBuyIntents: { ...s.autoBuyIntents, [candidate.symbol]: now },
    }));

    const tab = await findKrakenTab();
    if (!tab || tab.id === undefined) return;
    const originalUrl = tab.url ?? "";
    const returnToUrl = buildPortfolioUrl(originalUrl) ?? originalUrl;

    const fail = async (reason: string): Promise<void> => {
      await appendAuditEntry(
        makeAuditEntry(state, "AUTO_BUY_BLOCKED", `${candidate.symbol}: ${reason}`, {
          symbol: candidate.symbol,
          executionResult: "BLOCKED",
          errorDetails: reason,
        })
      );
      await notify(`${candidate.symbol}: auto-buy blocked`, reason, { urgent: true });
      await sendExecutionWebhook(state.settings.executionWebhookUrl, {
        symbol: candidate.symbol,
        lotLabel: null,
        result: "FAILURE",
        mode: "AUTO_BUY",
        reason,
        entryPrice: null,
        currentPrice: candidate.row.currentApiPrice,
        currentReturnPct: null,
        details: [],
        timestamp: Date.now(),
      });
    };

    const tradeUrl = buildTradeUrl(originalUrl, candidate.symbol);
    if (!tradeUrl) {
      await fail(`Could not build a trade-page URL for ${candidate.symbol} from the current tab URL.`);
      return;
    }

    if (!(await navigateKrakenTab(tab.id, tradeUrl))) {
      await fail(`Navigation to ${candidate.symbol}'s trade page did not complete in time.`);
      return;
    }
    if (!(await waitForOrderFormReady(tab.id, candidate.symbol))) {
      await fail(`Order form for ${candidate.symbol} was not ready after navigating.`);
      await navigateKrakenTab(tab.id, returnToUrl);
      return;
    }

    const openRaw = await sendMessageToKrakenTab(tab.id, {
      type: "OPEN_BUY_ORDER",
      symbol: candidate.symbol,
      quantityUnits,
    });
    if (!isExtensionMessage(openRaw) || openRaw.type !== "OPEN_BUY_ORDER_RESULT" || !openRaw.report?.ready) {
      const reason =
        isExtensionMessage(openRaw) && openRaw.type === "OPEN_BUY_ORDER_RESULT"
          ? (openRaw.report?.blockedReason ?? openRaw.error ?? "unknown")
          : "no response from content script";
      await fail(`${reason}`);
      await navigateKrakenTab(tab.id, returnToUrl);
      return;
    }

    const confirmedQuantity = openRaw.report.quantitySet ?? quantityUnits;
    const confirmRaw = await sendMessageToKrakenTab(tab.id, {
      type: "CONFIRM_BUY_ORDER",
      symbol: candidate.symbol,
      quantityUnits: confirmedQuantity,
    });
    await navigateKrakenTab(tab.id, returnToUrl);

    if (
      isExtensionMessage(confirmRaw) &&
      confirmRaw.type === "CONFIRM_BUY_ORDER_RESULT" &&
      confirmRaw.clicked &&
      confirmRaw.modalValidation?.ready
    ) {
      const succeeded = await getState();
      await appendAuditEntry(
        makeAuditEntry(
          succeeded,
          "AUTO_BUY_SUCCEEDED",
          `${candidate.symbol} Autopilot buy submitted (~${confirmedQuantity} units).`,
          { symbol: candidate.symbol, executionResult: "SUCCESS" }
        )
      );
      await notify(
        `${candidate.symbol} auto-bought`,
        `Autopilot placed a market buy for ~${confirmedQuantity} ${candidate.symbol}.`,
        { urgent: true }
      );
      await sendExecutionWebhook(succeeded.settings.executionWebhookUrl, {
        symbol: candidate.symbol,
        lotLabel: null,
        result: "SUCCESS",
        mode: "AUTO_BUY",
        reason: candidate.tier === "STRONG_BUY" ? "STRONG_BUY signal" : "BUY signal",
        entryPrice: candidate.row.currentApiPrice,
        currentPrice: candidate.row.currentApiPrice,
        currentReturnPct: null,
        details: [],
        timestamp: Date.now(),
      });
    } else {
      const reason =
        isExtensionMessage(confirmRaw) && confirmRaw.type === "CONFIRM_BUY_ORDER_RESULT"
          ? (confirmRaw.modalValidation?.blockedReason ?? confirmRaw.error ?? "unknown")
          : "no response from content script";
      const uncertainState = await getState();
      await appendAuditEntry(
        makeAuditEntry(
          uncertainState,
          "AUTO_BUY_UNCERTAIN",
          `${candidate.symbol}: ${reason} — verify manually on Kraken.`,
          { symbol: candidate.symbol, executionResult: "FAILURE", errorDetails: reason }
        )
      );
      await notify(
        `${candidate.symbol}: auto-buy uncertain`,
        `Verify manually on Kraken whether this order was placed. ${reason}`,
        { urgent: true }
      );
      await sendExecutionWebhook(uncertainState.settings.executionWebhookUrl, {
        symbol: candidate.symbol,
        lotLabel: null,
        result: "UNCERTAIN",
        mode: "AUTO_BUY",
        reason,
        entryPrice: candidate.row.currentApiPrice,
        currentPrice: candidate.row.currentApiPrice,
        currentReturnPct: null,
        details: [],
        timestamp: Date.now(),
      });
    }
  } finally {
    autoBuyInFlight = false;
  }
}

async function processLiveAutoClose(initialState: RuntimeState): Promise<void> {
  if (autoCloseInFlight) return;
  // Defense in depth: the in-memory flag above is the primary lock, but it
  // does not survive a service-worker restart mid-execution. The persisted
  // closeExecution record does — if it exists and isn't terminal, treat
  // that as "still in flight" too, rather than starting a second attempt.
  // (resetToSafeDefaultsOnRestart also independently detects and marks any
  // such interrupted record UNCERTAIN on the next restart; this check
  // covers the window before that has a chance to run.)
  if (initialState.closeExecution && !isExecutionTerminal(initialState.closeExecution.state))
    return;

  autoCloseInFlight = true;
  try {
    // Processes every currently qualifying CLOSE candidate this cycle, not
    // just the first. Each iteration re-derives `state` from the previous
    // iteration's post-close, freshly-verified scan (verifyCloseSubmitted
    // already rescans the whole page before confirming SUCCESS) before
    // picking the next candidate — so no two closes are ever attempted
    // against stale DOM/position data, even though several may happen in
    // quick succession within one cycle.
    let state = initialState;
    for (;;) {
      const now = Date.now();
      if (
        state.monitoringStatus !== "RUNNING" ||
        state.executionMode !== "ARMED_AUTO_CLOSE" ||
        !state.autoCloseLive ||
        state.armedUntil === null ||
        state.armedUntil <= now
      ) {
        return;
      }

      const candidate = Object.values(state.positions).find(
        (pos) =>
          pos.status === "ACTIVE" &&
          pos.decision === "CLOSE" &&
          !pos.autoCloseDisabledReason &&
          !state.autoCloseDryRunIntents[pos.fingerprint]
      );
      if (!candidate) return;

      const recentCloses = state.liveAutoCloseStats.closeTimestamps.filter(
        (ts) => now - ts < 60 * 60_000
      );
      if (recentCloses.length >= state.settings.maxLiveClosesPerHour) {
        await disarmLiveAutoClose(
          `Hourly live close limit reached (${state.settings.maxLiveClosesPerHour}).`
        );
        return;
      }
      if (
        state.liveAutoCloseStats.closesThisSession >= state.settings.maxLiveClosesPerArmedSession
      ) {
        await disarmLiveAutoClose(
          `Armed-session live close limit reached (${state.settings.maxLiveClosesPerArmedSession}).`
        );
        return;
      }

      const tab = await findKrakenTab();
      if (!tab || tab.id === undefined) {
        await disarmLiveAutoClose("Auto-Close disarmed: Kraken tab missing before live execution.");
        return;
      }

      const intentId = `${candidate.symbol}-${candidate.fingerprint}-${now}`;
      const beforeFingerprints = Object.values(state.positions)
        .filter((pos) => pos.status === "ACTIVE")
        .map((pos) => pos.fingerprint);
      const intent: CloseExecutionRecord = {
        intentId,
        fingerprint: candidate.fingerprint,
        symbol: candidate.symbol,
        lotLabel: null,
        trigger: candidate.reason,
        startedAt: now,
        updatedAt: now,
        state: "CREATED",
        result: null,
        details: ["Live Auto-Close intent created."],
      };
      await updateState((s) => ({
        ...s,
        autoCloseDryRunIntents: { ...s.autoCloseDryRunIntents, [candidate.fingerprint]: now },
        closeExecution: intent,
      }));
      await appendAuditEntry(
        makeAuditEntry(
          state,
          "AUTO_CLOSE_EXECUTION_STARTED",
          `Live Auto-Close started: ${candidate.reason}`,
          {
            symbol: candidate.symbol,
            fingerprint: candidate.fingerprint,
            entryPrice: candidate.openingPrice,
            currentPrice: candidate.latestApiPrice,
            currentReturnPct:
              candidate.latestApiPrice !== null
                ? computeCurrentReturnPct(candidate.openingPrice, candidate.latestApiPrice)
                : null,
            peakReturnPct: candidate.peakReturnPct,
            profitFloorPct: candidate.profitFloorPct,
            smaFast: candidate.smaFast,
            smaSlow: candidate.smaSlow,
            closeCounter: candidate.consecutiveClosesBelowSmaFast,
            decision: candidate.decision,
          }
        )
      );

      await updateCloseExecution({
        state: "DIALOG_OPENING",
        details: ["Opening Kraken close dialog."],
      });
      const openRaw = await sendMessageToKrakenTab(tab.id, {
        type: "OPEN_CLOSE_DIALOG",
        fingerprint: candidate.fingerprint,
        symbol: candidate.symbol,
        lotLabel: null,
      });
      if (
        !isExtensionMessage(openRaw) ||
        openRaw.type !== "OPEN_CLOSE_DIALOG_RESULT" ||
        !openRaw.report?.ready
      ) {
        await updateCloseExecution({
          state: "BLOCKED",
          result: "BLOCKED",
          details: ["Could not validate close dialog."],
        });
        await disarmLiveAutoClose(
          `Auto-Close disarmed: could not validate close dialog for ${candidate.symbol}. ${
            isExtensionMessage(openRaw) && openRaw.type === "OPEN_CLOSE_DIALOG_RESULT"
              ? (openRaw.report?.blockedReason ?? openRaw.error ?? "")
              : "Unexpected response."
          }`
        );
        return;
      }

      await updateCloseExecution({
        state: "MODAL_VALIDATED",
        details: ["Kraken close modal validated."],
      });
      await updateCloseExecution({
        state: "FINAL_SUBMITTING",
        details: ["Fresh revalidation running before final submit."],
      });
      const revalidated = await revalidateCloseCandidateBeforeSubmit(intent, tab.id);
      if (!revalidated.ok) {
        await updateCloseExecution({
          state: "BLOCKED",
          result: "BLOCKED",
          details: [revalidated.reason],
        });
        await appendAuditEntry(
          makeAuditEntry(state, "AUTO_CLOSE_BLOCKED", revalidated.reason, {
            symbol: candidate.symbol,
            fingerprint: candidate.fingerprint,
            executionResult: "BLOCKED",
            errorDetails: revalidated.reason,
          })
        );
        await disarmLiveAutoClose(`Auto-Close disarmed before final submit: ${revalidated.reason}`);
        return;
      }

      await updateCloseExecution({
        state: "VERIFYING",
        details: ["Final close submitted. Verifying exact lot removal."],
      });
      const verification = await verifyCloseSubmitted(tab.id, candidate, beforeFingerprints);
      const verified = await getState();
      if (verification.ok) {
        const done = await updateState((s) => ({
          ...s,
          closeExecution: s.closeExecution
            ? {
                ...s.closeExecution,
                state: "SUCCEEDED",
                result: "SUCCESS",
                details: verification.details,
                updatedAt: Date.now(),
              }
            : s.closeExecution,
          liveAutoCloseStats: {
            ...s.liveAutoCloseStats,
            closesThisSession: s.liveAutoCloseStats.closesThisSession + 1,
            closeTimestamps: [...recentCloses, Date.now()],
          },
        }));
        await appendAuditEntry(
          makeAuditEntry(
            done,
            "AUTO_CLOSE_SUCCEEDED",
            `${candidate.symbol} live Auto-Close verified.`,
            {
              symbol: candidate.symbol,
              fingerprint: candidate.fingerprint,
              executionResult: "SUCCESS",
              errorDetails: verification.details.join("; "),
              realizedPnlUsd: candidate.latest?.netPnl ?? null,
            }
          )
        );
        await notify(`${candidate.symbol} auto-closed`, "Live Auto-Close verified on Kraken.", {
          urgent: true,
        });
        await sendExecutionWebhook(
          done.settings.executionWebhookUrl,
          {
            symbol: candidate.symbol,
            lotLabel: null,
            result: "SUCCESS",
            mode: "LIVE_AUTO_CLOSE",
            reason: candidate.reason,
            entryPrice: candidate.openingPrice,
            currentPrice: candidate.latestApiPrice,
            currentReturnPct: computeCurrentReturnPct(
              candidate.openingPrice,
              candidate.latestApiPrice ?? candidate.openingPrice
            ),
            details: verification.details,
            timestamp: Date.now(),
          },
          done.settings.executionEmailAddress
        );
        // Look for any other qualifying candidate this same cycle, using the
        // already-fresh, already-verified state from this close.
        state = done;
        continue;
      }

      await updateCloseExecution({
        state: verification.uncertain ? "UNCERTAIN" : "FAILED",
        result: verification.uncertain ? "UNCERTAIN" : "FAILURE",
        details: verification.details,
      });
      await appendAuditEntry(
        makeAuditEntry(
          verified,
          "CLOSE_FAILED",
          `${candidate.symbol} Auto-Close uncertain; lot still appears active.`,
          {
            symbol: candidate.symbol,
            fingerprint: candidate.fingerprint,
            executionResult: "FAILURE",
            errorDetails: verification.details.join("; "),
          }
        )
      );
      await sendExecutionWebhook(
        verified.settings.executionWebhookUrl,
        {
          symbol: candidate.symbol,
          lotLabel: null,
          result: verification.uncertain ? "UNCERTAIN" : "FAILURE",
          mode: "LIVE_AUTO_CLOSE",
          reason: candidate.reason,
          entryPrice: candidate.openingPrice,
          currentPrice: candidate.latestApiPrice,
          currentReturnPct: computeCurrentReturnPct(
            candidate.openingPrice,
            candidate.latestApiPrice ?? candidate.openingPrice
          ),
          details: verification.details,
          timestamp: Date.now(),
        },
        verified.settings.executionEmailAddress
      );
      await disarmLiveAutoClose(
        `Auto-Close disarmed: ${candidate.symbol} result uncertain after final click.`,
        {
          uncertain: true,
        }
      );
      return;
    }
  } finally {
    autoCloseInFlight = false;
  }
}

async function processScanResult(
  scan: ScanResultMessage,
  tabId: number | undefined,
  options: { skipLiveAutoClose?: boolean; skipMarketRefresh?: boolean } = {}
): Promise<void> {
  const now = Date.now();
  const state = await getState();
  // Only positive evidence of being logged out matters here — UNKNOWN must
  // never be treated as logged out, and zero parsed positions is a parser-
  // calibration signal, not a session signal.
  const wasLoggedOut = state.pageHealth?.sessionState === "LOGGED_OUT";
  const nowLoggedOut = scan.pageHealth.sessionState === "LOGGED_OUT";

  let positions = reconcilePositions(scan.positions, state.positions, now);

  if (nowLoggedOut) {
    positions = Object.fromEntries(
      Object.entries(positions).map(([fp, pos]) => {
        if (pos.status !== "ACTIVE") return [fp, pos];
        return [
          fp,
          {
            ...pos,
            decision: "ERROR" as const,
            reason:
              "Login required: Kraken session appears logged out (login form, CAPTCHA, 2FA, device approval, or session-expired modal detected).",
          },
        ];
      })
    );
    if (!wasLoggedOut) {
      await appendAuditEntry(
        makeAuditEntry(state, "LOGIN_REQUIRED", "Kraken session appears logged out.")
      );
      await notify(
        "Login required",
        "Kraken Prop session looks logged out. Log in manually, then press Resume Monitoring.",
        { urgent: true }
      );
    }
    if (state.executionMode === "ARMED_AUTO_CLOSE" && state.autoCloseLive) {
      await disarmLiveAutoClose("Kraken login/session is no longer authenticated.");
    }
  } else {
    positions = await evaluatePositions(positions, state, now);
  }

  const next = await updateState((s) => ({
    ...s,
    positions,
    pageHealth: scan.pageHealth,
    lastPositionScanAt: now,
    // A successful scan message is itself proof the content script is
    // alive and reachable, regardless of monitoringStatus — this is what
    // fixes "Kraken tab: disconnected" showing up alongside a working
    // diagnostics response.
    krakenTabId: tabId ?? s.krakenTabId,
    lastContentScriptResponseAt: now,
    lastCandidateRowCount: scan.candidateRowCount,
    lastRowDiscoveryMethod: scan.rowDiscoveryMethod,
    accountEquityUsd: scan.accountEquityUsd ?? s.accountEquityUsd,
    accountEquityUpdatedAt: scan.accountEquityUsd !== null ? now : s.accountEquityUpdatedAt,
  }));
  if (pendingManualPositionRefresh) {
    pendingManualPositionRefresh = false;
    await appendAuditEntry(
      makeAuditEntry(next, "POSITION_SCAN_COMPLETED", "Manual position scan completed.", {
        executionResult: "SUCCESS",
      })
    );
  }
  await broadcastState(next);
  if (next.executionMode === "ARMED_AUTO_CLOSE" && next.autoCloseLive) {
    const parserDegraded =
      !scan.pageHealth.propPageDetected ||
      !scan.pageHealth.positionsTableReadable ||
      scan.pageHealth.sessionState !== "LOGGED_IN" ||
      scan.candidateRowCount === 0;
    const changed = Object.values(positions).find(
      (pos) => pos.status === "CHANGED" || Boolean(pos.autoCloseDisabledReason)
    );
    const maxAgeMs = next.settings.pollMinutes * 2 * 60_000;
    const marketProblem = activeAutoClosePositions(next)
      .map((pos) => marketRowHealthyForPosition(next, pos, now, maxAgeMs))
      .find((problem): problem is string => problem !== null);
    if (parserDegraded) {
      await disarmLiveAutoClose("Parser or page health degraded while LIVE Auto-Close was armed.");
      return;
    }
    if (changed) {
      await disarmLiveAutoClose(
        `${changed.symbol} position fingerprint or close-control ownership changed.`
      );
      return;
    }
    if (marketProblem) {
      await disarmLiveAutoClose(
        `Market/API health failed while LIVE Auto-Close was armed: ${marketProblem}`
      );
      return;
    }
  }
  if (!options.skipLiveAutoClose) await processLiveAutoClose(next);
  if (!options.skipMarketRefresh) await refreshMarketData({ automatic: false });
  // Runs after refreshMarketData so signalStates/marketData for watchlist
  // symbols are freshly computed this same cycle before deciding to buy.
  if (!options.skipLiveAutoClose) await processAutopilotBuys(await getState());
}

function nextMarketRefreshAt(settings: RuntimeState["settings"], now: number): number {
  return now + settings.marketRefreshMinutes * 60_000;
}

async function refreshMarketData(options: {
  symbol?: string;
  automatic: boolean;
}): Promise<RefreshMarketDataResultMessage> {
  const now = Date.now();
  const state = await getState();
  if (options.automatic && state.monitoringStatus !== "RUNNING") {
    return {
      type: "REFRESH_MARKET_DATA_RESULT",
      ok: true,
      symbol: options.symbol ?? null,
      error: null,
    };
  }

  const symbols = options.symbol ? [options.symbol] : undefined;
  const marketData = await buildMarketDataTable(state.settings, state.positions, now, {
    symbols,
    previous: state.marketData,
    preservePreviousOnError: true,
    accountEquityUsd: state.accountEquityUsd,
  });
  const refreshedSymbols = symbols ?? Object.keys(marketData);
  const failed = refreshedSymbols
    .map((symbol) => marketData[symbol])
    .filter(
      (row): row is NonNullable<typeof row> => row !== undefined && row.apiStatus === "ERROR"
    );
  const succeeded = refreshedSymbols.some((symbol) => marketData[symbol]?.apiStatus !== "ERROR");
  const error =
    failed.map((row) => `${row.symbol}: ${row.errorMessage ?? "unknown error"}`).join("; ") || null;

  const next = await updateState((s) => ({
    ...s,
    marketData,
    lastPriceUpdateAt: succeeded ? now : s.lastPriceUpdateAt,
    nextMarketRefreshAt:
      options.automatic && s.monitoringStatus === "RUNNING"
        ? nextMarketRefreshAt(s.settings, now)
        : s.nextMarketRefreshAt,
  }));

  if (failed.length > 0) {
    await appendAuditEntry(
      makeAuditEntry(next, "MARKET_REFRESH_FAILED", error ?? "Market refresh failed.", {
        symbol: options.symbol ?? null,
        executionResult: "FAILURE",
        errorDetails: error,
      })
    );
    if (next.executionMode === "ARMED_AUTO_CLOSE" && next.autoCloseLive) {
      await disarmLiveAutoClose(
        `Public API refresh failed while LIVE Auto-Close was armed: ${error ?? "unknown error"}.`
      );
    }
  }

  if (next.settings.watchlistCoins.length > 0) {
    const activePositionSymbols = new Set(
      Object.values(next.positions)
        .filter((p) => p.status === "ACTIVE")
        .map((p) => p.symbol)
    );
    const updates = await evaluateWatchlistBuySignals(
      next.settings,
      next.watchlistSignals,
      activePositionSymbols
    );
    const withSignals = await updateState((s) => ({
      ...s,
      watchlistSignals: {
        ...s.watchlistSignals,
        ...Object.fromEntries(updates.map((u) => [u.symbol, u.state])),
      },
      signalStates: {
        ...s.signalStates,
        ...Object.fromEntries(
          updates.map((u) => [u.symbol, { tier: u.tier, reason: u.tierReason, updatedAt: now }])
        ),
      },
    }));
    for (const update of updates) {
      const previousTier = next.signalStates[update.symbol]?.tier ?? null;
      if (update.newlyConfirmed) {
        await appendAuditEntry(
          makeAuditEntry(withSignals, "BUY_SIGNAL_DETECTED", `${update.symbol} golden cross confirmed.`, {
            symbol: update.symbol,
            currentPrice: update.currentPrice,
            smaFast: update.smaFast,
            smaSlow: update.smaSlow,
            closeCounter: update.state.consecutiveClosesAboveSmaFast,
          })
        );
        if (withSignals.operatingMode === "CRUISE") {
          await notify(
            `BUY SIGNAL: ${update.symbol}`,
            "Golden cross confirmed. This is informational only — place a manual order if you agree."
          );
          await sendBuySignalWebhook(
            withSignals.settings.executionWebhookUrl,
            {
              symbol: update.symbol,
              currentPrice: update.currentPrice,
              smaFast: update.smaFast,
              smaSlow: update.smaSlow,
              consecutiveClosesAboveSmaFast: update.state.consecutiveClosesAboveSmaFast,
              timestamp: Date.now(),
            },
            withSignals.settings.executionEmailAddress
          );
        }
      } else if (isNewSignalEscalation(previousTier, update.tier) && update.tier !== "HOLD") {
        await appendAuditEntry(
          makeAuditEntry(
            withSignals,
            "SIGNAL_TIER_CHANGED",
            `${update.symbol}: ${previousTier ?? "HOLD"} -> ${update.tier} (${update.tierReason})`,
            { symbol: update.symbol }
          )
        );
        if (withSignals.operatingMode === "CRUISE") {
          await notify(`${update.symbol}: ${update.tier}`, update.tierReason);
          await sendSignalTierWebhook(
            withSignals.settings.executionWebhookUrl,
            { symbol: update.symbol, tier: update.tier, reason: update.tierReason, timestamp: Date.now() },
            withSignals.settings.executionEmailAddress
          );
        }
      }
    }
    await broadcastState(withSignals);
  } else {
    await broadcastState(next);
  }
  return {
    type: "REFRESH_MARKET_DATA_RESULT",
    ok: failed.length === 0,
    symbol: options.symbol ?? null,
    error,
  };
}

async function handleMessage(
  message: ExtensionMessage,
  sendResponse: (response?: unknown) => void,
  senderTabId: number | undefined
): Promise<void> {
  switch (message.type) {
    case "POSITIONS_SCAN_RESULT":
      await processScanResult(message, senderTabId);
      break;
    case "GET_STATE": {
      const state = await getState();
      const response: StateSnapshotMessage = { type: "STATE_SNAPSHOT", state };
      sendResponse(response);
      break;
    }
    case "START_MONITORING":
      await handleStartMonitoring();
      break;
    case "STOP_MONITORING":
      await handleStopMonitoring();
      break;
    case "ARM_AUTO_CLOSE":
      await handleArmAutoClose(message.durationHours, message.live);
      break;
    case "SET_OPERATING_MODE":
      await setOperatingMode(message.mode);
      break;
    case "START_MONITORING_WITH_LIVE_AUTO_CLOSE": {
      const result = await handleStartMonitoringWithLiveAutoClose(message.durationHours);
      sendResponse({ type: "START_MONITORING_WITH_LIVE_AUTO_CLOSE_RESULT", ...result });
      break;
    }
    case "RUN_LIVE_PREFLIGHT": {
      const result = await canArmLiveAutoClose();
      sendResponse({ type: "RUN_LIVE_PREFLIGHT_RESULT", result });
      break;
    }
    case "DISARM_AUTO_CLOSE":
      await disarmAutoClose("User disarmed Auto-Close.");
      break;
    case "REFRESH_POSITIONS":
      pendingManualPositionRefresh = true;
      await runPositionRefreshCycle();
      break;
    case "REFRESH_MARKET_DATA": {
      if (!message.symbol) {
        const scanned = await runPositionRefreshCycle();
        const response: RefreshMarketDataResultMessage = {
          type: "REFRESH_MARKET_DATA_RESULT",
          ok: scanned,
          symbol: null,
          error: scanned ? null : "Could not scan the Kraken Prop page.",
        };
        sendResponse(response);
        break;
      }
      const response = await refreshMarketData({ symbol: message.symbol, automatic: false });
      sendResponse(response);
      break;
    }
    case "SET_EXECUTION_MODE":
      if (message.mode !== "MONITOR_ONLY") {
        console.warn(
          `[kraken-guard] execution mode ${message.mode} is not implemented in this iteration; staying in MONITOR_ONLY.`
        );
      }
      break;
    case "TEST_NOTIFICATION": {
      const testedAt = Date.now();
      const state = await updateState((s) => ({ ...s, lastNotificationTestAt: testedAt }));
      try {
        await notify("Test notification", "If you see this, kraken-guard notifications work.", {
          urgent: true,
        });
        await appendAuditEntry(
          makeAuditEntry(state, "TEST_NOTIFICATION", "Manual test notification succeeded.", {
            executionResult: "SUCCESS",
          })
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await appendAuditEntry(
          makeAuditEntry(state, "TEST_NOTIFICATION", "Manual test notification failed.", {
            executionResult: "FAILURE",
            errorDetails: message,
          })
        );
        console.warn("[kraken-guard] test notification failed:", message);
      }
      break;
    }
    case "EXPORT_LOGS": {
      const json = await exportAuditLogAsJson();
      const response: ExportLogsResultMessage = { type: "EXPORT_LOGS_RESULT", json };
      sendResponse(response);
      break;
    }
    case "CLEAR_LOGS":
      await clearAuditLog();
      break;
    case "UPDATE_SETTINGS": {
      const now = Date.now();
      const next = await updateState((s) => ({
        ...s,
        settings: message.settings,
        nextMarketRefreshAt:
          s.monitoringStatus === "RUNNING"
            ? now + message.settings.marketRefreshMinutes * 60_000
            : null,
      }));
      if (next.monitoringStatus === "RUNNING") {
        await startPolling(next.settings.pollMinutes);
        await startMarketDataPolling(next.settings.marketRefreshMinutes);
      }
      await broadcastState(next);
      break;
    }
    case "RESET_SETTINGS": {
      const now = Date.now();
      const next = await updateState((s) => ({
        ...s,
        settings: { ...DEFAULT_SETTINGS },
        nextMarketRefreshAt:
          s.monitoringStatus === "RUNNING"
            ? now + DEFAULT_SETTINGS.marketRefreshMinutes * 60_000
            : null,
      }));
      if (next.monitoringStatus === "RUNNING") {
        await startPolling(next.settings.pollMinutes);
        await startMarketDataPolling(next.settings.marketRefreshMinutes);
      }
      await broadcastState(next);
      break;
    }
    case "RUN_DOM_DIAGNOSTICS":
      await handleRunDomDiagnostics(sendResponse);
      break;
    case "RUN_ORDER_FORM_DIAGNOSTICS":
      await handleRunOrderFormDiagnostics(sendResponse);
      break;
    case "PREVIEW_CLOSE":
      await handlePreviewClose(message, sendResponse);
      break;
    case "OPEN_CLOSE_DIALOG":
      await handleOpenCloseDialog(message, sendResponse);
      break;
    case "CONFIRM_CLOSE_DIALOG":
      await handleConfirmCloseDialog(message, sendResponse);
      break;
    case "OPEN_BUY_ORDER":
      await handleOpenBuyOrder(message, sendResponse);
      break;
    case "CONFIRM_BUY_ORDER":
      await handleConfirmBuyOrder(message, sendResponse);
      break;
    default:
      break;
  }
}

async function handleConfirmCloseDialog(
  message: Extract<ExtensionMessage, { type: "CONFIRM_CLOSE_DIALOG" }>,
  sendResponse: (response?: unknown) => void
): Promise<void> {
  const tab = await findKrakenTab();
  if (!tab || tab.id === undefined) {
    sendResponse({
      type: "CONFIRM_CLOSE_DIALOG_RESULT",
      modalValidation: null,
      clicked: false,
      error: "No Kraken Prop tab found. Open the Portfolio page and try again.",
    } satisfies ConfirmCloseDialogResultMessage);
    return;
  }

  try {
    const before = await getState();
    const beforeFingerprints = Object.values(before.positions)
      .filter((pos) => pos.status === "ACTIVE")
      .map((pos) => pos.fingerprint);
    const manualCandidate = message.fingerprint
      ? (before.positions[message.fingerprint] ?? null)
      : null;
    if (manualCandidate) {
      const now = Date.now();
      await updateState((s) => ({
        ...s,
        closeExecution: {
          intentId: `manual-${manualCandidate.symbol}-${manualCandidate.fingerprint}-${now}`,
          fingerprint: manualCandidate.fingerprint,
          symbol: manualCandidate.symbol,
          lotLabel: null,
          trigger: "Manual admin close",
          startedAt: now,
          updatedAt: now,
          state: "FINAL_SUBMITTING",
          result: null,
          details: ["Manual final close submitting."],
        },
      }));
    }
    const raw: unknown = await sendMessageToKrakenTab(tab.id, message);
    if (!isExtensionMessage(raw) || raw.type !== "CONFIRM_CLOSE_DIALOG_RESULT") {
      sendResponse({
        type: "CONFIRM_CLOSE_DIALOG_RESULT",
        modalValidation: null,
        clicked: false,
        error: "Unexpected response from the content script.",
      } satisfies ConfirmCloseDialogResultMessage);
      return;
    }

    if (raw.clicked && message.fingerprint) {
      if (manualCandidate)
        await updateCloseExecution({
          state: "VERIFYING",
          details: ["Manual final close clicked. Verifying."],
        });
      const verification = manualCandidate
        ? await verifyCloseSubmitted(tab.id, manualCandidate, beforeFingerprints)
        : {
            ok: false,
            uncertain: true,
            details: ["Manual candidate was not found before final click."],
          };
      const state = await getState();
      if (verification.ok) {
        await updateCloseExecution({
          state: "SUCCEEDED",
          result: "SUCCESS",
          details: verification.details,
        });
        await appendAuditEntry(
          makeAuditEntry(
            state,
            "MANUAL_POSITION_CLOSE_SUCCEEDED",
            `${message.symbol} manual close verified.`,
            {
              symbol: message.symbol,
              fingerprint: message.fingerprint,
              executionResult: "SUCCESS",
              errorDetails: verification.details.join("; "),
              realizedPnlUsd: manualCandidate?.latest?.netPnl ?? null,
            }
          )
        );
        await notify(`${message.symbol} closed`, "Manual close verified on Kraken.");
        await sendExecutionWebhook(
          state.settings.executionWebhookUrl,
          {
            symbol: message.symbol,
            lotLabel: null,
            result: "SUCCESS",
            mode: "MANUAL",
            reason: manualCandidate?.reason ?? "Manual admin close",
            entryPrice: manualCandidate?.openingPrice ?? null,
            currentPrice: manualCandidate?.latestApiPrice ?? null,
            currentReturnPct: manualCandidate
              ? computeCurrentReturnPct(
                  manualCandidate.openingPrice,
                  manualCandidate.latestApiPrice ?? manualCandidate.openingPrice
                )
              : null,
            details: verification.details,
            timestamp: Date.now(),
          },
          state.settings.executionEmailAddress
        );
      } else {
        await updateCloseExecution({
          state: verification.uncertain ? "UNCERTAIN" : "FAILED",
          result: verification.uncertain ? "UNCERTAIN" : "FAILURE",
          details: verification.details,
        });
        await appendAuditEntry(
          makeAuditEntry(
            state,
            "CLOSE_FAILED",
            `${message.symbol} close result uncertain; lot still appears active.`,
            {
              symbol: message.symbol,
              fingerprint: message.fingerprint,
              executionResult: "FAILURE",
              errorDetails: verification.details.join("; "),
            }
          )
        );
        await sendExecutionWebhook(
          state.settings.executionWebhookUrl,
          {
            symbol: message.symbol,
            lotLabel: null,
            result: verification.uncertain ? "UNCERTAIN" : "FAILURE",
            mode: "MANUAL",
            reason: manualCandidate?.reason ?? "Manual admin close",
            entryPrice: manualCandidate?.openingPrice ?? null,
            currentPrice: manualCandidate?.latestApiPrice ?? null,
            currentReturnPct: manualCandidate
              ? computeCurrentReturnPct(
                  manualCandidate.openingPrice,
                  manualCandidate.latestApiPrice ?? manualCandidate.openingPrice
                )
              : null,
            details: verification.details,
            timestamp: Date.now(),
          },
          state.settings.executionEmailAddress
        );
      }
    }
    sendResponse(raw);
  } catch (err) {
    sendResponse({
      type: "CONFIRM_CLOSE_DIALOG_RESULT",
      modalValidation: null,
      clicked: false,
      error: `Could not confirm close on the Kraken tab: ${String(err)}`,
    } satisfies ConfirmCloseDialogResultMessage);
  }
}

async function handleOpenCloseDialog(
  message: Extract<ExtensionMessage, { type: "OPEN_CLOSE_DIALOG" }>,
  sendResponse: (response?: unknown) => void
): Promise<void> {
  const tab = await findKrakenTab();
  if (!tab || tab.id === undefined) {
    const response: OpenCloseDialogResultMessage = {
      type: "OPEN_CLOSE_DIALOG_RESULT",
      report: null,
      error: "No Kraken Prop tab found. Open the Portfolio page and try again.",
    };
    sendResponse(response);
    return;
  }

  try {
    const raw: unknown = await sendMessageToKrakenTab(tab.id, message);
    if (isExtensionMessage(raw) && raw.type === "OPEN_CLOSE_DIALOG_RESULT") {
      const state = await getState();
      if (raw.report) {
        await appendAuditEntry(
          makeAuditEntry(
            state,
            "CLOSE_MODAL_OPENED",
            raw.report.ready
              ? `Clicked validated close control for ${message.symbol} ${message.lotLabel ?? ""}.`.trim()
              : `Close dialog blocked: ${raw.report.blockedReason ?? "unknown reason"}`,
            {
              symbol: message.symbol,
              fingerprint: message.fingerprint,
              executionResult: raw.report.ready ? "SUCCESS" : "BLOCKED",
              errorDetails: raw.report.blockedReason,
            }
          )
        );
      }
      sendResponse(raw);
      return;
    }
    sendResponse({
      type: "OPEN_CLOSE_DIALOG_RESULT",
      report: null,
      error: "Unexpected response from the content script.",
    } satisfies OpenCloseDialogResultMessage);
  } catch (err) {
    sendResponse({
      type: "OPEN_CLOSE_DIALOG_RESULT",
      report: null,
      error: `Could not reach the content script on the Kraken tab: ${String(err)}`,
    } satisfies OpenCloseDialogResultMessage);
  }
}

/** Relays the side panel's manual "Test Buy" OPEN_BUY_ORDER to the Kraken
 * tab's content script — the same buy-preview.ts logic Autopilot's
 * processAutopilotBuys() uses internally, just triggered by one supervised
 * click instead of automatically. Without this relay, chrome.runtime.sendMessage
 * from the panel would hang forever: it reaches the service worker (not
 * the tab directly), and with no case here to forward it, sendResponse is
 * never called. */
async function handleOpenBuyOrder(
  message: Extract<ExtensionMessage, { type: "OPEN_BUY_ORDER" }>,
  sendResponse: (response?: unknown) => void
): Promise<void> {
  const tab = await findKrakenTab();
  if (!tab || tab.id === undefined) {
    sendResponse({
      type: "OPEN_BUY_ORDER_RESULT",
      report: null,
      error: "No Kraken Prop tab found. Open the Trade page for this symbol and try again.",
    } satisfies OpenBuyOrderResultMessage);
    return;
  }

  try {
    const raw: unknown = await sendMessageToKrakenTab(tab.id, message);
    if (isExtensionMessage(raw) && raw.type === "OPEN_BUY_ORDER_RESULT") {
      sendResponse(raw);
      return;
    }
    sendResponse({
      type: "OPEN_BUY_ORDER_RESULT",
      report: null,
      error: "Unexpected response from the content script.",
    } satisfies OpenBuyOrderResultMessage);
  } catch (err) {
    sendResponse({
      type: "OPEN_BUY_ORDER_RESULT",
      report: null,
      error: `Could not reach the content script on the Kraken tab: ${String(err)}`,
    } satisfies OpenBuyOrderResultMessage);
  }
}

async function handleConfirmBuyOrder(
  message: Extract<ExtensionMessage, { type: "CONFIRM_BUY_ORDER" }>,
  sendResponse: (response?: unknown) => void
): Promise<void> {
  const tab = await findKrakenTab();
  if (!tab || tab.id === undefined) {
    sendResponse({
      type: "CONFIRM_BUY_ORDER_RESULT",
      modalValidation: null,
      clicked: false,
      error: "No Kraken Prop tab found. Open the Trade page for this symbol and try again.",
    } satisfies ConfirmBuyOrderResultMessage);
    return;
  }

  try {
    const raw: unknown = await sendMessageToKrakenTab(tab.id, message);
    if (!isExtensionMessage(raw) || raw.type !== "CONFIRM_BUY_ORDER_RESULT") {
      sendResponse({
        type: "CONFIRM_BUY_ORDER_RESULT",
        modalValidation: null,
        clicked: false,
        error: "Unexpected response from the content script.",
      } satisfies ConfirmBuyOrderResultMessage);
      return;
    }

    const state = await getState();
    await appendAuditEntry(
      makeAuditEntry(
        state,
        raw.clicked && raw.modalValidation?.ready ? "AUTO_BUY_SUCCEEDED" : "AUTO_BUY_BLOCKED",
        raw.clicked && raw.modalValidation?.ready
          ? `${message.symbol} manual test buy confirmed (~${message.quantityUnits} units).`
          : `${message.symbol} manual test buy blocked: ${raw.modalValidation?.blockedReason ?? raw.error ?? "unknown"}`,
        {
          symbol: message.symbol,
          executionResult: raw.clicked && raw.modalValidation?.ready ? "SUCCESS" : "BLOCKED",
          errorDetails: raw.modalValidation?.blockedReason ?? raw.error ?? null,
        }
      )
    );
    sendResponse(raw);
  } catch (err) {
    sendResponse({
      type: "CONFIRM_BUY_ORDER_RESULT",
      modalValidation: null,
      clicked: false,
      error: `Could not reach the content script on the Kraken tab: ${String(err)}`,
    } satisfies ConfirmBuyOrderResultMessage);
  }
}

async function handlePreviewClose(
  message: Extract<ExtensionMessage, { type: "PREVIEW_CLOSE" }>,
  sendResponse: (response?: unknown) => void
): Promise<void> {
  const tab = await findKrakenTab();
  if (!tab || tab.id === undefined) {
    const response: PreviewCloseResultMessage = {
      type: "PREVIEW_CLOSE_RESULT",
      report: null,
      error: "No Kraken Prop tab found. Open the Portfolio page and try again.",
    };
    sendResponse(response);
    return;
  }

  try {
    const raw: unknown = await sendMessageToKrakenTab(tab.id, message);
    if (isExtensionMessage(raw) && raw.type === "PREVIEW_CLOSE_RESULT") {
      const state = await getState();
      if (raw.report) {
        await appendAuditEntry(
          makeAuditEntry(
            state,
            "PREVIEW_READY",
            raw.report.ready
              ? `Preview highlighted ${message.symbol} ${message.lotLabel ?? ""}.`.trim()
              : `Preview blocked: ${raw.report.blockedReason ?? "unknown reason"}`,
            {
              symbol: message.symbol,
              fingerprint: message.fingerprint,
              executionResult: raw.report.ready ? "SUCCESS" : "BLOCKED",
              errorDetails: raw.report.blockedReason,
            }
          )
        );
      }
      sendResponse(raw);
      return;
    }
    sendResponse({
      type: "PREVIEW_CLOSE_RESULT",
      report: null,
      error: "Unexpected response from the content script.",
    } satisfies PreviewCloseResultMessage);
  } catch (err) {
    sendResponse({
      type: "PREVIEW_CLOSE_RESULT",
      report: null,
      error: `Could not reach the content script on the Kraken tab: ${String(err)}`,
    } satisfies PreviewCloseResultMessage);
  }
}

async function handleRunDomDiagnostics(sendResponse: (response?: unknown) => void): Promise<void> {
  const tab = await findKrakenTab();
  if (!tab || tab.id === undefined) {
    const response: DomDiagnosticsResultMessage = {
      type: "DOM_DIAGNOSTICS_RESULT",
      report: null,
      error: "No Kraken Prop tab found. Open the Portfolio page and try again.",
    };
    sendResponse(response);
    return;
  }

  try {
    const raw: unknown = await sendMessageToKrakenTab(tab.id, { type: "RUN_DOM_DIAGNOSTICS" });
    if (isExtensionMessage(raw) && raw.type === "DOM_DIAGNOSTICS_RESULT") {
      console.log(
        "[kraken-guard] DOM diagnostics report received from content script:",
        raw.report
      );
      // A response at all is proof of connectivity, even before the
      // content script's separate scanAndReport() message arrives.
      await updateState((s) => ({
        ...s,
        krakenTabId: tab.id ?? s.krakenTabId,
        lastContentScriptResponseAt: Date.now(),
      }));
      sendResponse(raw);
    } else {
      const response: DomDiagnosticsResultMessage = {
        type: "DOM_DIAGNOSTICS_RESULT",
        report: null,
        error: "Unexpected response from the content script.",
      };
      sendResponse(response);
    }
  } catch (err) {
    const response: DomDiagnosticsResultMessage = {
      type: "DOM_DIAGNOSTICS_RESULT",
      report: null,
      error: `Could not reach the content script on the Kraken tab: ${String(err)}`,
    };
    sendResponse(response);
  }
}

async function handleRunOrderFormDiagnostics(sendResponse: (response?: unknown) => void): Promise<void> {
  const tab = await findKrakenTab();
  if (!tab || tab.id === undefined) {
    const response: OrderFormDiagnosticsResultMessage = {
      type: "ORDER_FORM_DIAGNOSTICS_RESULT",
      report: null,
      error: "No Kraken Prop tab found. Open the Portfolio page and try again.",
    };
    sendResponse(response);
    return;
  }

  try {
    const raw: unknown = await sendMessageToKrakenTab(tab.id, { type: "RUN_ORDER_FORM_DIAGNOSTICS" });
    if (isExtensionMessage(raw) && raw.type === "ORDER_FORM_DIAGNOSTICS_RESULT") {
      console.log(
        "[kraken-guard] Order-form diagnostics report received from content script:",
        raw.report
      );
      await updateState((s) => ({
        ...s,
        krakenTabId: tab.id ?? s.krakenTabId,
        lastContentScriptResponseAt: Date.now(),
      }));
      sendResponse(raw);
    } else {
      const response: OrderFormDiagnosticsResultMessage = {
        type: "ORDER_FORM_DIAGNOSTICS_RESULT",
        report: null,
        error: "Unexpected response from the content script.",
      };
      sendResponse(response);
    }
  } catch (err) {
    const response: OrderFormDiagnosticsResultMessage = {
      type: "ORDER_FORM_DIAGNOSTICS_RESULT",
      report: null,
      error: `Could not reach the content script on the Kraken tab: ${String(err)}`,
    };
    sendResponse(response);
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isExtensionMessage(message)) return undefined;
  void handleMessage(message, sendResponse, sender.tab?.id);
  return true; // keep the message channel open for the async sendResponse above
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME_POLL) {
    void runScanCycle();
  }
  if (alarm.name === ALARM_NAME_MARKET_REFRESH) {
    void refreshMarketData({ automatic: true });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void resetToSafeDefaultsOnRestart();
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  void resetToSafeDefaultsOnRestart();
});
