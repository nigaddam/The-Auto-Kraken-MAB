import { KRAKEN_PROP_URL_PATTERN } from "../shared/constants";
import type { PageHealthStatus, SessionState } from "../shared/types";
import { findPositionsContainer, textOf } from "./kraken-dom";

/** Best-effort, text/role-based detection — no credentials are ever read,
 * only whether these UI states are *present*. Like position-parser.ts, this
 * needs validation against the real, logged-in Kraken Prop page; see
 * README "DOM Diagnostics". */

function matchesUrlPattern(url: string): boolean {
  const prefix = KRAKEN_PROP_URL_PATTERN.replace(/\*$/, "");
  return url.startsWith(prefix);
}

function isAuthRedirectUrl(url: string): boolean {
  return /\/(login|signin|sign-in|auth|session\/new)(\/|$|\?)/i.test(url);
}

function hasPasswordField(root: ParentNode): boolean {
  return root.querySelector('input[type="password"]') !== null;
}

/** Deliberately narrow: only a button/link whose *own* accessible name is
 * essentially just "Log in"/"Sign in" counts — a page that merely mentions
 * those words somewhere (e.g. an unrelated "switch account" menu item)
 * must not be misread as an unauthenticated login form. */
function hasLoginCallToAction(root: ParentNode): boolean {
  const candidates = Array.from(
    root.querySelectorAll<Element>('button, a, [role="button"], [role="link"]')
  );
  return candidates.some((el) => {
    const name = (el.getAttribute("aria-label") ?? textOf(el)).trim();
    return /^(log\s*in|sign\s*in)$/i.test(name);
  });
}

function getRootText(root: ParentNode): string {
  if (root instanceof Document) {
    return root.body?.textContent ?? root.documentElement?.textContent ?? "";
  }
  return (root as Element).textContent ?? "";
}

function textMatches(root: ParentNode, patterns: RegExp[]): boolean {
  const bodyText = getRootText(root).replace(/\s+/g, " ");
  return patterns.some((re) => re.test(bodyText));
}

function hasCaptchaMarkers(root: ParentNode): boolean {
  const iframeMatch =
    root.querySelector('iframe[src*="captcha" i], iframe[src*="hcaptcha" i], iframe[src*="recaptcha" i]') !==
    null;
  const classMatch = root.querySelector('[class*="captcha" i], [id*="captcha" i]') !== null;
  return iframeMatch || classMatch || textMatches(root, [/captcha/i]);
}

export function checkPageHealth(
  root: ParentNode,
  url: string,
  hasConfirmedPositions = false
): PageHealthStatus {
  const propPageDetected = matchesUrlPattern(url);

  const accountMarkerDetected =
    root.querySelector('[data-testid*="account" i], [aria-label*="account" i]') !== null;

  const loginFormDetected =
    hasPasswordField(root) || hasLoginCallToAction(root) || isAuthRedirectUrl(url);

  const sessionExpiredModalDetected = textMatches(root, [
    /session\s+(has\s+)?expired/i,
    /please\s+log\s+in\s+again/i,
    /you(?:'|’)ve\s+been\s+signed\s+out/i,
  ]);

  const captchaDetected = hasCaptchaMarkers(root);

  const twoFaDetected = textMatches(root, [
    /two[\s-]?factor/i,
    /\b2fa\b/i,
    /verification\s+code/i,
    /authenticator\s+app/i,
  ]);

  const deviceApprovalDetected = textMatches(root, [
    /device\s+approval/i,
    /approve\s+this\s+device/i,
    /new\s+device\s+detected/i,
  ]);

  const positionsTableReadable = findPositionsContainer(root) !== null;

  const hasNegativeSessionEvidence =
    loginFormDetected ||
    sessionExpiredModalDetected ||
    captchaDetected ||
    twoFaDetected ||
    deviceApprovalDetected;

  // A logged-out page cannot render real position rows with entry
  // price/value/PnL data, so successfully parsing at least one confirmed
  // position is at least as strong positive evidence of an authenticated
  // session as the (unverified, possibly miscalibrated) account-marker
  // selector above — mirrors the same upgrade rule already used in
  // diagnostics.ts's separate loggedInState computation.
  let sessionState: SessionState;
  if (hasNegativeSessionEvidence) {
    sessionState = "LOGGED_OUT";
  } else if (accountMarkerDetected || hasConfirmedPositions) {
    sessionState = "LOGGED_IN";
  } else {
    sessionState = "UNKNOWN";
  }

  return {
    checkedAt: Date.now(),
    propPageDetected,
    accountMarkerDetected,
    sessionState,
    positionsTableReadable,
    loginFormDetected,
    sessionExpiredModalDetected,
    captchaDetected,
    twoFaDetected,
    deviceApprovalDetected,
  };
}
