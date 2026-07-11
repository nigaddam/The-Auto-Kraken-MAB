import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parsePositionsFromDocument } from "../src/content/position-parser";

function loadFixture(name: string): void {
  const html = readFileSync(join(__dirname, "fixtures", name), "utf-8");
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("parsePositionsFromDocument", () => {
  it("parses two distinct LONG positions with exact symbol matching", () => {
    loadFixture("positions-basic.html");
    const { positions, unparsedRowCount } = parsePositionsFromDocument(document);
    expect(unparsedRowCount).toBe(0);
    expect(positions).toHaveLength(2);

    const jto = positions.find((p) => p.symbol === "JTO");
    expect(jto).toBeDefined();
    expect(jto?.side).toBe("LONG");
    expect(jto?.entryPrice).toBeCloseTo(0.61828);
    expect(jto?.currentPriceUi).toBeCloseTo(0.5987);
    expect(jto?.valueUsd).toBeCloseTo(500);
    expect(jto?.upnl).toBeCloseTo(-15.75);
    expect(jto?.netPnl).toBeCloseTo(-16.2);
    expect(jto?.leverage).toBeCloseTo(3);

    const xpl = positions.find((p) => p.symbol === "XPL");
    expect(xpl).toBeDefined();
    expect(xpl?.entryPrice).toBeCloseTo(0.095);
  });

  it("does not double-count a summary row plus its expanded actionable child row", () => {
    loadFixture("positions-summary-and-child.html");
    const { positions } = parsePositionsFromDocument(document);
    expect(positions).toHaveLength(1);
    expect(positions[0]?.symbol).toBe("JTO");
  });

  it("reports duplicate actionable rows for the same symbol as-is (ambiguity is resolved by the caller)", () => {
    loadFixture("positions-duplicate-symbol.html");
    const { positions } = parsePositionsFromDocument(document);
    expect(positions).toHaveLength(2);
    expect(positions.every((p) => p.symbol === "JTO")).toBe(true);
  });

  it("skips a row with a missing core field rather than guessing a value", () => {
    loadFixture("positions-malformed.html");
    const { positions, unparsedRowCount } = parsePositionsFromDocument(document);
    expect(positions).toHaveLength(0);
    expect(unparsedRowCount).toBe(1);
  });

  it("correctly identifies SHORT vs LONG side", () => {
    loadFixture("positions-short.html");
    const { positions } = parsePositionsFromDocument(document);
    expect(positions).toHaveLength(1);
    expect(positions[0]?.side).toBe("SHORT");
  });

  it("returns no positions when there is no positions container at all", () => {
    document.body.innerHTML = "<div>Nothing here</div>";
    const { positions, unparsedRowCount } = parsePositionsFromDocument(document);
    expect(positions).toHaveLength(0);
    expect(unparsedRowCount).toBe(0);
  });
});
