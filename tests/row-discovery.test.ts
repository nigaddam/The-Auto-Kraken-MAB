import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parsePositionsFromDocument } from "../src/content/position-parser";
import { reconcilePositions, computeFingerprint } from "../src/strategy/state-machine";
import { runDiagnostics } from "../src/content/diagnostics";

function loadFixture(name: string): void {
  const html = readFileSync(join(__dirname, "fixtures", name), "utf-8");
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("div-based (non-table) row discovery fallback", () => {
  it("finds real positions when there is no <tr>/role=row/data-testid markup at all", () => {
    loadFixture("real-world-multilot.html");
    const result = parsePositionsFromDocument(document);
    expect(result.discoveryMethod).toBe("TEXT_ANCHOR_FALLBACK");
    expect(result.candidateRowCount).toBe(3);
    expect(result.positions).toHaveLength(3);
  });

  it("does not count the non-actionable summary row as a position", () => {
    loadFixture("real-world-multilot.html");
    const { positions } = parsePositionsFromDocument(document);
    // The XPL summary row's aggregate value (691.80) must never appear as
    // a parsed position's value — only the two actionable children's values do.
    expect(positions.some((p) => p.valueUsd === 691.8)).toBe(false);
  });

  it("produces three actionable rows -> three distinct tracked position states", () => {
    loadFixture("real-world-multilot.html");
    const { positions } = parsePositionsFromDocument(document);
    const tracked = reconcilePositions(positions, {}, Date.now());
    expect(Object.keys(tracked)).toHaveLength(3);
    for (const pos of Object.values(tracked)) {
      expect(pos.status).toBe("ACTIVE");
      expect(pos.autoCloseDisabledReason).toBeNull();
    }
  });

  it("keeps the two XPL lots (opening prices 0.0916 and 0.0929) as distinct fingerprints", () => {
    loadFixture("real-world-multilot.html");
    const { positions } = parsePositionsFromDocument(document);
    const xplLots = positions.filter((p) => p.symbol === "XPL");
    expect(xplLots).toHaveLength(2);
    expect(xplLots.map((p) => p.entryPrice).sort()).toEqual([0.0916, 0.0929]);

    const fingerprints = xplLots.map((p) => computeFingerprint(p));
    expect(new Set(fingerprints).size).toBe(2); // never merged into one
  });

  it("keeps the JTO group as a single actionable lot", () => {
    loadFixture("real-world-multilot.html");
    const { positions } = parsePositionsFromDocument(document);
    const jtoLots = positions.filter((p) => p.symbol === "JTO");
    expect(jtoLots).toHaveLength(1);
    expect(jtoLots[0]!.entryPrice).toBeCloseTo(0.61828);
  });

  it("groups two actionable XPL children under one summary without flagging ambiguity", () => {
    loadFixture("real-world-multilot.html");
    const report = runDiagnostics(document, "https://pro.kraken.com/prop/account/x/portfolio");
    const xplGroup = report.groups.find((g) => g.symbol === "XPL");
    expect(xplGroup).toBeDefined();
    expect(xplGroup!.actionableChildRowIndexes.length).toBe(2);
    expect(xplGroup!.ambiguous).toBe(false);
  });

  it("discovers AAVE/JTO/XPL dynamically as three groups and five actionable lots", () => {
    loadFixture("real-world-aave-jto-xpl.html");
    const result = parsePositionsFromDocument(document);
    expect(result.discoveryMethod).toBe("TEXT_ANCHOR_FALLBACK");
    expect(result.positions).toHaveLength(5);
    expect(new Set(result.positions.map((p) => p.symbol))).toEqual(new Set(["JTO", "AAVE", "XPL"]));

    const jtoLots = result.positions.filter((p) => p.symbol === "JTO");
    const xplLots = result.positions.filter((p) => p.symbol === "XPL");
    const aaveLots = result.positions.filter((p) => p.symbol === "AAVE");
    expect(jtoLots.map((p) => p.entryPrice).sort()).toEqual([0.6179, 0.61828]);
    expect(xplLots.map((p) => p.entryPrice).sort()).toEqual([0.0916, 0.0929]);
    expect(aaveLots).toHaveLength(1);
    expect(aaveLots[0]!.entryPrice).toBeCloseTo(95.33);

    const report = runDiagnostics(document, "https://pro.kraken.com/prop/account/x/portfolio");
    expect(report.groups).toHaveLength(3);
    expect(report.parsedPositionCount).toBe(5);
  });

  it("parses production-style column rows without per-row labels", () => {
    loadFixture("production-column-positions.html");
    const result = parsePositionsFromDocument(document);
    expect(result.positions).toHaveLength(5);
    expect(new Set(result.positions.map((p) => p.symbol))).toEqual(new Set(["JTO", "AAVE", "XPL"]));
    expect(result.positions.filter((p) => p.symbol === "JTO")).toHaveLength(2);
    expect(result.positions.filter((p) => p.symbol === "AAVE")).toHaveLength(1);
    expect(result.positions.filter((p) => p.symbol === "XPL")).toHaveLength(2);

    const totalNetPnl = result.positions.reduce((sum, p) => sum + p.netPnl, 0);
    expect(totalNetPnl).toBeCloseTo(10.04);
    expect(result.positions.some((p) => p.valueUsd === 607.84)).toBe(false);
  });

  it("discovers previously unseen symbols without using SYMBOL_MAP or the watchlist", () => {
    document.body.innerHTML = `
      <section>
        <h2>Open positions</h2>
        <div class="positions-container">
          ${["LINK", "ONDO", "TAO", "ZZTEST"].map(
            (symbol, i) => `
              <div class="pos-summary">
                <div>${symbol}</div>
                <div>Value ${100 + i}.00 USD</div>
                <div>Opening price ${10 + i}.00 USD</div>
                <div>Current price ${10 + i}.10 USD</div>
              </div>
              <div class="pos-child">
                <div>${symbol}</div><div>2x</div><div>Long</div>
                <div>Value ${100 + i}.00 USD</div>
                <div>Opening price ${10 + i}.00 USD</div>
                <div>Current price ${10 + i}.10 USD</div>
                <button aria-label="Close position">&times;</button>
              </div>`
          ).join("")}
        </div>
      </section>`;
    const result = parsePositionsFromDocument(document);
    expect(result.positions.map((p) => p.symbol).sort()).toEqual(["LINK", "ONDO", "TAO", "ZZTEST"]);
  });
});
