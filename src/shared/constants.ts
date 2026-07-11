import type { Settings } from "./types";

export const STORAGE_SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS: Settings = {
  pollMinutes: 5,
  marketRefreshMinutes: 10,
  candleIntervalMinutes: 60,
  fastSma: 7,
  slowSma: 30,
  longSma: 90,
  atrPeriod: 14,
  slope7LookbackHours: 3,
  slope30LookbackHours: 6,
  slope90LookbackHours: 12,
  hardLossPercent: -3,
  hardLossFallbackPct: -3,
  hardLossMinDistancePct: -1.75,
  hardLossMaxDistancePct: -3,
  hardLossAtrMultiple: 2,
  hardLossConfirmationSeconds: 20,
  hardLossRequiredObservations: 2,
  profitLockActivationPercent: 3,
  profitActivationPct: 3,
  profitActivationAtrMultiple: 1.75,
  majorTrendBreakAtrBuffer: 0.5,
  expansionFloorAtrBuffer: 0.35,
  deteriorationAtrBreakBuffer: 0.35,
  expansionFastBreakAtrBuffer: 0.5,
  slope7StrongPositive: 0.15,
  slope7Positive: 0.03,
  slope7Negative: -0.03,
  slope30StrongPositive: 0.06,
  slope30FlatLowerBound: -0.04,
  btcStressEnabled: false,
  apiUiPriceTolerancePercent: 1,
  strongTrendConfirmationCloses: 2,
  weakTrendConfirmationCloses: 1,
  autoCloseDurationHours: 8,
  maxLiveClosesPerHour: 2,
  maxLiveClosesPerArmedSession: 5,
  autoCloseSignalExpiryMinutes: 5,
  closeVerificationTimeoutSeconds: 10,
  sleepGapWarningMinutes: 10,
  requireRearmAfterGapMinutes: 30,
  executionMode: "MONITOR_ONLY",
  alarmSoundEnabled: true,
  startMonitoringWithLiveAutoClose: false,
  /** Pre-filled with the user's own private ntfy.sh topic so it works out
   * of the box on this install; still editable/clearable in Settings. */
  executionWebhookUrl: "https://ntfy.sh/kraken-guard-nitgaddam-1992",
  executionEmailAddress: "",
  watchlistCoins: [],
};

/** Hard cap on Settings.watchlistCoins — keeps the per-cycle public-API
 * fetch cost (candles + ticker per symbol) bounded regardless of how many
 * coins the user tries to enter. */
export const MAX_WATCHLIST_COINS = 5;

/** Profit-protection tiers: [peakReturnPctLowerBoundInclusive, giveback fraction retained]. */
export const PROFIT_LOCK_TIERS = [
  { minPeakPct: 3, maxPeakPct: 7, floorFraction: 0.5 },
  { minPeakPct: 7, maxPeakPct: 15, floorFraction: 0.65 },
  { minPeakPct: 15, maxPeakPct: Infinity, floorFraction: 0.75 },
] as const;

export const MAX_AUDIT_LOG_ENTRIES = 2000;

export const KRAKEN_PROP_URL_PATTERN = "https://pro.kraken.com/prop/*";
export const KRAKEN_PUBLIC_OHLC_URL = "https://api.kraken.com/0/public/OHLC";
export const KRAKEN_PUBLIC_TICKER_URL = "https://api.kraken.com/0/public/Ticker";
export const KRAKEN_PUBLIC_ASSET_PAIRS_URL = "https://api.kraken.com/0/public/AssetPairs";

export const ALARM_NAME_POLL = "kraken-guard-poll";
export const ALARM_NAME_MARKET_REFRESH = "kraken-guard-market-refresh";

/** Developer-only convenience so the Market Data table can be exercised
 * before real position rows parse. No API key, no trading configuration,
 * and no effect on execution — purely a market-data-fetch trigger, clearly
 * labeled WATCHLIST (never DETECTED POSITION) wherever it's shown. */
export const DEV_WATCHLIST_SYMBOLS = ["XPL", "JTO"];
