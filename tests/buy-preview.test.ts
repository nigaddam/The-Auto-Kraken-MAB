import { describe, expect, it } from "vitest";
import { confirmValidatedBuyOrder, openKrakenBuyOrder, validateBuyModal } from "../src/content/buy-preview";

/** Mirrors the real Kraken confirmation modal observed live on 2026-07-12:
 * "Market long 0.001 BTC ... Cancel | Confirm", with a "Don't show this
 * confirmation again" checkbox this extension must never touch. */
function buyModalFixture(options: { quantity?: string; symbol?: string; action?: string } = {}): string {
  const quantity = options.quantity ?? "0.001";
  const symbol = options.symbol ?? "BTC";
  const action = options.action ?? "Market long";
  return `
    <div role="dialog" aria-modal="true">
      <h2>${action}</h2>
      <div>${quantity}${symbol} 5x</div>
      <div>at market price = 64,100 USD</div>
      <div>Total ≈ 64.1 USD</div>
      <label><input type="checkbox" /> Don't show this confirmation again.</label>
      <button>Cancel</button>
      <button>Confirm</button>
    </div>
  `;
}

/** Mirrors the real Kraken Trade-page order form, already in a state where
 * Buy + Market are selected (aria-selected="true") so tests can focus on
 * the quantity-fill + submit + modal-validation behavior without also
 * exercising the tab-click branches (covered separately below). */
function tradeFormFixture(): string {
  return `
    <div data-testid="order-panel">
      <div role="tablist">
        <button aria-selected="true">Buy</button>
        <button aria-selected="false">Sell</button>
      </div>
      <div role="tablist">
        <button aria-selected="true">Market</button>
        <button aria-selected="false">Limit</button>
      </div>
      <div>
        <div>Quantity</div>
        <div><input type="text" value="0.1" /><span>BTC</span></div>
      </div>
      <button aria-label="Submit order">Long (buy) BTC</button>
    </div>
  `;
}

