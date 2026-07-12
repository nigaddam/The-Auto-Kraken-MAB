import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { checkPageHealth } from "../src/content/page-health";

const PROP_URL = "https://pro.kraken.com/prop/account/abc123/portfolio";
const NON_PROP_URL = "https://pro.kraken.com/app/trade/BTC-USD";

function loadFixture(name: string): void {
  const html = readFileSync(join(__dirname, "fixtures", name), "utf-8");
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("checkPageHealth", () => {
  it("detects a healthy, logged-in Prop page with readable positions", () => {
    loadFixture("prop-page-healthy.html");
    const health = checkPageHealth(document, PROP_URL);
    expect(health.propPageDetected).toBe(true);
    expect(health.accountMarkerDetected).toBe(true);
    expect(health.positionsTableReadable).toBe(true);
    expect(health.loginFormDetected).toBe(false);
    expect(health.sessionState).toBe("LOGGED_IN");
  });

  it("does not consider a non-Prop Kraken page as the Prop page", () => {
    loadFixture("prop-page-healthy.html");
    const health = checkPageHealth(document, NON_PROP_URL);
    expect(health.propPageDetected).toBe(false);
  });

  it("detects a login page and marks the session LOGGED_OUT", () => {
    loadFixture("login-page.html");
    const health = checkPageHealth(document, PROP_URL);
    expect(health.loginFormDetected).toBe(true);
    expect(health.sessionState).toBe("LOGGED_OUT");
  });

  it("detects a session-expired modal", () => {
    loadFixture("session-expired.html");
    const health = checkPageHealth(document, PROP_URL);
    expect(health.sessionExpiredModalDetected).toBe(true);
    expect(health.sessionState).toBe("LOGGED_OUT");
  });

  it("detects a CAPTCHA challenge", () => {
    loadFixture("captcha.html");
    const health = checkPageHealth(document, PROP_URL);
    expect(health.captchaDetected).toBe(true);
    expect(health.sessionState).toBe("LOGGED_OUT");
  });

  it("detects a 2FA prompt", () => {
    loadFixture("twofa.html");
    const health = checkPageHealth(document, PROP_URL);
    expect(health.twoFaDetected).toBe(true);
    expect(health.sessionState).toBe("LOGGED_OUT");
  });

  it("detects a device-approval prompt", () => {
    loadFixture("device-approval.html");
    const health = checkPageHealth(document, PROP_URL);
    expect(health.deviceApprovalDetected).toBe(true);
    expect(health.sessionState).toBe("LOGGED_OUT");
  });

  it("is UNKNOWN — never LOGGED_OUT — when there is no positive or negative evidence at all", () => {
    document.body.innerHTML = "<div>Nothing here at all</div>";
    const health = checkPageHealth(document, PROP_URL);
    expect(health.sessionState).toBe("UNKNOWN");
  });

  it("does not misread an unrelated 'sign in' mention as a login form", () => {
    document.body.innerHTML =
      '<div>Open positions</div><a href="#">Sign in to our newsletter for updates</a>';
    const health = checkPageHealth(document, PROP_URL);
    expect(health.loginFormDetected).toBe(false);
    expect(health.sessionState).toBe("UNKNOWN");
  });

  it("upgrades UNKNOWN to LOGGED_IN when the caller confirms at least one position parsed, even with no account marker", () => {
    // Real scenario: the account-marker selector doesn't match this
    // account's actual markup, but real position rows with entry
    // price/value/PnL parsed successfully — that's itself proof of an
    // authenticated session.
    document.body.innerHTML = "<div>Positions table with no matching account marker</div>";
    const withoutEvidence = checkPageHealth(document, PROP_URL, false);
    expect(withoutEvidence.sessionState).toBe("UNKNOWN");
    const withEvidence = checkPageHealth(document, PROP_URL, true);
    expect(withEvidence.accountMarkerDetected).toBe(false);
    expect(withEvidence.sessionState).toBe("LOGGED_IN");
  });

  it("confirmed positions never downgrade an already-LOGGED_OUT determination", () => {
    loadFixture("login-page.html");
    const health = checkPageHealth(document, PROP_URL, true);
    expect(health.sessionState).toBe("LOGGED_OUT");
  });

  it("zero parsed positions never implies logged out — checkPageHealth has no dependency on position count", () => {
    // An account marker present but no positions section/rows at all (e.g.
    // an empty portfolio, or row discovery not yet calibrated) must still
    // read as LOGGED_IN, not LOGGED_OUT — there is no code path here that
    // even looks at how many positions were parsed.
    document.body.innerHTML =
      '<div data-testid="account-selector">Prop Account</div><div>No content here</div>';
    const health = checkPageHealth(document, PROP_URL);
    expect(health.positionsTableReadable).toBe(false);
    expect(health.sessionState).toBe("LOGGED_IN");
  });
});
