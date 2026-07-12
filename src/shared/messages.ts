import type {
  BuyModalValidation,
  BuyOrderReport,
  DiagnosticsReport,
  ExecutionMode,
  CloseModalValidation,
  LiveAutoClosePreflightResult,
  OperatingMode,
  OrderFormDiagnosticsReport,
  PageHealthStatus,
  ParsedPositionData,
  PreviewCloseReport,
  RowDiscoveryMethod,
  RuntimeState,
  Settings,
} from "./types";

/** Content script -> service worker: result of scanning the Kraken Prop page.
 * A successful arrival of this message is itself proof the content script
 * is alive and reachable — the service worker uses that fact to mark the
 * Kraken tab "connected," independent of whether any position parsed. */
export interface ScanResultMessage {
  type: "POSITIONS_SCAN_RESULT";
  positions: ParsedPositionData[];
  pageHealth: PageHealthStatus;
  candidateRowCount: number;
  rowDiscoveryMethod: RowDiscoveryMethod;
  /** Parsed from the Kraken page's own account-equity display on every
   * regular scan (a narrow, always-on text read — not the click-risk
   * category the Order-Form Diagnostics gate is about). Null until parsed
   * successfully at least once. */
  accountEquityUsd: number | null;
}

/** Service worker -> content script: please scan now. */
export interface RequestScanMessage {
  type: "REQUEST_SCAN";
}

/** Side panel -> service worker. */
export interface GetStateMessage {
  type: "GET_STATE";
}

/** Service worker -> side panel: full state snapshot (broadcast + response). */
export interface StateSnapshotMessage {
  type: "STATE_SNAPSHOT";
  state: RuntimeState;
}

export interface StartMonitoringMessage {
  type: "START_MONITORING";
}

export interface StopMonitoringMessage {
  type: "STOP_MONITORING";
}

export interface ArmAutoCloseMessage {
  type: "ARM_AUTO_CLOSE";
  durationHours: number;
  live: boolean;
}

/** The simplified Off/Cruise/Autopilot control the side panel now exposes
 * instead of the separate Start/Stop/Arm-Dry-Run/Arm-LIVE/Disarm buttons.
 * Drives executionMode/autoCloseLive/armedUntil underneath without
 * changing their shape — see OperatingMode's doc comment in shared/types.ts. */
export interface SetOperatingModeMessage {
  type: "SET_OPERATING_MODE";
  mode: OperatingMode;
}

/** One-click combined flow, gated behind Settings.startMonitoringWithLiveAutoClose.
 * Starts monitoring, then — only once a fresh scan exists — runs the same
 * LIVE preflight ARM_AUTO_CLOSE would require. If preflight fails,
 * monitoring stays running but LIVE is not armed; the panel shows why. */
export interface StartMonitoringWithLiveAutoCloseMessage {
  type: "START_MONITORING_WITH_LIVE_AUTO_CLOSE";
  durationHours: number;
}

export interface StartMonitoringWithLiveAutoCloseResultMessage {
  type: "START_MONITORING_WITH_LIVE_AUTO_CLOSE_RESULT";
  monitoringStarted: boolean;
  liveArmed: boolean;
  preflightBlockers: string[];
}

export interface RunLivePreflightMessage {
  type: "RUN_LIVE_PREFLIGHT";
}

export interface RunLivePreflightResultMessage {
  type: "RUN_LIVE_PREFLIGHT_RESULT";
  result: LiveAutoClosePreflightResult;
}

export interface DisarmAutoCloseMessage {
  type: "DISARM_AUTO_CLOSE";
}

export interface RefreshPositionsMessage {
  type: "REFRESH_POSITIONS";
}

export interface RefreshMarketDataMessage {
  type: "REFRESH_MARKET_DATA";
  symbol?: string;
}

export interface RefreshMarketDataResultMessage {
  type: "REFRESH_MARKET_DATA_RESULT";
  ok: boolean;
  symbol: string | null;
  error: string | null;
}

/** Direct mode setting remains conservative; arming flows use ARM_AUTO_CLOSE
 * so they can run preflight and duration checks. */
export interface SetExecutionModeMessage {
  type: "SET_EXECUTION_MODE";
  mode: ExecutionMode;
}

export interface TestNotificationMessage {
  type: "TEST_NOTIFICATION";
}

export interface ExportLogsMessage {
  type: "EXPORT_LOGS";
}

export interface ExportLogsResultMessage {
  type: "EXPORT_LOGS_RESULT";
  json: string;
}

export interface ClearLogsMessage {
  type: "CLEAR_LOGS";
}

export interface UpdateSettingsMessage {
  type: "UPDATE_SETTINGS";
  settings: Settings;
}

export interface ResetSettingsMessage {
  type: "RESET_SETTINGS";
}

/** Side panel -> service worker -> content script (request/response, not a
 * broadcast): run a read-only DOM diagnostics scan on the Kraken tab. */
export interface RunDomDiagnosticsMessage {
  type: "RUN_DOM_DIAGNOSTICS";
}