describe("validateBuyModal", () => {
  it("accepts a real Market-long confirmation modal with matching quantity", () => {
    document.body.innerHTML = buyModalFixture();
    const result = validateBuyModal(document, "BTC", 0.001);
    expect(result.ready).toBe(true);
    expect(result.confidence).toBe("HIGH");
    expect(result.actionMatched).toBe(true);
    expect(result.quantityMatched).toBe(true);
    expect(result.finalButtonMatched).toBe(true);
    expect(result.conflictingActionFound).toBe(false);
  });

  it("blocks when the modal's quantity does not match what was set", () => {
    document.body.innerHTML = buyModalFixture({ quantity: "0.005" });
    const result = validateBuyModal(document, "BTC", 0.001);
    expect(result.ready).toBe(false);
    expect(result.quantityMatched).toBe(false);
  });

  it("blocks on conflicting short/sell/close wording", () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true">
        <h2>Market long</h2>
        <div>0.001BTC 5x</div>
        <div>Warning: this will also close your existing short position.</div>
        <button>Confirm</button>
      </div>
    `;
    const result = validateBuyModal(document, "BTC", 0.001);
    expect(result.ready).toBe(false);
    expect(result.conflictingActionFound).toBe(true);
  });

  it("blocks when more than one Confirm button exists", () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true">
        <h2>Market long</h2>
        <div>0.001BTC 5x</div>
        <button>Confirm</button>
        <button>Confirm</button>
      </div>
    `;
    const result = validateBuyModal(document, "BTC", 0.001);
    expect(result.ready).toBe(false);
    expect(result.finalButtonMatched).toBe(false);
  });

  it("blocks when more than one modal references the symbol", () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true">Market long 0.001BTC <button>Confirm</button></div>
      <div role="dialog" aria-modal="true">Another BTC dialog <button>Confirm</button></div>
    `;
    const result = validateBuyModal(document, "BTC", 0.001);
    expect(result.ready).toBe(false);
    expect(result.modalTextExcerpt).toMatch(/BTC/);
  });

  it("never reports the 'don't show again' checkbox as the final control", () => {
    document.body.innerHTML = buyModalFixture();
    const result = validateBuyModal(document, "BTC", 0.001);
    expect(result.finalControlText?.toLowerCase()).not.toContain("don't show");
  });
});

describe("confirmValidatedBuyOrder", () => {
  it("clicks the Confirm button when the modal validates ready", () => {
    document.body.innerHTML = buyModalFixture();
    const confirmBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Confirm"
    ) as HTMLButtonElement;
    let clicked = false;
    confirmBtn.addEventListener("click", () => {
      clicked = true;
    });
    const result = confirmValidatedBuyOrder(document, "BTC", 0.001);
    expect(result.clicked).toBe(true);
    expect(clicked).toBe(true);
  });

  it("never clicks anything and dismisses via Escape when the modal is not ready", () => {
    document.body.innerHTML = buyModalFixture({ quantity: "9.999" }); // mismatched quantity
    let escapeDispatched = false;
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") escapeDispatched = true;
    });
    const result = confirmValidatedBuyOrder(document, "BTC", 0.001);
    expect(result.clicked).toBe(false);
    expect(escapeDispatched).toBe(true);
  });
});

describe("openKrakenBuyOrder", () => {
  it("fills the quantity, clicks submit, and validates the resulting modal", async () => {
    document.body.innerHTML = tradeFormFixture();
    const submitBtn = document.querySelector<HTMLButtonElement>('[aria-label="Submit order"]')!;
    submitBtn.addEventListener("click", () => {
      // Simulate Kraken rendering the confirmation modal synchronously
      // after submit, using the quantity we just set.
      const quantity = document.querySelector<HTMLInputElement>("input")!.value;
      document.body.insertAdjacentHTML("beforeend", buyModalFixture({ quantity }));
    });

    const report = await openKrakenBuyOrder(document, "BTC", 0.05);
    expect(report.ready).toBe(true);
    expect(report.quantitySet).toBeCloseTo(0.05, 6);
    expect(report.modalValidation?.ready).toBe(true);
  });

  it("blocks when the quantity input cannot be found", async () => {
    document.body.innerHTML = `
      <div data-testid="order-panel">
        <div role="tablist"><button aria-selected="true">Buy</button><button>Sell</button></div>
        <div role="tablist"><button aria-selected="true">Market</button><button>Limit</button></div>
        <button aria-label="Submit order">Long (buy) BTC</button>
      </div>
    `;
    const report = await openKrakenBuyOrder(document, "BTC", 0.05);
    expect(report.ready).toBe(false);
    expect(report.blockedReason).toMatch(/quantity/i);
  });

  it("blocks and never submits when the Market order-type control is ambiguous", async () => {
    document.body.innerHTML = `
      <div data-testid="order-panel">
        <div role="tablist"><button aria-selected="true">Buy</button><button>Sell</button></div>
        <div>
          <div>Quantity</div>
          <div><input type="text" value="0.1" /></div>
        </div>
        <button aria-label="Submit order">Long (buy) BTC</button>
      </div>
    `;
    let submitClicked = false;
    document.querySelector('[aria-label="Submit order"]')!.addEventListener("click", () => {
      submitClicked = true;
    });
    const report = await openKrakenBuyOrder(document, "BTC", 0.05);
    expect(report.ready).toBe(false);
    expect(report.blockedReason).toMatch(/Market order-type/i);
    expect(submitClicked).toBe(false);
  });

  it("blocks when the order entry panel does not reference the requested symbol", async () => {
    document.body.innerHTML = `
      <div data-testid="order-panel">
        <div role="tablist"><button aria-selected="true">Buy</button><button>Sell</button></div>
        <div role="tablist"><button aria-selected="true">Market</button><button>Limit</button></div>
        <div>Quantity</div>
        <div><input type="text" value="0.1" /></div>
        <button aria-label="Submit order">Long (buy) JTO</button>
      </div>
    `;
    const report = await openKrakenBuyOrder(document, "BTC", 0.05);
    expect(report.ready).toBe(false);
    expect(report.blockedReason).toMatch(/wrong page/i);
  });
});
