import { describe, expect, it } from "vitest";
import { confirmValidatedCloseModal, validateCloseModal } from "../src/content/close-preview";

describe("validateCloseModal", () => {
  it("accepts the real Kraken close modal wording with Sell-to-close evidence", () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true">
        <h2>Close position</h2>
        <div>Long AAVE</div>
        <div>1.00 AAVE</div>
        <p>Sell 1 AAVE for ~95.78 USD at Market Price of ~95.78 USD</p>
        <button>Close AAVE long position</button>
      </div>
    `;

    const result = validateCloseModal(document, "AAVE");
    expect(result.ready).toBe(true);
    expect(result.confidence).toBe("HIGH");
    expect(result.titleMatched).toBe(true);
    expect(result.symbolMatched).toBe(true);
    expect(result.sideMatched).toBe(true);
    expect(result.closeActionMatched).toBe(true);
    expect(result.quantityMatched).toBe(true);
    expect(result.finalButtonMatched).toBe(true);
    expect(result.conflictingActionFound).toBe(false);
    expect(result.actionEvidence).toBe("Sell AAVE");
    expect(result.finalControlText).toBe("Close AAVE long position");
  });

  it("blocks a modal that mentions opening or increasing exposure", () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true">
        <h2>Close position</h2>
        <p>Long AAVE Open Short or increase position size.</p>
        <button>Close AAVE long position</button>
      </div>
    `;

    const result = validateCloseModal(document, "AAVE");
    expect(result.ready).toBe(false);
    expect(result.blockedReason).toMatch(/open\/increase|add/i);
  });

  it("blocks when more than one matching modal is present", () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true">Close position Long AAVE Sell 1 AAVE <button>Close AAVE long position</button></div>
      <div role="dialog" aria-modal="true">Close position Long AAVE Sell 1 AAVE <button>Close AAVE long position</button></div>
    `;

    const result = validateCloseModal(document, "AAVE");
    expect(result.ready).toBe(false);
    expect(result.blockedReason).toMatch(/2 modal/);
  });

  it("blocks wrong symbols", () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true">
        <h2>Close position</h2>
        <div>Long SOL</div>
        <p>Sell 1 SOL for ~100 USD</p>
        <button>Close SOL long position</button>
      </div>
    `;

    const result = validateCloseModal(document, "AAVE");
    expect(result.ready).toBe(false);
    expect(result.blockedReason).toMatch(/0 modal/);
  });

  it("blocks buy wording even with a matching symbol", () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true">
        <h2>Close position</h2>
        <div>Long AAVE</div>
        <p>Buy 1 AAVE at market</p>
        <button>Close AAVE long position</button>
      </div>
    `;

    const result = validateCloseModal(document, "AAVE");
    expect(result.ready).toBe(false);
    expect(result.conflictingActionFound).toBe(true);
  });

  it("blocks missing final close button", () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true">
        <h2>Close position</h2>
        <div>Long AAVE</div>
        <p>Sell 1 AAVE for ~95.78 USD</p>
        <button>Cancel</button>
      </div>
    `;

    const result = validateCloseModal(document, "AAVE");
    expect(result.ready).toBe(false);
    expect(result.blockedReason).toMatch(/0 matching final close button/);
  });

  it("clicks the exact final button once after validation", () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true">
        <h2>Close position</h2>
        <div>Long AAVE</div>
        <p>Sell 1 AAVE for ~95.78 USD</p>
        <button id="final">Close AAVE long position</button>
      </div>
    `;
    let clicks = 0;
    document.getElementById("final")!.addEventListener("click", () => clicks++);

    const result = confirmValidatedCloseModal(document, "AAVE");
    expect(result.clicked).toBe(true);
    expect(result.validation.ready).toBe(true);
    expect(clicks).toBe(1);
  });
});
