/** Sends a notification to an external channel (phone via the free ntfy.sh
 * push service by default) — and ONLY when a close execution reaches a
 * terminal outcome. Never called for monitoring start/stop, strategy
 * signals, arming, stall/health events, or anything else — see the four
 * call sites in service-worker.ts (AUTO_CLOSE_SUCCEEDED, CLOSE_FAILED /
 * AUTO_CLOSE_UNCERTAIN, MANUAL_POSITION_CLOSE_SUCCEEDED, and the manual
 * equivalent of CLOSE_FAILED).
 *
 * Scoped to ntfy.sh for now: it's the only origin declared in
 * host_permissions, so it works with zero extra permission prompts and no
 * signup — install the ntfy app, subscribe to a topic you choose, and set
 * this setting to https://ntfy.sh/<that-topic>. Supporting arbitrary
 * webhook URLs (Discord/Slack/email-via-Zapier/etc.) would require
 * optional_host_permissions + a runtime chrome.permissions.request() flow;
 * deliberately left out of this pass to avoid widening permissions beyond
 * what's declared today.
 *
 * Optionally also relays to an email address via ntfy.sh's own built-in
 * email add-on (an X-Email header on the same request, same free tier, no
 * extra permission or API key) — only takes effect if the ntfy topic URL
 * above is also set, since it's an extra header on that same POST, not a
 * separate delivery path. */

export interface ExecutionNotificationDetails {
  symbol: string;
  lotLabel: string | null;
  result: "SUCCESS" | "FAILURE" | "UNCERTAIN";
  mode: "LIVE_AUTO_CLOSE" | "MANUAL";
  reason: string;
  entryPrice: number | null;
  currentPrice: number | null;
  currentReturnPct: number | null;
  details: string[];
  timestamp: number;
}

export function isSupportedExecutionWebhookUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "ntfy.sh";
  } catch {
    return false;
  }
}

/** Deliberately permissive — this only gates whether we bother sending the
 * X-Email header at all. ntfy.sh itself validates deliverability. */
export function isPlausibleEmailAddress(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function buildExecutionNotificationTitle(d: ExecutionNotificationDetails): string {
  const lot = d.lotLabel ? ` ${d.lotLabel}` : "";
  const outcome =
    d.result === "SUCCESS" ? "closed" : d.result === "UNCERTAIN" ? "UNCERTAIN" : "FAILED";
  return `${d.symbol}${lot} ${outcome} (${d.mode === "MANUAL" ? "manual" : "LIVE"})`;
}

export function buildExecutionNotificationBody(d: ExecutionNotificationDetails): string {
  const lines = [
    `Symbol: ${d.symbol}${d.lotLabel ? ` ${d.lotLabel}` : ""}`,
    `Mode: ${d.mode === "MANUAL" ? "Manual close" : "LIVE Auto-Close"}`,
    `Result: ${d.result}`,
    `Reason: ${d.reason}`,
  ];
  if (d.entryPrice !== null) lines.push(`Entry price: ${d.entryPrice}`);
  if (d.currentPrice !== null) lines.push(`Current price: ${d.currentPrice}`);
  if (d.currentReturnPct !== null) lines.push(`Return: ${d.currentReturnPct.toFixed(2)}%`);
  if (d.details.length > 0) lines.push(`Details: ${d.details.join("; ")}`);
  lines.push(`Time: ${new Date(d.timestamp).toLocaleString()}`);
  return lines.join("\n");
}

export async function sendExecutionWebhook(
  webhookUrl: string,
  details: ExecutionNotificationDetails,
  emailAddress = ""
): Promise<void> {
  if (!webhookUrl) return;
  if (!isSupportedExecutionWebhookUrl(webhookUrl)) {
    console.warn(
      `[kraken-guard] executionWebhookUrl is not an ntfy.sh URL, skipping: ${webhookUrl}`
    );
    return;
  }

  const title = buildExecutionNotificationTitle(details);
  const body = buildExecutionNotificationBody(details);
  const headers: Record<string, string> = {
    Title: title,
    Priority: details.result === "SUCCESS" ? "default" : "urgent",
    Tags: details.result === "SUCCESS" ? "white_check_mark" : "rotating_light",
  };
  if (emailAddress && isPlausibleEmailAddress(emailAddress)) {
    headers["X-Email"] = emailAddress;
  }

  try {
    await fetch(webhookUrl, { method: "POST", headers, body });
  } catch (err) {
    console.warn("[kraken-guard] execution webhook failed", err);
  }
}
