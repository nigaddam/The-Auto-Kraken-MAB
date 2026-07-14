export type Side = "LONG" | "SHORT";

export type MonitoringStatus = "STOPPED" | "RUNNING";

/** Meaningful only while monitoringStatus is RUNNING. PREVIEW remains
 * reserved; ARMED_AUTO_CLOSE is used for dry-run and live auto-close, with
 * autoCloseLive distinguishing final execution from logging-only mode. */
export type ExecutionMode = "MONITOR_ONLY" | "PREVIEW" | "ARMED_AUTO_CLOSE";

/** The user-facing simplification layer on top of ExecutionMode/autoCloseLive.
 * OFF = monitoring stopped. CRUISE = monitoring running, watches existing
 * positions and the watchlist, notifies on signal changes, never clicks
 * anything. AUTOPILOT = monitoring running, LIVE auto-close armed
 * (self-renewing, no manual re-arm ceremony) — the sell side is fully
 * automatic today; the buy side is display-only until real DOM evidence for
 * Kraken's Buy form exists (see OrderFormDiagnosticsReport). */
export type OperatingMode = "OFF" | "CRUISE" | "AUTOPILOT";

export type Decision = "HOLD" | "PROTECT" | "WATCH" | "CLOSE" | "BLOCKED" | "ERROR" | "CLOSED";

/** A 5-tier signal classification shared by watchlist coins (no open
 * position) and existing tracked positions (derived from their exit
 * Decision) — see strategy/signal-engine.ts. */
export type SignalTier = "STRONG_BUY" | "BUY" | "HOLD" | "SELL" | "STRONG_SELL";

export type TrendStrength = "STRONG" | "WEAK" | "UNKNOWN";

export interface Candle {
  /** epoch ms, start of the hour this candle covers */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SMAPoint {
  ts: number;
  close: number;
  smaFast: number | null;
  smaSlow: number | null;
}

export type StrategyRegime = "EXPANSION" | "HEALTHY" | "DETERIORATING" | "BROKEN" | "UNKNOWN";

export type StrategyReasonCode =
  | "STRATEGY_DATA_INVALID"
  | "HARD_LOSS"
  | "MAJOR_TREND_BREAK"
  | "PROFIT_LOCK_CONFIRMED"
  | "PROFIT_LOCK_AND_WEAK_TREND"
  | "EXPANSION_TREND_BREAK"
  | "EXPANSION_FAST_BREAK"
  | "HEALTHY_TREND_BREAK"
  | "DETERIORATING_TREND"
  | "BROKEN_TREND"
  | "PROFIT_PROTECTION_ACTIVE"
  | "WATCHING_CONFIRMATION"
  | "NO_EXIT_RULE";

export interface StrategyDiagnostics {
  decision: Decision;
  reasonCode: StrategyReasonCode;
  reason: string;
  currentReturnPct: number | null;
  peakReturnPct: number;
  peakPrice?: number;
  profitProtectionActive: boolean;
  profitFloorPct: number | null;
  effectiveHardLossPct: number | null;
  sma7: number | null;
  sma30: number | null;
  sma90: number | null;
  atr14: number | null;
  atrPct: number | null;
  slope7: number | null;
  slope30: number | null;
  slope90: number | null;
  regime: StrategyRegime;
  completedClosesBelowSma7: number;
  majorTrendBreakLevel: number | null;
  btcStressActive: boolean;
  dataTimestamp: number;
  candleTimestamp: number | null;
  positionFingerprint: string;
  executionEligible: boolean;
  failedSafetyGates: string[];
  nextCloseCondition: string;
}

/** What the content script extracts from a single Kraken Prop position row.
 * Structured-clone-safe: no DOM references. */
export interface ParsedPositionData {
  symbol: string;
  side: Side;
  entryPrice: number;
  currentPriceUi: number;
  valueUsd: number;
  upnl: number;
  netPnl: number;
  leverage: number | null;
  tpSlText: string | null;
}

/** Never collapse UNKNOWN into LOGGED_OUT: LOGGED_OUT requires positive
 * negative evidence (a login form, session-expired modal, CAPTCHA, 2FA,
 * device approval, etc.); the mere absence of positive positive-evidence
 * (e.g. an account marker we haven't calibrated selectors for yet) is
 * UNKNOWN, not LOGGED_OUT. Zero parsed positions never implies logged out
 * either — that's a parser-calibration signal, handled separately. */
export type SessionState = "LOGGED_IN" | "LOGGED_OUT" | "UNKNOWN";

export interface PageHealthStatus {
  checkedAt: number;
  propPageDetected: boolean;
  accountMarkerDetected: boolean;
  sessionState: SessionState;
  positionsTableReadable: boolean;
  loginFormDetected: boolean;
  sessionExpiredModalDetected: boolean;
  captchaDetected: boolean;
  twoFaDetected: boolean;
  deviceApprovalDetected: boolean;
}

export type PositionLifecycleStatus = "ACTIVE" | "CLOSED" | "CHANGED";

/** Persisted, monitoring-derived state for one continuous position. Keyed
 * by fingerprint in RuntimeState.positions. */
export interface TrackedPosition {
  fingerprint: string;
  symbol: string;
  side: "LONG";
  openingPrice: number;
  openingValueUsd: number;
  firstObservedAt: number;
  lastSeenAt: number;
  status: PositionLifecycleStatus;

