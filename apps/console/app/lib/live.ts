// =============================================================================
// Client-side LIVE bridge (Stage 2b). The cohort lives in the OPERATOR'S TAB:
// "is this wallet live" is membership in the IN-TAB custody cohort, and the live fleet
// state is built CLIENT-SIDE — public config from the keyless /state, per-wallet reads
// through the keyless relay. Orders AND funding (deposit/withdraw) now sign in-tab (see
// liveContext); the server holds NO key and does NO signing. This module makes no
// signing server call — it only assembles the fleet VM from the in-tab cohort + reads.
// =============================================================================
import type { WalletVM, AccountVM, AccountKind } from "@farm/ui";
import { computeReadiness } from "@farm/ui";
import type { Address, Order, Balance, Position, Market, Decimal } from "@farm/adapter-api";
import { getLiveConfig } from "./liveConfig";
import type { LiveProductVM } from "./liveConfig";
import { cohortWallets, listAccounts } from "./custody";
import { readWalletLive } from "./liveContext";

export const LIVE_COHORT = "LIVE";
export const LOCAL_COHORT = "LOCAL";
export type { LiveProductVM };

// Each live wallet carries its OWNING account identity (slug/name/kind), so the home page groups
// wallets by their real account in the sidebar filter — not one synthetic "live" bucket.
export interface LiveWallet {
  walletId: string; address: string; subaccount?: string;
  accountSlug: string; accountName: string; accountKind: AccountKind;
  openOrders?: Order[]; balances?: Balance[]; positions?: Position[]; native?: Decimal;
}

// Native (ETH) gas needed to run the on-chain funding bootstrap (approve + deposit) once. Matches the
// fund-cohort script's GAS_EACH; below it a wallet can still trade (orders are gasless) but can't
// self-fund on-chain, so it displays `funded` rather than `ready` — the gas-refuel target set.
const GAS_FLOOR_ETH = 0.00003;
export interface LiveState {
  enabled: boolean;
  onlineAvailable?: boolean;
  chainId?: number;
  endpoint?: string;           // Nado Endpoint addr — the StreamAuthentication verifyingContract
  wsSubscribeUrl?: string;
  defaultProduct?: LiveProductVM;
  markets?: Market[];
  wallets?: LiveWallet[];       // the in-tab cohort (client source of truth)
  accounts?: AccountVM[];       // the real vault accounts (home sidebar filter dimension)
  locked?: boolean;             // live is enabled but the in-tab cohort is not unlocked yet
  error?: string;
}

// The in-tab cohort ids — the single source of truth for "is this wallet live".
const liveIds = new Set<string>();
export function isLiveWallet(w: { id: string }): boolean { return liveIds.has(w.id); }

/** Local wallet identities are available independently of the Nado connection. */
export function localWalletState(): LiveState {
  const coh = cohortWallets();
  return {
    enabled: false,
    wallets: coh.map((c) => ({
      walletId: c.walletId, address: c.address, subaccount: c.subaccountHex,
      accountSlug: c.accountSlug, accountName: c.accountName, accountKind: c.accountKind,
    })),
    accounts: listAccounts().map((a) => ({ id: a.slug, name: a.name, kind: a.kind, walletCount: a.walletCount })),
    locked: coh.length === 0,
  };
}

let refreshId = 0;

/** Build the live fleet state CLIENT-SIDE from the keyless public config + the in-tab cohort
 *  IDENTITIES only — NO per-wallet reads here. A read-all on mount/unlock was an O(N) burst
 *  (2N limiter acquires) that backlogged at scale (the one remaining O(N) cold-start). The
 *  budget-paced sweep + the WS-targeted reconcile fill in each wallet's reads lazily instead
 *  (first-screen wallets first — the sweep walks the cohort in order). Empty cohort (locked) →
 *  no live cards, correct for in-browser custody (nothing is live until the operator unlocks). */
export async function fetchLiveState(force = false): Promise<LiveState> {
  const requestId = ++refreshId;
  const cfg = await getLiveConfig(force);
  const local = localWalletState();
  if (requestId !== refreshId) return local;
  liveIds.clear();
  // An unavailable live API must not hide local custody or enable trading controls.
  if (!cfg.enabled || cfg.error || !cfg.chainId || !cfg.endpoint || !cfg.wsSubscribeUrl) {
    return { ...local, onlineAvailable: cfg.enabled, error: cfg.error };
  }
  for (const w of local.wallets ?? []) liveIds.add(w.walletId);
  return {
    ...local,
    enabled: true, onlineAvailable: true, chainId: cfg.chainId, endpoint: cfg.endpoint, wsSubscribeUrl: cfg.wsSubscribeUrl,
    defaultProduct: cfg.defaultProduct, markets: cfg.markets,
  };
}

/** Re-read ONE wallet (targeted reconcile). This is the per-wallet replacement for the
 *  full-cohort re-read a WS event used to trigger — so read cost is O(active wallets), not
 *  O(cohort). A fill/position_change names its subaccount, so only that wallet reconciles. */
export async function reconcileWallet(walletId: string): Promise<{ walletId: string; openOrders?: Order[]; balances?: Balance[]; positions?: Position[]; native?: Decimal }> {
  const reads = await readWalletLive(walletId);
  return { walletId, ...reads };
}

/** Merge a single reconciled wallet back into the live state (identity preserved, others untouched). */
export function mergeWallet(state: LiveState, upd: { walletId: string; openOrders?: Order[]; balances?: Balance[]; positions?: Position[]; native?: Decimal }): LiveState {
  if (!state.wallets) return state;
  return {
    ...state,
    wallets: state.wallets.map((w) =>
      w.walletId === upd.walletId
        ? { ...w, openOrders: upd.openOrders ?? w.openOrders, balances: upd.balances ?? w.balances, positions: upd.positions ?? w.positions, native: upd.native ?? w.native }
        : w,
    ),
  };
}

/** One briefing card per INDEPENDENT live EOA, from the in-tab cohort. */
export function liveWalletVMs(state: LiveState): WalletVM[] {
  if (!state.wallets) return [];
  return state.wallets.map((w, i) => {
    const quote = w.balances?.find((b) => b.scope === "margin");
    const address: Address = { family: "evm", value: w.address as `0x${string}` };
    // Readiness derives from the REPORTED quote collateral + native gas (never read → treated as 0,
    // so a wallet shows `unfunded` until its first reconcile lands, not a false `ready`).
    const readiness = computeReadiness({
      quote: Number(quote?.total ?? 0),
      native: Number(w.native ?? 0),
      gasFloor: GAS_FLOOR_ETH,
    });
    return {
      id: w.walletId, accountId: w.accountSlug, accountName: w.accountName, accountKind: w.accountKind,
      index: i, address, cohorts: [state.enabled ? LIVE_COHORT : LOCAL_COHORT],
      nativeBalance: w.native ?? "—", quoteBalance: quote?.total ?? "—",
      status: state.enabled ? "active" : "idle", readiness, openOrders: w.openOrders?.length ?? 0,
    };
  });
}