export interface DomDiagnosticsResultMessage {
  type: "DOM_DIAGNOSTICS_RESULT";
  report: DiagnosticsReport | null;
  error: string | null;
}

/** Side panel -> service worker -> content script: read-only calibration
 * scan of Kraken's Buy/Open order form and account-equity display. Never
 * clicks, fills, or hovers — see OrderFormDiagnosticsReport's doc comment.
 * This is the prerequisite step before any real order-placement automation
 * is written; the user runs this against their real, logged-in Kraken tab
 * (with the Buy tab open) and shares the report back. */
export interface RunOrderFormDiagnosticsMessage {
  type: "RUN_ORDER_FORM_DIAGNOSTICS";
}

export interface OrderFormDiagnosticsResultMessage {
  type: "ORDER_FORM_DIAGNOSTICS_RESULT";
  report: OrderFormDiagnosticsReport | null;
  error: string | null;
}

export interface PreviewCloseMessage {
  type: "PREVIEW_CLOSE";
  fingerprint: string;
  symbol: string;
  lotLabel?: string | null;
}

export interface PreviewCloseResultMessage {
  type: "PREVIEW_CLOSE_RESULT";
  report: PreviewCloseReport | null;
  error: string | null;
}

export interface OpenCloseDialogMessage {
  type: "OPEN_CLOSE_DIALOG";
  fingerprint: string;
  symbol: string;
  lotLabel?: string | null;
}

export interface OpenCloseDialogResultMessage {
  type: "OPEN_CLOSE_DIALOG_RESULT";
  report: PreviewCloseReport | null;
  error: string | null;
}

export interface ConfirmCloseDialogMessage {
  type: "CONFIRM_CLOSE_DIALOG";
  fingerprint: string;
  symbol: string;
}

export interface ConfirmCloseDialogResultMessage {
  type: "CONFIRM_CLOSE_DIALOG_RESULT";
  modalValidation: CloseModalValidation | null;
  clicked: boolean;
  error: string | null;
}

/** Fills the quantity, ensures Buy+Market are selected, clicks submit, and
 * waits for/validates the resulting Kraken confirmation modal — mirrors
 * OPEN_CLOSE_DIALOG's shape exactly. Never clicks the modal's own Confirm
 * button; CONFIRM_BUY_ORDER is the separate, re-validated final step. */
export interface OpenBuyOrderMessage {
  type: "OPEN_BUY_ORDER";
  symbol: string;
  quantityUnits: number;
}

export interface OpenBuyOrderResultMessage {
  type: "OPEN_BUY_ORDER_RESULT";
  report: BuyOrderReport | null;
  error: string | null;
}

export interface ConfirmBuyOrderMessage {
  type: "CONFIRM_BUY_ORDER";
  symbol: string;
  quantityUnits: number;
}

export interface ConfirmBuyOrderResultMessage {
  type: "CONFIRM_BUY_ORDER_RESULT";
  modalValidation: BuyModalValidation | null;
  clicked: boolean;
  error: string | null;
}

export interface CloseModalStatusMessage {
  type: "CLOSE_MODAL_STATUS";
  symbol: string;
}

export interface CloseModalStatusResultMessage {
  type: "CLOSE_MODAL_STATUS_RESULT";
  modalOpen: boolean;
  successFeedback: boolean;
  error: string | null;
}

export type ExtensionMessage =
  | ScanResultMessage
  | RequestScanMessage
  | GetStateMessage
  | StateSnapshotMessage
  | StartMonitoringMessage
  | StopMonitoringMessage
  | ArmAutoCloseMessage
  | SetOperatingModeMessage
  | StartMonitoringWithLiveAutoCloseMessage
  | StartMonitoringWithLiveAutoCloseResultMessage
  | RunLivePreflightMessage
  | RunLivePreflightResultMessage
  | DisarmAutoCloseMessage
  | RefreshPositionsMessage
  | RefreshMarketDataMessage
  | RefreshMarketDataResultMessage
  | SetExecutionModeMessage
  | TestNotificationMessage
  | ExportLogsMessage
  | ExportLogsResultMessage
  | ClearLogsMessage
  | UpdateSettingsMessage
  | ResetSettingsMessage
  | RunDomDiagnosticsMessage
  | DomDiagnosticsResultMessage
  | RunOrderFormDiagnosticsMessage
  | OrderFormDiagnosticsResultMessage
  | PreviewCloseMessage
  | PreviewCloseResultMessage
  | OpenCloseDialogMessage
  | OpenCloseDialogResultMessage
  | ConfirmCloseDialogMessage
  | ConfirmCloseDialogResultMessage
  | OpenBuyOrderMessage
  | OpenBuyOrderResultMessage
  | ConfirmBuyOrderMessage
  | ConfirmBuyOrderResultMessage
  | CloseModalStatusMessage
  | CloseModalStatusResultMessage;

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  return typeof value === "object" && value !== null && "type" in value;
}
