// =============================================================================
// KEYLESS live config (client). Fetches the public market/product map + endpoint +
// chainId + ws url from /api/nado/state (which no longer touches any key). This is all
// the browser needs to run the in-tab live path; the COHORT itself comes from in-tab
// custody, not from here. Cached per page load.
// =============================================================================
import type { Market } from "@farm/adapter-api";
import { activeChainId } from "./chainEnv";

export interface LiveProductVM {
  marketId: string; productId: number; symbol: string; kind: "perp" | "spot";
  tickSize: string; stepSize: string; minSize: string;
  minNotional?: string; // HUMAN min order notional (USDT0); absent on offline-mock products
}

export interface LiveConfig {
  enabled: boolean;
  chainId?: number;
  endpoint?: string;
  wsSubscribeUrl?: string;
  defaultProduct?: LiveProductVM;
  markets?: Market[];
  products?: LiveProductVM[];
  error?: string;
}

let cfgP: Promise<LiveConfig> | null = null;
let configChainId: number | undefined;

export function getLiveConfig(force = false): Promise<LiveConfig> {
  const chainId = activeChainId();
  if (force || configChainId !== chainId) { cfgP = null; configChainId = chainId; }
  if (!cfgP) {
    const request: Promise<LiveConfig> = fetch("/api/nado/state", { cache: "no-store", signal: AbortSignal.timeout(15_000) })
      .then((r) => { if (!r.ok) throw new Error("无法获取连接状态，请重试。"); return r.json() as Promise<LiveConfig>; })
      .catch(() => {
        if (cfgP === request) cfgP = null;
        return { enabled: false, error: "连接失败或超时，请检查本地服务及网络后重试。" };
      });
    cfgP = request;
  }
  return cfgP;
}

/** Look up a product by marketId (falls back to the default product). */
export function productFor(cfg: LiveConfig, marketId?: string): LiveProductVM | undefined {
  if (marketId) {
    const p = (cfg.products ?? []).find((x) => x.marketId === marketId);
    if (p) return p;
  }
  return cfg.defaultProduct;
}
