import { KRAKEN_PUBLIC_ASSET_PAIRS_URL } from "../shared/constants";

export interface SymbolMapping {
  /** e.g. "JTO/USD", human-readable */
  dataSymbol: string;
  /** Kraken public REST pair query param, e.g. "JTOUSD" */
  pairParam: string;
}

export type SymbolResolution =
  | ({ status: "SUPPORTED" } & SymbolMapping)
  | { status: "UNSUPPORTED"; reason: string };

interface KrakenAssetPair {
  altname?: string;
  wsname?: string;
  base?: string;
  quote?: string;
}

interface KrakenAssetPairsResponse {
  error: string[];
  result: Record<string, KrakenAssetPair>;
}

const DYNAMIC_SYMBOL_CACHE_KEY = "kraken_guard_dynamic_symbol_map";

/** Explicit overrides for Kraken naming mismatches and known pairs. This is
 * not a DOM-discovery allowlist; row discovery must never depend on it. */
export const SYMBOL_MAP: Record<string, SymbolMapping> = {
  JTO: { dataSymbol: "JTO/USD", pairParam: "JTOUSD" },
  XPL: { dataSymbol: "XPL/USD", pairParam: "XPLUSD" },
  BTC: { dataSymbol: "BTC/USD", pairParam: "XBTUSD" },
  ETH: { dataSymbol: "ETH/USD", pairParam: "ETHUSD" },
  SOL: { dataSymbol: "SOL/USD", pairParam: "SOLUSD" },
};

function normalizeDomSymbol(uiSymbol: string): string | null {
  const symbol = uiSymbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(symbol)) return null;
  return symbol;
}

async function readCachedMappings(): Promise<Record<string, SymbolMapping>> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return {};
  const stored = await chrome.storage.local.get(DYNAMIC_SYMBOL_CACHE_KEY);
  return (stored[DYNAMIC_SYMBOL_CACHE_KEY] as Record<string, SymbolMapping> | undefined) ?? {};
}

async function writeCachedMapping(symbol: string, mapping: SymbolMapping): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  const current = await readCachedMappings();
  await chrome.storage.local.set({ [DYNAMIC_SYMBOL_CACHE_KEY]: { ...current, [symbol]: mapping } });
}

async function fetchAssetPairs(): Promise<Record<string, KrakenAssetPair>> {
  const response = await fetch(KRAKEN_PUBLIC_ASSET_PAIRS_URL);
  if (!response.ok) {
    throw new Error(`Kraken AssetPairs request failed: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as KrakenAssetPairsResponse;
  if (payload.error.length > 0) {
    throw new Error(`Kraken AssetPairs API error: ${payload.error.join(", ")}`);
  }
  return payload.result;
}

function findUsdPair(symbol: string, pairs: Record<string, KrakenAssetPair>): SymbolMapping | null {
  const entries = Object.entries(pairs);
  const candidates = entries
    .map(([pairParam, pair]) => ({ pairParam, pair }))
    .filter(({ pair }) => {
      const wsname = pair.wsname?.toUpperCase();
      const altname = pair.altname?.toUpperCase();
      return wsname === `${symbol}/USD` || altname === `${symbol}USD`;
    });

  if (candidates.length === 1) {
    const chosen = candidates[0]!;
    return {
      dataSymbol: chosen.pair.wsname ?? `${symbol}/USD`,
      pairParam: chosen.pair.altname ?? chosen.pairParam,
    };
  }

  const exactSpot = candidates.filter(({ pair }) => pair.wsname?.toUpperCase() === `${symbol}/USD`);
  if (exactSpot.length === 1) {
    const chosen = exactSpot[0]!;
    return {
      dataSymbol: chosen.pair.wsname ?? `${symbol}/USD`,
      pairParam: chosen.pair.altname ?? chosen.pairParam,
    };
  }

  return null;
}

export async function resolvePublicMarket(uiSymbol: string): Promise<SymbolResolution> {
  const symbol = normalizeDomSymbol(uiSymbol);
  if (!symbol) return { status: "UNSUPPORTED", reason: `Invalid DOM symbol: ${uiSymbol}` };

  const override = SYMBOL_MAP[symbol];
  if (override) return { status: "SUPPORTED", ...override };

  const cached = (await readCachedMappings())[symbol];
  if (cached) return { status: "SUPPORTED", ...cached };

  try {
    const pairs = await fetchAssetPairs();
    const mapping = findUsdPair(symbol, pairs);
    if (!mapping) {
      return { status: "UNSUPPORTED", reason: `No unambiguous Kraken USD market found for ${symbol}.` };
    }
    await writeCachedMapping(symbol, mapping);
    return { status: "SUPPORTED", ...mapping };
  } catch (err) {
    return { status: "UNSUPPORTED", reason: err instanceof Error ? err.message : String(err) };
  }
}

export function resolveSymbol(uiSymbol: string): SymbolResolution {
  const symbol = normalizeDomSymbol(uiSymbol);
  if (!symbol) return { status: "UNSUPPORTED", reason: `Invalid DOM symbol: ${uiSymbol}` };
  const mapping = SYMBOL_MAP[symbol];
  if (!mapping) return { status: "UNSUPPORTED", reason: `No static mapping for ${symbol}.` };
  return { status: "SUPPORTED", ...mapping };
}
