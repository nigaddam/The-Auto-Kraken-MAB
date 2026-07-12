import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runDiagnostics, sanitizeText } from "../src/content/diagnostics";

const PROP_URL = "https://pro.kraken.com/prop/account/ABC123XYZ/portfolio";

function loadFixture(name: string): void {
  const html = readFileSync(join(__dirname, "fixtures", name), "utf-8");
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("runDiagnostics: page health fields", () => {
  it("reports page/domain/prop/portfolio detection and redacts the account id from the URL", () => {
    loadFixture("prop-page-healthy.html");
    const report = runDiagnostics(document, PROP_URL);
    expect(report.currentPageDetected).toBe(true);
    expect(report.krakenDomainDetected).toBe(true);
    expect(report.propUrlDetected).toBe(true);
    expect(report.portfolioPageDetected).toBe(true);
    expect(report.loggedInState).toBe("YES");
    expect(report.positionsSectionDetected).toBe(true);
    expect(report.url).not.toContain("ABC123XYZ");
    expect(report.url).toContain("[REDACTED_ACCOUNT_ID]");
  });

  it("reports NO login state when a login form is present", () => {
    loadFixture("login-page.html");
    const report = runDiagnostics(document, PROP_URL);
    expect(report.loggedInState).toBe("NO");
  });

  it("reports UNKNOWN login state when there is no positive or negative signal", () => {
    document.body.innerHTML = "<div>Nothing here at all</div>";
    const report = runDiagnostics(document, PROP_URL);
    expect(report.loggedInState).toBe("UNKNOWN");
  });

  it("does not consider a non-Prop URL as the Prop page", () => {
    loadFixture("prop-page-healthy.html");
    const report = runDiagnostics(document, "https://pro.kraken.com/app/trade/BTC-USD");
    expect(report.propUrlDetected).toBe(false);
  });
});

describe("runDiagnostics: candidate rows vs. parsed positions", () => {
  it("distinguishes candidate row count from resolved position count", () => {
    loadFixture("positions-basic.html");
    const report = runDiagnostics(document, PROP_URL);
    expect(report.candidateRowCount).toBe(2);
    expect(report.parsedPositionCount).toBe(2);
    expect(report.rows).toHaveLength(2);
  });
});

describe("PositionGroup evidence: summary + actionable child row", () => {
  it("groups via DOM parent/child containment (strongest evidence)", () => {
    loadFixture("diagnostics-containment.html");
    const report = runDiagnostics(document, PROP_URL);
    expect(report.candidateRowCount).toBe(2);
    expect(report.parsedPositionCount).toBe(1);
    expect(report.groups).toHaveLength(1);
    const group = report.groups[0]!;
    expect(group.ambiguous).toBe(false);
    expect(group.summaryRowIndex).toBe(0);
    expect(group.actionableChildRowIndexes).toEqual([1]);
  });

  it("groups via aria-expanded/aria-controls linkage", () => {
    loadFixture("diagnostics-aria-controls.html");
    const report = runDiagnostics(document, PROP_URL);
    expect(report.parsedPositionCount).toBe(1);
    const group = report.groups[0]!;
    expect(group.ambiguous).toBe(false);
    expect(group.summaryRowIndex).toBe(0);
    expect(group.actionableChildRowIndexes).toEqual([1]);
  });

  it("groups via a shared data-* attribute", () => {
    loadFixture("diagnostics-shared-data-attr.html");
    const report = runDiagnostics(document, PROP_URL);
    expect(report.parsedPositionCount).toBe(1);
    const group = report.groups[0]!;
    expect(group.ambiguous).toBe(false);
    expect(group.summaryRowIndex).toBe(0);
  });

  it("groups via weak adjacency + symbol match, and says so explicitly", () => {
    loadFixture("diagnostics-weak-adjacency.html");
    const report = runDiagnostics(document, PROP_URL);
    expect(report.parsedPositionCount).toBe(1);
    const group = report.groups[0]!;
    expect(group.evidence.some((e) => /weak evidence/i.test(e))).toBe(true);
  });

  it("flags AMBIGUOUS instead of guessing when the same symbol appears in independent, unlinked actionable rows", () => {
    loadFixture("diagnostics-ambiguous-duplicate.html");
    const report = runDiagnostics(document, PROP_URL);
    expect(report.candidateRowCount).toBe(3);

    const xplGroups = report.groups.filter((g) => g.symbol === "XPL");
    expect(xplGroups).toHaveLength(2);
    expect(xplGroups.every((g) => g.ambiguous)).toBe(true);
    expect(xplGroups[0]!.ambiguityReason).toMatch(/independent position groups/i);

    const jtoGroups = report.groups.filter((g) => g.symbol === "JTO");
    expect(jtoGroups).toHaveLength(1);
    expect(jtoGroups[0]!.ambiguous).toBe(false);

    // Ambiguous groups are excluded from the resolved count.
    expect(report.parsedPositionCount).toBe(1);
  });
});

describe("close control introspection without hovering", () => {
  it("reports an icon-only close control's data-testid and that its accessible name needs a hover", () => {
    loadFixture("diagnostics-icon-only-close.html");
    const report = runDiagnostics(document, PROP_URL);
    const rowDiag = report.rows[0]!;
    expect(rowDiag.hasCloseControl).toBe(true);
    expect(rowDiag.closeControlInfo).not.toBeNull();
    expect(rowDiag.closeControlInfo!.ariaLabelPresent).toBe(false);
    expect(rowDiag.closeControlInfo!.titlePresent).toBe(false);
    expect(rowDiag.closeControlInfo!.accessibleNameAvailableWithoutHover).toBe(false);
    expect(rowDiag.closeControlInfo!.dataTestId).toBe("close-position-button");
    expect(rowDiag.closeControlInfo!.note).toMatch(/hover/i);

    // The generic controls list still surfaces it even though its name is unknown.
    const control = rowDiag.controls.find((c) => c.dataTestId === "close-position-button");
    expect(control).toBeDefined();
  });

  it("reports a labeled close control's accessible name as available without hovering", () => {
    loadFixture("positions-basic.html");
    const report = runDiagnostics(document, PROP_URL);
    const rowDiag = report.rows[0]!;
    expect(rowDiag.closeControlInfo!.accessibleNameAvailableWithoutHover).toBe(true);
    expect(rowDiag.closeControlInfo!.ariaLabelPresent).toBe(true);
  });
});

describe("sanitizeText redaction", () => {
  it("redacts email addresses", () => {
    expect(sanitizeText("Contact support at trader@example.com now")).not.toContain("trader@example.com");
    expect(sanitizeText("Contact support at trader@example.com now")).toContain("[REDACTED_EMAIL]");
  });

  it("redacts an 'account <id>' pattern in visible text", () => {
    const sanitized = sanitizeText("Prop Account: abc123def456");
    expect(sanitized).not.toContain("abc123def456");
    expect(sanitized).toContain("[REDACTED]");
  });

  it("redacts UUID-looking identifiers", () => {
    const sanitized = sanitizeText("session for 123e4567-e89b-12d3-a456-426614174000 active");
    expect(sanitized).not.toContain("123e4567-e89b-12d3-a456-426614174000");
    expect(sanitized).toContain("[REDACTED_ID]");
  });

  it("truncates very long text", () => {
    const sanitized = sanitizeText("a".repeat(500), 50);
    expect(sanitized.length).toBeLessThanOrEqual(51);
  });
});

describe("runDiagnostics never includes forbidden data", () => {
  it("does not read cookies, localStorage, or sessionStorage", () => {
    // The report shape (shared/types.ts DiagnosticsReport) has no field for
    // any of these, and diagnostics.ts never calls document.cookie,
    // localStorage, or sessionStorage anywhere — this test documents that
    // guarantee so a future change touching those APIs fails a diff review.
    loadFixture("prop-page-healthy.html");
    const report = runDiagnostics(document, PROP_URL);
    const json = JSON.stringify(report);
    expect(json).not.toMatch(/cookie/i);
    expect(json).not.toMatch(/localStorage/i);
    expect(json).not.toMatch(/sessionStorage/i);
  });
});
