/** Pure decision logic for the monitoring watchdog, factored out of
 * service-worker.ts so it can be unit-tested without any chrome.* mocking.
 *
 * The core problem this exists to solve: `lastHeartbeatAt` is bumped on
 * every alarm tick regardless of whether the scan actually succeeded, so it
 * cannot by itself detect "the alarm keeps firing but scans keep failing."
 * This tracks the last *successful* scan instead, against the required
 * threshold max(3 * pollMinutes, 15 minutes). */

export function computeStallThresholdMs(pollMinutes: number): number {
  return Math.max(pollMinutes * 3, 15) * 60_000;
}

export interface StallCheckInput {
  /** Timestamp of the last successful complete scan, if any. */
  lastSuccessfulScanAt: number | null;
  /** Fallback reference point when no scan has ever succeeded yet
   * (e.g. monitoringStartedAt), so a slow first scan doesn't immediately
   * read as "stalled since the beginning of time." */
  fallbackReferenceAt: number | null;
  pollMinutes: number;
  now: number;
}

export interface StallCheckResult {
  stalled: boolean;
  stalledForMs: number;
}

export function checkStall(input: StallCheckInput): StallCheckResult {
  const referenceTs = input.lastSuccessfulScanAt ?? input.fallbackReferenceAt ?? input.now;
  const stalledForMs = input.now - referenceTs;
  const thresholdMs = computeStallThresholdMs(input.pollMinutes);
  return { stalled: stalledForMs > thresholdMs, stalledForMs };
}
