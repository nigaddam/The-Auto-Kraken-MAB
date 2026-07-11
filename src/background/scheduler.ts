import { ALARM_NAME_MARKET_REFRESH, ALARM_NAME_POLL } from "../shared/constants";

export async function startPolling(pollMinutes: number): Promise<void> {
  await chrome.alarms.clear(ALARM_NAME_POLL);
  await chrome.alarms.create(ALARM_NAME_POLL, { periodInMinutes: pollMinutes });
}

export async function stopPolling(): Promise<void> {
  await chrome.alarms.clear(ALARM_NAME_POLL);
}

export async function startMarketDataPolling(marketRefreshMinutes: number): Promise<void> {
  await chrome.alarms.clear(ALARM_NAME_MARKET_REFRESH);
  await chrome.alarms.create(ALARM_NAME_MARKET_REFRESH, { periodInMinutes: marketRefreshMinutes });
}

export async function stopMarketDataPolling(): Promise<void> {
  await chrome.alarms.clear(ALARM_NAME_MARKET_REFRESH);
}

/** Compares expected vs. actual wake-up gap. A gap larger than
 * warningMinutes means the machine likely slept (or the service worker was
 * suspended unusually long) between ticks — the caller must re-validate
 * everything from scratch rather than trust state computed before the gap. */
export function detectSleepGap(
  lastHeartbeatAt: number | null,
  warningMinutes: number,
  now: number
): { gapDetected: boolean; gapMinutes: number } {
  if (lastHeartbeatAt === null) {
    return { gapDetected: false, gapMinutes: 0 };
  }
  const gapMinutes = (now - lastHeartbeatAt) / 60_000;
  return { gapDetected: gapMinutes > warningMinutes, gapMinutes };
}
