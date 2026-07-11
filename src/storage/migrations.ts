import { DEFAULT_SETTINGS, STORAGE_SCHEMA_VERSION } from "../shared/constants";
import type { RuntimeState } from "../shared/types";

export function freshRuntimeState(): RuntimeState {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    monitoringStatus: "STOPPED",
    executionMode: "MONITOR_ONLY",
    armedUntil: null,
    autoCloseLive: false,
    monitoringStartedAt: null,
    settings: { ...DEFAULT_SETTINGS },
    positions: {},
    lastPositionScanAt: null,
    lastPriceUpdateAt: null,
    nextMarketRefreshAt: null,
    lastCompletedCandleTsBySymbol: {},
    lastHeartbeatAt: null,
    lastNotificationTestAt: null,
    missedScheduledChecks: 0,
    keepAwakeStatus: "INACTIVE",
    keepAwakeError: null,
    pageHealth: null,
    krakenTabId: null,
    lastContentScriptResponseAt: null,
    lastCandidateRowCount: null,
    lastRowDiscoveryMethod: null,
    marketData: {},
    autoCloseDryRunIntents: {},
    livePreflight: null,
    closeExecution: null,
    liveAutoCloseStats: {
      armedSessionStartedAt: null,
      closesThisSession: 0,
      closeTimestamps: [],
      unresolvedSleepGap: false,
      previousExecutionUncertain: false,
    },
    consecutiveScanFailures: 0,
    monitorStalledSince: null,
    recentlyClosedByExtension: {},
    watchlistSignals: {},
  };
}

/** No real migrations exist yet (schema v1 is the only version). This is
 * the seam for future ones: bump STORAGE_SCHEMA_VERSION and add a branch
 * here rather than changing freshRuntimeState's shape in place. */
export function migrateState(raw: unknown): RuntimeState {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("schemaVersion" in raw) ||
    (raw as { schemaVersion?: unknown }).schemaVersion !== STORAGE_SCHEMA_VERSION
  ) {
    return freshRuntimeState();
  }
  const state = raw as RuntimeState;
  return {
    ...state,
    settings: { ...DEFAULT_SETTINGS, ...state.settings },
    nextMarketRefreshAt: state.nextMarketRefreshAt ?? null,
    autoCloseLive: state.autoCloseLive ?? false,
    keepAwakeStatus: state.keepAwakeStatus ?? "INACTIVE",
    keepAwakeError: state.keepAwakeError ?? null,
    autoCloseDryRunIntents: state.autoCloseDryRunIntents ?? {},
    livePreflight: state.livePreflight ?? null,
    closeExecution: state.closeExecution ?? null,
    liveAutoCloseStats: state.liveAutoCloseStats ?? {
      armedSessionStartedAt: null,
      closesThisSession: 0,
      closeTimestamps: [],
      unresolvedSleepGap: false,
      previousExecutionUncertain: false,
    },
    consecutiveScanFailures: state.consecutiveScanFailures ?? 0,
    monitorStalledSince: state.monitorStalledSince ?? null,
    recentlyClosedByExtension: state.recentlyClosedByExtension ?? {},
    watchlistSignals: state.watchlistSignals ?? {},
  };
}
