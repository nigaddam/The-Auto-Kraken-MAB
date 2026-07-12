import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMarketDataTable } from "../src/background/market-data-table";
import { DEFAULT_SETTINGS } from "../src/shared/constants";
import type { TrackedPosition } from "../src/shared/types";

function makeOhlcResponse(pair: string) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const intervalSeconds = 60 * 60;
  // 32 completed hourly candles, oldest first, all fully in the past, plus
  // one still-forming "current" candle that must never be counted.
  const rows: [number, string, string, string, string, string, string, number][] = [];
  for (let i = 32; i >= 1; i--) {
    const openTime = nowSeconds - i * intervalSeconds;
    rows.push([openTime, "1.0", "1.01", "0.99", "1.0", "1.0", "1000", 5]);
  }
  // Forming candle: opened recently, has not closed yet.
  rows.push([nowSeconds - 60, "1.0", "1.0", "1.0", "1.0", "1.0", "10", 1]);

  return {
    error: [],
    result: { [pair]: rows, last: nowSeconds },
  };
}

function makeTickerResponse(pair: string, price: string) {
  return { error: [], result: { [pair]: { c: [price, "1.0"] } } };
}

function makeTrackedPosition(symbol: string, fingerprint: string): TrackedPosition {
  return {
    fingerprint,
    symbol,
    side: "LONG",
    openingPrice: 1,
    openingValueUsd: 500,
    firstObservedAt: Date.now(),
    lastSeenAt: Date.now(),
    status: "ACTIVE",
    latest: null,
    latestApiPrice: null,
    latestApiPriceAt: null,
    highestObservedPrice: 1,
    peakReturnPct: 0,
    profitFloorPct: null,
    smaFast: null,
    smaSlow: null,
    trend: "UNKNOWN",
    consecutiveClosesBelowSmaFast: 0,
    lastProcessedCandleTs: null,
    decision: "HOLD",
    reason: "",
    autoCloseDisabledReason: null,
  };
}

describe("buildMarketDataTable", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((url: string | URL) => {
      const u = url.toString();
      if (u.includes("/AssetPairs")) {
        return new Response(
          JSON.stringify({
            error: [],
            result: {
              LINKUSD: { altname: "LINKUSD", wsname: "LINK/USD" },
              ONDOUSD: { altname: "ONDOUSD", wsname: "ONDO/USD" },
            },
          }),
          { status: 200 }
        );
      }
      if (u.includes("/OHLC")) {
        const pair = new URL(u).searchParams.get("pair")!;
        return new Response(JSON.stringify(makeOhlcResponse(pair)), { status: 200 });
      }
      if (u.includes("/Ticker")) {
        const pair = new URL(u).searchParams.get("pair")!;
        return new Response(JSON.stringify(makeTickerResponse(pair, "1.05")), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("produces one row per unique symbol, not per lot", async () => {
    const positions: Record<string, TrackedPosition> = {
      xploA: makeTrackedPosition("XPL", "xploA"),
      xploB: makeTrackedPosition("XPL", "xploB"),
      jtoA: makeTrackedPosition("JTO", "jtoA"),
    };
    const table = await buildMarketDataTable(DEFAULT_SETTINGS, positions, Date.now());
    // XPL (one row despite two lots) + JTO, at minimum.
    expect(table["XPL"]).toBeDefined();
    expect(table["JTO"]).toBeDefined();
    expect(Object.keys(table).filter((s) => s === "XPL")).toHaveLength(1);
  });

  it("marks detected-position symbols DETECTED_POSITION and others WATCHLIST", async () => {
    const positions: Record<string, TrackedPosition> = {
      jtoA: makeTrackedPosition("JTO", "jtoA"),
    };
    const table = await buildMarketDataTable(DEFAULT_SETTINGS, positions, Date.now());
    expect(table["JTO"]!.source).toBe("DETECTED_POSITION");
    // XPL isn't a real detected position here, but is still present via the
    // developer watchlist, clearly labeled as such.
    expect(table["XPL"]!.source).toBe("WATCHLIST");
  });

  it("still populates the watchlist symbols when there are zero detected positions", async () => {
    const table = await buildMarketDataTable(DEFAULT_SETTINGS, {}, Date.now());
    expect(table["XPL"]).toBeDefined();
    expect(table["XPL"]!.source).toBe("WATCHLIST");
    expect(table["JTO"]).toBeDefined();
    expect(table["JTO"]!.source).toBe("WATCHLIST");
  });

  it("excludes the still-forming candle from completedCandleCount and SMA", async () => {
    const table = await buildMarketDataTable(DEFAULT_SETTINGS, {}, Date.now());
    // 32 fully-completed candles were served; the 33rd (forming) row must
    // never be counted.
    expect(table["XPL"]!.completedCandleCount).toBe(32);
    expect(table["XPL"]!.formingCandleExcluded).toBe(true);
  });

  it("reports the current API price and status without any API key configuration", async () => {
    const table = await buildMarketDataTable(DEFAULT_SETTINGS, {}, Date.now());
    expect(table["XPL"]!.currentApiPrice).toBeCloseTo(1.05);
    expect(table["XPL"]!.apiStatus).toBe("OK");
    // Confirm the calls hit only Kraken's public endpoints.
    for (const call of fetchMock.mock.calls) {
      const calledUrl = String(call[0]);
      expect(calledUrl).toMatch(/^https:\/\/api\.kraken\.com\/0\/public\/(OHLC|Ticker|AssetPairs)/);
      expect(calledUrl).not.toMatch(/key|secret|token/i);
    }
  });

  it("creates detected market rows for dynamically resolved symbols", async () => {
    const positions: Record<string, TrackedPosition> = {
      linkA: makeTrackedPosition("LINK", "linkA"),
      ondoA: makeTrackedPosition("ONDO", "ondoA"),
    };
    const table = await buildMarketDataTable(DEFAULT_SETTINGS, positions, Date.now());
    expect(table["LINK"]!.source).toBe("DETECTED_POSITION");
    expect(table["LINK"]!.apiMarket).toBe("LINK/USD");
    expect(table["LINK"]!.apiStatus).toBe("OK");
    expect(table["ONDO"]!.source).toBe("DETECTED_POSITION");
    expect(table["ONDO"]!.apiMarket).toBe("ONDO/USD");
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/AssetPairs"))).toBe(true);
  });

  it("keeps an unresolved detected symbol visible as an error row", async () => {
    const positions: Record<string, TrackedPosition> = {
      unknownA: makeTrackedPosition("ZZTEST", "unknownA"),
    };
    const table = await buildMarketDataTable(DEFAULT_SETTINGS, positions, Date.now());
    expect(table["ZZTEST"]).toBeDefined();
    expect(table["ZZTEST"]!.source).toBe("DETECTED_POSITION");
    expect(table["ZZTEST"]!.apiStatus).toBe("ERROR");
    expect(table["ZZTEST"]!.errorMessage).toMatch(/No unambiguous Kraken USD market/i);
  });

  it("includes the user's Settings.watchlistCoins as WATCHLIST rows, alongside detected positions", async () => {
    const settings = { ...DEFAULT_SETTINGS, watchlistCoins: ["LINK"] };
    const positions: Record<string, TrackedPosition> = {
      jtoA: makeTrackedPosition("JTO", "jtoA"),
    };
    const table = await buildMarketDataTable(settings, positions, Date.now());
    expect(table["JTO"]!.source).toBe("DETECTED_POSITION");
    expect(table["LINK"]).toBeDefined();
    expect(table["LINK"]!.source).toBe("WATCHLIST");
    expect(table["LINK"]!.apiStatus).toBe("OK");
  });
});