  latest: ParsedPositionData | null;
  latestApiPrice: number | null;
  latestApiPriceAt: number | null;

  highestObservedPrice: number;
  peakReturnPct: number;
  peakPrice?: number;
  /** Only ever moves up while status is ACTIVE. null = profit lock not yet active. */
  profitFloorPct: number | null;

  smaFast: number | null;
  smaSlow: number | null;
  trend: TrendStrength;
  regime?: StrategyRegime;
  consecutiveClosesBelowSmaFast: number;
  lastProcessedCandleTs: number | null;
  hardLossObservedSince?: number | null;
  hardLossObservationCount?: number;
  strategyDiagnostics?: StrategyDiagnostics | null;

  decision: Decision;
  reason: string;

  autoCloseDisabledReason: string | null;
}

export type KeepAwakeStatus = "INACTIVE" | "ACTIVE" | "ERROR";

export interface Settings {
  pollMinutes: number;
  marketRefreshMinutes: number;
  candleIntervalMinutes: number;
  fastSma: number;
  slowSma: number;
  longSma: number;
  atrPeriod: number;
  slope7LookbackHours: number;
  slope30LookbackHours: number;
  slope90LookbackHours: number;
  hardLossPercent: number;
  hardLossFallbackPct: number;
  hardLossMinDistancePct: number;
  hardLossMaxDistancePct: number;
  hardLossAtrMultiple: number;
  hardLossConfirmationSeconds: number;
  hardLossRequiredObservations: number;
  profitLockActivationPercent: number;
  profitActivationPct: number;
  profitActivationAtrMultiple: number;
  majorTrendBreakAtrBuffer: number;
  expansionFloorAtrBuffer: number;
  deteriorationAtrBreakBuffer: number;
  expansionFastBreakAtrBuffer: number;
  slope7StrongPositive: number;
  slope7Positive: number;
  slope7Negative: number;
  slope30StrongPositive: number;
  slope30FlatLowerBound: number;
  btcStressEnabled: boolean;
  apiUiPriceTolerancePercent: number;
  strongTrendConfirmationCloses: number;
  weakTrendConfirmationCloses: number;
  autoCloseDurationHours: number;
  maxLiveClosesPerHour: number;
  maxLiveClosesPerArmedSession: number;
  autoCloseSignalExpiryMinutes: number;
  closeVerificationTimeoutSeconds: number;
  sleepGapWarningMinutes: number;
  requireRearmAfterGapMinutes: number;
  executionMode: ExecutionMode;
  alarmSoundEnabled: boolean;
  /** When true, clicking Start Monitoring also arms LIVE Auto-Close (after
   * the same preflight + confirmation LIVE arming always requires) instead
   * of requiring a separate Arm LIVE Auto-Close click. Default off — the
   * two-step flow (Start Monitoring, then separately arm) always remains
   * available regardless of this setting. */
  startMonitoringWithLiveAutoClose: boolean;
  /** Empty = disabled. A URL POSTed to only when a close execution reaches
   * a terminal outcome (SUCCESS/FAILURE/UNCERTAIN) — manual or LIVE
   * auto-close. Never fires for monitoring start/stop, strategy signals,
   * arming, or stall/health events. https://ntfy.sh/<your-topic> works
   * out of the box with no signup (install the ntfy app, subscribe to
   * that topic); any other URL requires a one-time permission grant when
   * saved. */
  executionWebhookUrl: string;
  /** Empty = disabled. When set (and executionWebhookUrl is a valid
   * ntfy.sh URL), ntfy.sh also relays the same execution-only
   * notification to this address via its built-in free email add-on
   * (an X-Email header on the same request) — no separate API key or
   * email service required. Subject to ntfy.sh's own free-tier email
   * rate limit. */
  executionEmailAddress: string;
  /** Up to MAX_WATCHLIST_COINS uppercase symbols the user wants tracked for
   * BUY signals only — entirely separate from open positions. Kraken is
   * never auto-bought; this only sends a notification so the user can
   * place a manual order themselves. */
  watchlistCoins: string[];
  /** Soft cap, as a percent of total account equity, used only to size a
   * *new* buy suggestion (strategy/position-sizing.ts). Never force-trims an
   * existing holding that has organically grown past this — it only stops
   * suggesting further buys into that symbol. */
  positionSizeCapPct: number;
  /** Purely a progress display (strategy/daily-goal.ts) — informational
   * only, confirmed with the user. Nothing reacts to hitting or missing it. */
  dailyGoalPct: number;
}

export type AuditEventType =
  | "MONITORING_STARTED"
  | "MONITORING_STOPPED"
  | "AUTO_CLOSE_ARMED"
  | "AUTO_CLOSE_EXPIRED"
  | "AUTO_CLOSE_DISARMED"
  | "AUTO_CLOSE_DRY_RUN_INTENT"
  | "AUTO_CLOSE_EXECUTION_STARTED"
  | "AUTO_CLOSE_SUCCEEDED"
  | "AUTO_CLOSE_BLOCKED"
  | "AUTO_CLOSE_UNCERTAIN"
  | "SELL_CONDITION_TRIGGERED"
  | "PREVIEW_READY"
  | "CLOSE_MODAL_OPENED"
  | "POSITION_CLOSED"
  | "MANUAL_POSITION_CLOSE_SUCCEEDED"
  | "CLOSE_FAILED"
  | "LOGIN_REQUIRED"
  | "KRAKEN_TAB_MISSING"
  | "STALE_MARKET_DATA"
  | "UNSUPPORTED_SYMBOL"
  | "POSITION_CHANGED"
  | "POSITION_SCAN_COMPLETED"
  | "DUPLICATE_OR_AMBIGUOUS_ROW"
  | "API_UI_PRICE_MISMATCH"
  | "SLEEP_INTERRUPTION_DETECTED"
  | "MARKET_REFRESH_FAILED"
  | "MONITOR_STALLED"
  | "MONITOR_RECOVERED"
  | "EXECUTION_INTERRUPTED_BY_RESTART"
  | "TEST_NOTIFICATION"
  | "BUY_SIGNAL_DETECTED"
  | "SIGNAL_TIER_CHANGED"
  | "AUTO_BUY_SUCCEEDED"
  | "AUTO_BUY_BLOCKED"
  | "AUTO_BUY_UNCERTAIN";

export interface LiveAutoClosePreflightResult {
  allowed: boolean;
  blockers: string[];
  checkedAt: number;
}

export type CloseExecutionState =
  | "CREATED"
  | "DIALOG_OPENING"
  | "MODAL_VALIDATED"
  | "FINAL_SUBMITTING"
  | "VERIFYING"
  | "SUCCEEDED"
  | "FAILED"
  | "BLOCKED"
  | "UNCERTAIN";

export interface CloseExecutionRecord {
  intentId: string;
  fingerprint: string;
  symbol: string;
  lotLabel: string | null;
  trigger: string;
  startedAt: number;
  updatedAt: number;
  state: CloseExecutionState;
  result: "SUCCESS" | "FAILURE" | "BLOCKED" | "UNCERTAIN" | null;
  details: string[];
}

export interface LiveAutoCloseStats {
  armedSessionStartedAt: number | null;
  closesThisSession: number;
  closeTimestamps: number[];
  unresolvedSleepGap: boolean;
  previousExecutionUncertain: boolean;
  /** Set when a previously ACTIVE position vanishes from parsing entirely
   * (candidateRowCount drops to 0 while one was expected) while LIVE
   * Auto-Close was armed. Deliberately sticky like unresolvedSleepGap —
   * only a fresh explicit arm (resetStats: true) clears it — so Autopilot
   * cannot silently self-heal back into a "zero positions" cold-start arm
   * immediately after a real position disappears ambiguously (which could
   * otherwise let it buy a duplicate position while the original sits
   * unprotected and untracked). Requires the user to verify Kraken
   * manually before Autopilot resumes. */
  parserGapUnresolved: boolean;
}

export interface AuditLogEntry {
  timestamp: number;
  eventType: AuditEventType;
  symbol: string | null;
  fingerprint: string | null;
  mode: ExecutionMode | "STOPPED";
  entryPrice: number | null;
  currentPrice: number | null;
  currentReturnPct: number | null;
  peakReturnPct: number | null;
  profitFloorPct: number | null;
  smaFast: number | null;
  smaSlow: number | null;
  closeCounter: number | null;
  decision: Decision | null;
  reason: string;
  executionResult: "SUCCESS" | "FAILURE" | "BLOCKED" | null;
  errorDetails: string | null;
  /** Realized P/L in USD, populated only at a close-success call site from
   * TrackedPosition.latest.netPnl at the moment of closing. Null for every
   * other event type — used solely for the daily-goal display's realized
   * half (strategy/daily-goal.ts), never for execution logic. */
  realizedPnlUsd: number | null;
}

export interface RuntimeState {
  schemaVersion: number;
  monitoringStatus: MonitoringStatus;
  executionMode: ExecutionMode;
  armedUntil: number | null;
  autoCloseLive: boolean;
  monitoringStartedAt: number | null;
  settings: Settings;
  positions: Record<string, TrackedPosition>;
  lastPositionScanAt: number | null;
  lastPriceUpdateAt: number | null;
  nextMarketRefreshAt: number | null;
  lastCompletedCandleTsBySymbol: Record<string, number>;
  lastHeartbeatAt: number | null;
  lastNotificationTestAt: number | null;
  missedScheduledChecks: number;
  keepAwakeStatus: KeepAwakeStatus;
  keepAwakeError: string | null;
  pageHealth: PageHealthStatus | null;
  krakenTabId: number | null;
  /** Set on *any* successful content-script response — a regular scan or a
   * diagnostics run — independent of monitoringStatus. This is what
   * "Kraken tab: connected" actually reflects; it must not require
   * monitoring to be running. */
  lastContentScriptResponseAt: number | null;
  lastCandidateRowCount: number | null;
  lastRowDiscoveryMethod: RowDiscoveryMethod | null;
  marketData: Record<string, MarketDataRow>;
  autoCloseDryRunIntents: Record<string, number>;
  livePreflight: LiveAutoClosePreflightResult | null;
  closeExecution: CloseExecutionRecord | null;
  liveAutoCloseStats: LiveAutoCloseStats;
  /** Watchdog: counts consecutive scan attempts that did not produce a
   * successful POSITIONS_SCAN_RESULT (tab missing or content script
   * unreachable). Reset to 0 on the next successful scan. Distinct from
   * lastHeartbeatAt, which updates on every alarm tick regardless of scan
   * success and therefore cannot by itself detect "alarm keeps firing but
   * scans keep failing." */
  consecutiveScanFailures: number;
  /** Set the moment monitoring is judged STALLED (no successful scan for
   * longer than max(3 * pollMinutes, 15 minutes)); cleared on the next
   * successful scan. Non-null is what drives the side panel's red
   * STALLED banner and gates the one-time stall notification/disarm so
   * they don't repeat every cycle while still stalled. */
  monitorStalledSince: number | null;
  /** Fingerprints this extension itself just closed (LIVE Auto-Close or a
   * manual close confirmed through its own dialog), each mapped to the
   * timestamp of that success. Consulted the next time reconcilePositions
   * notices the same fingerprint vanish, so that expected disappearance
   * isn't double-reported as an "externally closed" notification. Pruned
   * of entries older than 1 hour on every scan. */
  recentlyClosedByExtension: Record<string, number>;
  /** Per-watchlist-symbol golden-cross progress, keyed by symbol. Persisted
   * so the "consecutive closes above SMA7" counter and the
   * already-fired-this-episode flag survive service-worker restarts. */
  watchlistSignals: Record<string, BuySignalState>;
  /** User-facing simplified mode; drives executionMode/autoCloseLive/armedUntil
   * underneath without changing their shape. See OperatingMode's doc comment. */
  operatingMode: OperatingMode;
  /** Read from the Kraken page's own account-equity display on every regular
   * scan (content/order-form-diagnostics.ts's readAccountEquitySnapshot).
   * Null until a scan successfully parses it. Used only for position-sizing
   * and daily-goal display math — never for execution/safety gating. */
  accountEquityUsd: number | null;
  accountEquityUpdatedAt: number | null;
  /** Unified 5-tier signal per symbol — watchlist coins (from
   * evaluateWatchlistBuySignals) and symbols with an ACTIVE tracked position
   * (from evaluatePositions, derived from that position's exit Decision)
   * both write into this same record, never both for the same symbol in the
   * same cycle. */
  signalStates: Record<string, SignalStateEntry>;
  /** One-shot notify gate (same pattern as monitorStalledSince): set the
   * first cycle Autopilot fails to (re-)arm LIVE, cleared the moment it
   * succeeds, so the "waiting to arm" notification doesn't repeat every
   * cycle while still blocked. */
  autopilotReArmFailedSince: number | null;
  /** Per-symbol timestamp of the last Autopilot buy *attempt* (any outcome,
   * not just success) — a cooldown floor so the same symbol can't be
   * re-attempted every cycle while position reconciliation catches up
   * (once a buy succeeds and the position is detected, the symbol stops
   * being a watchlist candidate at all — this is purely a safety net for
   * the detection-lag window immediately after). */
  autoBuyIntents: Record<string, number>;
}

/** One symbol's current position in the 5-tier signal scale. */
export interface SignalStateEntry {
  tier: SignalTier;
  reason: string;
  updatedAt: number;
}

/** Tracks golden-cross (SMA7 crosses above SMA30) progress for one
 * watchlist symbol — entirely separate from TrackedPosition, since a
 * watchlist coin has no open position. Mirrors TrackedPosition's
 * consecutiveClosesBelowSmaFast/lastProcessedCandleTs pattern, inverted. */
export interface BuySignalState {
  consecutiveClosesAboveSmaFast: number;
  lastProcessedCandleTs: number | null;
  /** True once a golden-cross buy signal has already been confirmed and
   * notified for the current STRONG-trend episode — prevents re-firing
   * every cycle while the trend stays STRONG. Reset the moment the trend
   * drops out of STRONG, so the next genuine crossover can fire again. */
  signalFiredForThisEpisode: boolean;
}

/** One row per unique symbol (not per lot) for the read-only Market Data
 * table. `source` distinguishes a symbol backing a real detected position
 * from a developer-only watchlist entry (XPL/JTO) added purely so the table
 * can be exercised before row discovery finds real positions. */
export interface MarketDataRow {
  symbol: string;
  apiMarket: string;
  source: "DETECTED_POSITION" | "WATCHLIST";
  currentApiPrice: number | null;
  lastCompletedClose: number | null;
  smaFast: number | null;
  smaSlow: number | null;
  trend: TrendStrength;
  vsSmaFastPct: number | null;
  vsSmaSlowPct: number | null;
  latestCandleTs: number | null;
  completedCandleCount: number;
  formingCandleExcluded: boolean;
  lastUpdatedAt: number | null;
  apiStatus: "OK" | "STALE" | "ERROR";
  errorMessage: string | null;
  /** Soft-cap sizing suggestion (strategy/position-sizing.ts) — display-only
   * in this pass, nothing places an order from these fields yet. Null
   * whenever account equity is unavailable or the symbol is already at or
   * above the cap. */
  suggestedBuyUsd: number | null;
  suggestedBuyUnits: number | null;
  atOrAboveSizeCap: boolean;
}

/** Read-only DOM diagnostics report shape. Populated in content/diagnostics.ts;
 * declared here (not there) so shared/messages.ts can reference it without
 * shared/ depending on content/ — content/ depends on shared/, not the
 * other way around. */
export interface ControlInfo {
  tag: string;
  role: string | null;
  ariaLabel: string | null;
  title: string | null;
  visibleText: string;
  dataTestId: string | null;
}

export interface CloseControlInfo {
  ariaLabelPresent: boolean;
  titlePresent: boolean;
  accessibleNameAvailableWithoutHover: boolean;
  accessibleName: string | null;
  dataTestId: string | null;
  roleIsButton: boolean;
  candidateCount: number;
  confidence: "HIGH" | "LOW";
  ambiguityReason: string | null;
  note: string;
}

export interface PreviewCloseReport {
  fingerprint: string;
  symbol: string;
  lotLabel: string | null;
  ready: boolean;
  blockedReason: string | null;
  rowEvidence: string[];
  closeControl: CloseControlInfo | null;
  highlightedUntil: number | null;
  modalValidation?: CloseModalValidation | null;
}

export interface CloseModalValidation {
  modalFound: boolean;
  titleMatched: boolean;
  symbolMatched: boolean;
  sideMatched: boolean;
  closeActionMatched: boolean;
  quantityMatched: boolean;
  finalButtonMatched: boolean;
  conflictingActionFound: boolean;
  confidence: "HIGH" | "LOW";
  ready: boolean;
  blockedReason: string | null;
  modalTextExcerpt: string;
  symbolEvidence: string | null;
  actionEvidence: string | null;
  quantityEvidence: string | null;
  finalControlText: string | null;
}

/** Validation of Kraken's post-submit BUY confirmation modal ("Market long
 * 0.001 BTC ... Cancel | Confirm"), mirroring CloseModalValidation's
 * evidence-based shape. Confirmed against a real modal on 2026-07-12 —
 * unlike the close modal, the final button's own text is just "Confirm"
 * (not symbol-specific), so finalButtonMatched relies on exact-text
 * matching scoped to this one already-symbol/quantity-matched modal. */
export interface BuyModalValidation {
  modalFound: boolean;
  symbolMatched: boolean;
  actionMatched: boolean;
  quantityMatched: boolean;
  finalButtonMatched: boolean;
  conflictingActionFound: boolean;
  confidence: "HIGH" | "LOW";
  ready: boolean;
  blockedReason: string | null;
  modalTextExcerpt: string;
  quantityEvidence: string | null;
  finalControlText: string | null;
}

/** Result of attempting to fill and open (or confirm) a real Kraken BUY
 * order. `quantitySet` is the exact quantity this extension wrote into the
 * input (re-read back from the DOM after setting it, never assumed). */
export interface BuyOrderReport {
  symbol: string;
  ready: boolean;
  blockedReason: string | null;
  quantitySet: number | null;
  modalValidation?: BuyModalValidation | null;
}

export interface RowDiagnostics {
  index: number;
  rawVisibleText: string;
  parsedSymbol: string;
  parsedSide: "LONG" | "SHORT" | "UNKNOWN";
  parsedValue: number | "UNKNOWN";
  parsedOpeningPrice: number | "UNKNOWN";
  parsedCurrentPrice: number | "UNKNOWN";
  parsedUpnl: number | "UNKNOWN";
  parsedNetPnl: number | "UNKNOWN";
  leverage: number | "UNKNOWN";
  hasCloseControl: boolean;
  closeControlInfo: CloseControlInfo | null;
  controls: ControlInfo[];
  groupingEvidence: string[];
}

export interface PositionGroupDiagnostics {
  groupId: number;
  symbol: string;
  summaryRowIndex: number | null;
  actionableChildRowIndexes: number[];
  ambiguous: boolean;
  ambiguityReason: string | null;
  /** Why the summary/actionable rows were linked (or why they weren't) —
   * e.g. "parent/child containment" vs. "weak evidence: adjacency + symbol
   * match only". */
  evidence: string[];
}

export type RowDiscoveryMethod = "SEMANTIC_ROLES" | "TEXT_ANCHOR_FALLBACK" | "NONE";

export interface AncestorChainEntry {
  depthFromAnchor: number;
  tag: string;
  role: string | null;
  directChildCount: number;
  classCount: number;
  dataAttributeNames: string[];
  buttonCount: number;
  containsExactSymbol: boolean;
  containsExactSide: boolean;
  distinctNumericFieldCount: number;
}

export interface TextAnchorReport {
  anchorText: string;
  ancestorChain: AncestorChainEntry[];
}

export interface StructuralCensus {
  totalDivCount: number;
  roledElementCount: number;
  roleValueCounts: Record<string, number>;
  keywordElementCounts: Record<string, number>;
  distinctDataAttributeNames: string[];
  multiNumericFieldElementCount: number;
  longShortTextAnchors: TextAnchorReport[];
  symbolTextAnchors: TextAnchorReport[];
}

export interface DiagnosticsReport {
  generatedAt: number;
  url: string;
  currentPageDetected: boolean;
  krakenDomainDetected: boolean;
  propUrlDetected: boolean;
  portfolioPageDetected: boolean;
  loggedInState: "YES" | "NO" | "UNKNOWN";
  positionsSectionDetected: boolean;
  candidateRowCount: number;
  parsedPositionCount: number;
  rowDiscoveryMethod: RowDiscoveryMethod;
  rows: RowDiagnostics[];
  groups: PositionGroupDiagnostics[];
  structuralCensus: StructuralCensus;
}

/** Read-only calibration report for Kraken's Buy/Open order form and the
 * account-equity display — neither has ever been inspected by this
 * extension before. Never clicks, fills, or hovers; purely reports what
 * exists so real selectors can be chosen deliberately (same rule as
 * DiagnosticsReport). This is the hard prerequisite for any future
 * order-placement automation — see HANDOFF.md's autonomous-buy addendum. */
export interface OrderFormControlInfo {
  found: boolean;
  ambiguous: boolean;
  candidateCount: number;
  ariaLabelPresent: boolean;
  titlePresent: boolean;
  dataTestId: string | null;
  accessibleName: string | null;
  roleIsButton: boolean;
}

export interface OrderFormDiagnosticsReport {
  generatedAt: number;
  url: string;
  orderEntryPanelDetected: boolean;
  buyTabControl: OrderFormControlInfo | null;
  buyTabSelected: boolean | "UNKNOWN";
  sellTabControl: OrderFormControlInfo | null;
  sellTabSelected: boolean | "UNKNOWN";
  quantityInputDetected: boolean;
  quantityInputCurrentValue: string | null;
  quantityInputStep: string | null;
  leverageValueText: string | null;
  orderTypeIsMarket: boolean | "UNKNOWN";
  orderTypeIsLimit: boolean | "UNKNOWN";
  submitControl: OrderFormControlInfo | null;
  accountEquityLabelFound: boolean;
  accountEquityText: string | null;
  accountEquityParsed: number | null;
  rawPanelTextExcerpt: string | null;
}
