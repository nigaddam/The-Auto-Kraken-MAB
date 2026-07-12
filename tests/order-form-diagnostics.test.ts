import { describe, expect, it } from "vitest";
import { readAccountEquitySnapshot, runOrderFormDiagnostics } from "../src/content/order-form-diagnostics";

/** Mirrors the real Kraken Prop Trade-page structure confirmed via a live
 * Order-Form Diagnostics run (2026-07-12): the Buy/Sell tabs are bare
 * <button> elements with no aria-label, the Quantity input has no
 * aria-label/placeholder/name/data-testid at all (only a nearby text
 * label), and the true submit button's accessible text also contains the
 * word "buy" (same as the Buy tab), which is exactly what caused the
 * pre-fix ambiguous-submit-control bug. */
function realKrakenTradeFixture(): string {
  return `
    <div data-testid="order-panel">
      <div role="tablist">
        <button>Buy</button>
        <button>Sell</button>
      </div>
      <div role="tablist">
        <button aria-selected="true">Market</button>
        <button aria-selected="false">Limit</button>
      </div>
      <div>Available to trade</div>
      <div>19,137.2804 USD</div>
      <div>Leverage (2x)</div>
      <div>
        <div>Quantity</div>
        <div>
          <input type="text" value="0.1" />
          <span>JTO</span>
        </div>
      </div>
      <div>Total</div>
      <div>≈ 0.07 USD</div>
      <button>Long (buy) JTO</button>
    </div>
  `;
}

describe("runOrderFormDiagnostics against the real Kraken Trade-page structure", () => {
  it("finds the Buy/Sell tabs unambiguously", () => {
    document.body.innerHTML = realKrakenTradeFixture();
    const report = runOrderFormDiagnostics(document, "https://pro.kraken.com/prop/account/x/trade/jto-usd");
    expect(report.buyTabControl?.found).toBe(true);
    expect(report.buyTabControl?.ambiguous).toBe(false);
    expect(report.sellTabControl?.found).toBe(true);
  });

  it("finds the Quantity input via the label-anchored fallback when no aria attributes exist", () => {
    document.body.innerHTML = realKrakenTradeFixture();
    const report = runOrderFormDiagnostics(document, "https://pro.kraken.com/prop/account/x/trade/jto-usd");
    expect(report.quantityInputDetected).toBe(true);
    expect(report.quantityInputCurrentValue).toBe("0.1");
  });

  it("does not confuse the Buy tab with the true final submit button", () => {
    document.body.innerHTML = realKrakenTradeFixture();
    const report = runOrderFormDiagnostics(document, "https://pro.kraken.com/prop/account/x/trade/jto-usd");
    expect(report.submitControl?.found).toBe(true);
    expect(report.submitControl?.ambiguous).toBe(false);
    expect(report.submitControl?.accessibleName).toBe("Long (buy) JTO");
  });

  it("reads account equity separately from the order form", () => {
    document.body.innerHTML = `
      <div>Total equity</div>
      <div>9,963.01 USD</div>
    `;
    const parsed = readAccountEquitySnapshot(document);
    expect(parsed).toBe(9963.01);
  });

  it("returns null quantity input when no input exists at all (never guesses)", () => {
    document.body.innerHTML = `
      <div data-testid="order-panel">
        <button>Buy</button>
        <button>Sell</button>
        <div>Quantity</div>
      </div>
    `;
    const report = runOrderFormDiagnostics(document, "https://pro.kraken.com/prop/account/x/trade/jto-usd");
    expect(report.quantityInputDetected).toBe(false);
  });
});
