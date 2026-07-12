/** Sends a notification to an external channel (phone via the free ntfy.sh
 * push service by default). Two distinct kinds, never confused:
 * `sendExecutionWebhook` fires ONLY when a close execution reaches a
 * terminal outcome (see the four call sites in service-worker.ts:
 * AUTO_CLOSE_SUCCEEDED, CLOSE_FAILED / AUTO_CLOSE_UNCERTAIN,
 * MANUAL_POSITION_CLOSE_SUCCEEDED, and the manual equivalent of
 * CLOSE_FAILED); `sendBuySignalWebhook` fires ONLY when a watchlist
 * symbol's golden cross is newly confirmed. Neither ever fires for
 * monitoring start/stop, arming, or stall/health events.
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
  mode: "LIVE_AUTO_CLOSE" | "MANUAL" | "AUTO_BUY";
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
  if (d.mode === "AUTO_BUY") {
    const outcome = d.result === "SUCCESS" ? "bought" : d.result === "UNCERTAIN" ? "UNCERTAIN" : "FAILED";
    return `${d.symbol}${lot} ${outcome} (Autopilot buy)`;
  }
  const outcome =
    d.result === "SUCCESS" ? "closed" : d.result === "UNCERTAIN" ? "UNCERTAIN" : "FAILED";
  return `${d.symbol}${lot} ${outcome} (${d.mode === "MANUAL" ? "manual" : "LIVE"})`;
}

export function buildExecutionNotificationBody(d: ExecutionNotificationDetails): string {
  const modeLabel =
    d.mode === "MANUAL" ? "Manual close" : d.mode === "AUTO_BUY" ? "Autopilot buy" : "LIVE Auto-Close";
  const lines = [
    `Symbol: ${d.symbol}${d.lotLabel ? ` ${d.lotLabel}` : ""}`,
    `Mode: ${modeLabel}`,
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

/** Buy-signal notifications are purely informational — Kraken is never
 * auto-bought, this only tells the user a watchlist coin's golden cross
 * confirmed so they can place a manual order themselves. Deliberately
 * distinct Title prefix/tag/priority from execution notifications so the
 * two are never confused, even though both may share the same ntfy topic. */
export interface BuySignalNotificationDetails {
  symbol: string;
  currentPrice: number | null;
  smaFast: number | null;
  smaSlow: number | null;
  consecutiveClosesAboveSmaFast: number;
  timestamp: number;
}

export function buildBuySignalTitle(d: BuySignalNotificationDetails): string {
  return `BUY SIGNAL: ${d.symbol}`;
}

export function buildBuySignalBody(d: BuySignalNotificationDetails): string {
  const lines = [
    `Symbol: ${d.symbol}`,
    `Pattern: Golden cross (SMA7 > SMA30), confirmed after ${d.consecutiveClosesAboveSmaFast} completed closes above SMA7`,
  ];
  if (d.currentPrice !== null) lines.push(`Current price: ${d.currentPrice}`);
  if (d.smaFast !== null) lines.push(`SMA7: ${d.smaFast}`);
  if (d.smaSlow !== null) lines.push(`SMA30: ${d.smaSlow}`);
  lines.push(`Time: ${new Date(d.timestamp).toLocaleString()}`);
  lines.push("Informational only — no order was placed. Place a manual buy on Kraken if you agree.");
  return lines.join("\n");
}

export async function sendBuySignalWebhook(
  webhookUrl: string,
  details: BuySignalNotificationDetails,
  emailAddress = ""
): Promise<void> {
  if (!webhookUrl) return;
  if (!isSupportedExecutionWebhookUrl(webhookUrl)) {
    console.warn(`[kraken-guard] executionWebhookUrl is not an ntfy.sh URL, skipping: ${webhookUrl}`);
    return;
  }

  const title = buildBuySignalTitle(details);
  const body = buildBuySignalBody(details);
  const headers: Record<string, string> = {
    Title: title,
    Priority: "high",
    Tags: "moneybag",
  };
  if (emailAddress && isPlausibleEmailAddress(emailAddress)) {
    headers["X-Email"] = emailAddress;
  }

  try {
    await fetch(webhookUrl, { method: "POST", headers, body });
  } catch (err) {
    console.warn("[kraken-guard] buy signal webhook failed", err);
  }
}

/** Covers every Cruise-mode signal-tier escalation that isn't already the
 * more specific golden-cross BUY_SIGNAL_DETECTED case (that one keeps using
 * sendBuySignalWebhook above) — i.e. entering SELL/STRONG_SELL, or entering
 * BUY/STRONG_BUY by a route other than a fresh golden cross. Cruise-only,
 * informational — never places or closes anything. */
export interface SignalTierNotificationDetails {
  symbol: string;
  tier: "STRONG_BUY" | "BUY" | "SELL" | "STRONG_SELL";
  reason: string;
  timestamp: number;
}

export function buildSignalTierTitle(d: SignalTierNotificationDetails): string {
  const direction = d.tier === "STRONG_BUY" || d.tier === "BUY" ? "BUY SIGNAL" : "SELL SIGNAL";
  return `${direction}: ${d.symbol} (${d.tier})`;
}

export function buildSignalTierBody(d: SignalTierNotificationDetails): string {
  return [
    `Symbol: ${d.symbol}`,
    `Signal: ${d.tier}`,
    `Reason: ${d.reason}`,
    `Time: ${new Date(d.timestamp).toLocaleString()}`,
    "Informational only (Cruise mode) — no order was placed or closed.",
  ].join("\n");
}

export async function sendSignalTierWebhook(
  webhookUrl: string,
  details: SignalTierNotificationDetails,
  emailAddress = ""
): Promise<void> {
  if (!webhookUrl) return;
  if (!isSupportedExecutionWebhookUrl(webhookUrl)) {
    console.warn(`[kraken-guard] executionWebhookUrl is not an ntfy.sh URL, skipping: ${webhookUrl}`);
    return;
  }

  const isBuySide = details.tier === "STRONG_BUY" || details.tier === "BUY";
  const headers: Record<string, string> = {
    Title: buildSignalTierTitle(details),
    Priority: details.tier === "STRONG_BUY" || details.tier === "STRONG_SELL" ? "high" : "default",
    Tags: isBuySide ? "moneybag" : "chart_with_downwards_trend",
  };
  if (emailAddress && isPlausibleEmailAddress(emailAddress)) {
    headers["X-Email"] = emailAddress;
  }

  try {
    await fetch(webhookUrl, { method: "POST", headers, body: buildSignalTierBody(details) });
  } catch (err) {
    console.warn("[kraken-guard] signal tier webhook failed", err);
  }
}
