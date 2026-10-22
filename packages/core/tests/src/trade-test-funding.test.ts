import { describe, expect, it } from "vitest";
import { createFundingState, fundingTotals, TradeFundingController, type FundingDepositEvent, type TestFundingAdapter } from "../../../../apps/console/app/lib/tradeTest/funding";
import { createTradeTestRun, DEFAULT_TEST_SETTINGS, X18 } from "../../../../apps/console/app/lib/tradeTest/planner";
import { MemoryTradeTestStore } from "../../../../apps/console/app/lib/tradeTest/store";
import { USDT0_ADDRESS, type FundsAdapter, type FundsAuthorization, type FundsPreparedTransaction, type FundsReceipt, type Hex } from "../../../../apps/console/app/lib/funds/types";
import type { AccountSnapshot, TestWallet, TradeTestRun } from "../../../../apps/console/app/lib/tradeTest/types";
import { createBrowserTradeTestAdapter, type BrowserTradeTestDependencies } from "../../../../apps/console/app/lib/tradeTest/browserAdapter";
import { NETWORKS } from "../../../../apps/console/app/lib/chainEnv";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const wallets: TestWallet[] = Array.from({ length: 10 }, (_, index) => ({ id: `live:${index}`, address: address(index + 1), label: `${index + 1}号` }));
const x = (n: number) => (BigInt(n) * X18).toString();
const dda = (wallet: TestWallet) => address(Number(wallet.id.split(":")[1]) + 101);

class Journal extends MemoryTradeTestStore {
  failWhen?: (after: TradeTestRun) => boolean;
  override async update(id: string, change: (run: TradeTestRun) => void) {
    const copy = structuredClone((await this.get(id))!); change(copy);
    if (this.failWhen?.(copy)) { this.failWhen = undefined; throw new Error("durability failure"); }
    return super.update(id, change);
  }
}
class FundingVenue implements TestFundingAdapter {
  clock = 1_800_000_000_000;
  token = 20_000_000n; eth = 1_000_000_000_000_000n;
  balances = new Map(wallets.map(wallet => [wallet.id, x(10)]));
  events = new Map<string, FundingDepositEvent[]>();
  receipts = new Map<Hex, FundsReceipt>();
  auths = new Map<Hex, FundsAuthorization>();
  prepared = new Map<Hex, FundsPreparedTransaction>();
  signatures = 0; preparations = 0; broadcasts: Hex[] = []; locks = 0;
  unknownAck = false; delayReceipt = false; delayCredit = false; badEvents = false; badHash = false; wrongDda = false; ddaPending = false;
  creditDeltaError = -1n;
  onPrepare?: () => Promise<void>;
  onSign?: () => Promise<void>;
  snapshotReads = 0; balanceReads = 0; mappingReads = 0;
  async assertIdentity(wallet: TestWallet, chainId: number) { if (chainId !== 57073 || !wallets.some(w => w.address === wallet.address && w.id === wallet.id)) throw new Error("wrong identity"); }
  async snapshot(wallet: TestWallet): Promise<AccountSnapshot> { this.snapshotReads++; const quote = this.balances.get(wallet.id)!; return { observedAt: this.clock, parentSender: `${wallet.address}${"64656661756c74".padEnd(24, "0")}`, quoteBalanceX18: quote, equityX18: quote, positions: [], openOrders: [], hasOtherCollateral: false, hasCrossPosition: false }; }
  async fundingBalance(wallet: TestWallet) { this.balanceReads++; return { observedAt: this.clock, parentSender: `${wallet.address}${"64656661756c74".padEnd(24, "0")}`, quoteBalanceX18: this.balances.get(wallet.id)! }; }
  async depositEvents(wallet: TestWallet) { return structuredClone(this.events.get(wallet.id) ?? []); }
  async getDepositAddress(wallet: TestWallet) { this.mappingReads++; return this.wrongDda ? address(999) : dda(wallet); }
  async readTreasury() { return { tokenUnits: this.token.toString(), ethWei: this.eth.toString() }; }
  async withTreasuryLock<T>(_address: string, task: () => Promise<T>) { this.locks++; try { return await task(); } finally { this.locks--; } }
  addCredit(a: FundsAuthorization) {
    const wallet = wallets.find(w => dda(w) === a.to)!;
    const delta = BigInt(a.value) * 10n ** 12n + this.creditDeltaError;
    this.balances.set(wallet.id, (BigInt(this.balances.get(wallet.id)!) + delta).toString());
    this.events.set(wallet.id, [{ submissionIndex: "100", at: this.clock, deltaX18: delta.toString() }]);
  }
  funds: FundsAdapter = {
    getChainId: async () => 57073,
    assertIdentity: async () => {}, assertTradingReady: async () => {},
    readWallet: async wallet => wallet.id.startsWith("dda:") ? { tokenUnits: this.ddaPending ? "1" : "0", ethWei: "0" } : this.readTreasury(),
    signAuthorization: async (_plan, _leg, a) => { this.signatures++; this.auths.set(a.nonce, structuredClone(a)); await this.onSign?.(); return `0x${"11".repeat(65)}`; },
    prepareTransaction: async (_plan, _leg, a) => { this.preparations++; const value = { hash: hash(this.preparations), rawTransaction: `0x${this.preparations.toString(16).padStart(2, "0")}` as Hex, nonce: String(this.preparations - 1), feeCeilingWei: "1000000" }; this.prepared.set(a.nonce, value); await this.onPrepare?.(); return value; },
    validatePreparedTransaction: async (_plan, _leg, a, tx) => { expect(this.prepared.get(a.nonce)).toEqual(tx); },
    broadcast: async raw => {
      expect(this.locks).toBe(1); this.broadcasts.push(raw);
      const entry = [...this.prepared].find(([, tx]) => tx.rawTransaction === raw)!;
      const a = this.auths.get(entry[0])!, tx = entry[1];
      if (!this.receipts.has(tx.hash)) {
        this.token -= BigInt(a.value); this.eth -= 1000n;
        this.receipts.set(tx.hash, { hash: tx.hash, status: "success", blockNumber: "100", blockTimestampMs: this.clock, gasUsed: "100", effectiveGasPrice: "9", l1FeeWei: "100", transfers: [{ token: USDT0_ADDRESS, from: a.from, to: a.to, value: a.value }], authorizations: this.badEvents ? [] : [{ authorizer: a.from, nonce: a.nonce }] });
        if (!this.delayCredit) this.addCredit(a);
      }
      if (this.unknownAck) throw new Error("timeout after submit");
      return tx.hash;
    },
    getReceipt: async tx => { const receipt = this.receipts.get(tx); return this.delayReceipt || !receipt ? null : { ...structuredClone(receipt), ...(this.badHash ? { hash: hash(999) } : {}) }; },
    authorizationUsed: async a => { const tx = this.prepared.get(a.nonce); return !!tx && this.receipts.has(tx.hash); },
    findAuthorizationReceipt: async a => { const tx = this.prepared.get(a.nonce); return this.delayReceipt || !tx ? null : structuredClone(this.receipts.get(tx.hash) ?? null); },
  };
}
async function setup(unfunded = 1) {
  const store = new Journal(), venue = new FundingVenue(); venue.balances.set(wallets[0]!.id, "5956275930735356621");
  for (let i = 1; i < unfunded; i++) venue.balances.set(wallets[i]!.id, "0");
  const run = createTradeTestRun(wallets, DEFAULT_TEST_SETTINGS, "simulation", 57073, "funding", venue.clock);
  run.funding = createFundingState(wallets[0]!, wallets.map(wallet => ({ wallet, requiredX18: "7017814000000000000", balanceX18: venue.balances.get(wallet.id)!, depositAddress: dda(wallet) })));
  await store.create(run);
  let sequence = 1000;
  const controller = () => new TradeFundingController(store, venue, { now: () => venue.clock, sleep: async ms => { venue.clock += ms; }, nonce: () => hash(++sequence), pollMs: 10, waitMs: 20 });
  return { store, venue, run, controller };
}

describe("treasury-funded Nado deposits", () => {
  it("rounds target up to 0.1U, uses conservative 5U per deposit, and computes treasury gap", () => {
    const state = createFundingState(wallets[0]!, [{ wallet: wallets[0]!, requiredX18: "7017814000000000000", balanceX18: "5956275930735356621", depositAddress: dda(wallets[0]!) }, { wallet: wallets[1]!, requiredX18: "7018840000000000000", balanceX18: "0", depositAddress: dda(wallets[1]!) }]);
    expect(state.rows.map(r => r.maxDepositUnits)).toEqual(["5000000", "7100000"]);
    expect(fundingTotals(state, { tokenUnits: "2000000", ethWei: "0" })).toMatchObject({ plannedUnits: "12100000", shortfallUnits: "10100000", requiredEthWei: "20000000000000" });
  });
  it("blocks the entire batch before signing when treasury USDT0 or ETH is short", async () => {
    for (const currency of ["token", "eth"] as const) {
      const { venue, run, controller, store } = await setup(); venue[currency] = 0n;
      expect(await controller().ensure(run.id)).toBe(false); expect(venue.signatures).toBe(0); expect(venue.broadcasts).toHaveLength(0);
      expect((await store.get(run.id))!.funding!.status).toBe("paused");
      expect((await store.get(run.id))!.funding!.rows.every(row => !row.authorization)).toBe(true);
    }
  });
  it("a treasury top-up next day can resume an unsigned insufficient-budget batch", async () => {
    const { venue, run, controller, store } = await setup(); venue.token = 0n;
    expect(await controller().ensure(run.id)).toBe(false);
    expect((await store.get(run.id))!.funding!.rows.every(row => !row.authorization)).toBe(true);
    venue.clock += 86_400_000; venue.token = 5_000_000n;
    expect(await controller().ensure(run.id)).toBe(true); expect(venue.signatures).toBe(1);
  });
  it("waiting overnight for one deposit leaves subsequent wallets' authorizations uncreated", async () => {
    const { venue, run, controller, store } = await setup(2); venue.delayCredit = true;
    expect(await controller().ensure(run.id)).toBe(false);
    expect((await store.get(run.id))!.funding!.rows[1]!.authorization).toBeUndefined();
    venue.clock += 86_400_000; venue.addCredit([...venue.auths.values()][0]!); venue.delayCredit = false;
    expect(await controller().ensure(run.id)).toBe(true);
    expect(venue.signatures).toBe(2); expect(venue.broadcasts).toHaveLength(2);
  });
  it("confirms exact chain events plus Nado deposit event, tolerating one X18 wei rounding", async () => {
    const { venue, run, controller, store } = await setup();
    expect(await controller().ensure(run.id)).toBe(true);
    const row = (await store.get(run.id))!.funding!.rows[0]!;
    expect(row).toMatchObject({ status: "credited", amountUnits: "5000000", actualFeeWei: "1000", creditedSubmissionIndex: "100" });
    expect(venue.signatures).toBe(1); expect(venue.broadcasts).toHaveLength(1);
    expect(await controller().ensure(run.id)).toBe(true); expect(venue.broadcasts).toHaveLength(1);
  });
  it("resumes an unknown submit result without a second payment, even when treasury was debited", async () => {
    const { venue, run, controller, store } = await setup(); venue.unknownAck = true; venue.token = 5_000_000n;
    expect(await controller().ensure(run.id)).toBe(false); expect(venue.token).toBe(0n);
    const hashBefore = (await store.get(run.id))!.funding!.rows[0]!.transaction!.hash;
    expect(await controller().ensure(run.id)).toBe(true);
    expect(venue.broadcasts).toHaveLength(1); expect(venue.preparations).toBe(1);
    expect((await store.get(run.id))!.funding!.rows[0]!.transaction!.hash).toBe(hashBefore);
  });
  it("waits for Nado credit without resending a confirmed payment", async () => {
    const { venue, run, controller, store } = await setup(); venue.delayCredit = true;
    expect(await controller().ensure(run.id)).toBe(false);
    expect((await store.get(run.id))!.funding!.rows[0]!.status).toBe("confirmed");
    expect(await controller().ensure(run.id)).toBe(false); expect(venue.broadcasts).toHaveLength(1);
    venue.addCredit([...venue.auths.values()][0]!);
    expect(await controller().ensure(run.id)).toBe(true); expect(venue.broadcasts).toHaveLength(1);
  });
  it("does not infer credit from balance alone or from a partial deposit event", async () => {
    const { venue, run, controller } = await setup(); venue.delayCredit = true;
    expect(await controller().ensure(run.id)).toBe(false);
    venue.balances.set(wallets[0]!.id, x(20));
    expect(await controller().ensure(run.id)).toBe(false);
    venue.events.set(wallets[0]!.id, [{ submissionIndex: "100", at: venue.clock, deltaX18: x(4) }]);
    expect(await controller().ensure(run.id)).toBe(false); expect(venue.broadcasts).toHaveLength(1);
  });
  it("rejects a changed DDA and a pre-existing unprocessed DDA balance before signing", async () => {
    for (const flag of ["wrongDda", "ddaPending"] as const) { const { venue, run, controller } = await setup(); venue[flag] = true; expect(await controller().ensure(run.id)).toBe(false); expect(venue.signatures).toBe(0); }
  });
  it("rejects a wrong receipt hash or missing AuthorizationUsed event", async () => {
    for (const flag of ["badEvents", "badHash"] as const) { const { venue, run, controller, store } = await setup(); venue[flag] = true; expect(await controller().ensure(run.id)).toBe(false); expect((await store.get(run.id))!.funding!.rows[0]!.status).not.toBe("credited"); expect(venue.broadcasts).toHaveLength(1); }
  });
  it("a used authorization without its receipt remains unresolved and is never paid again", async () => {
    const { venue, run, controller } = await setup(); venue.delayReceipt = true;
    expect(await controller().ensure(run.id)).toBe(false); expect(await controller().ensure(run.id)).toBe(false);
    expect(venue.signatures).toBe(1); expect(venue.broadcasts).toHaveLength(1);
  });
  it("stop after transaction preparation saves bytes but broadcasts nothing; resume reuses them", async () => {
    const { venue, run, controller, store } = await setup();
    venue.onPrepare = () => store.update(run.id, item => { item.stopRequested = true; }).then(() => {});
    expect(await controller().ensure(run.id)).toBe(false); expect(venue.broadcasts).toHaveLength(0);
    const prepared = (await store.get(run.id))!.funding!.rows[0]!.transaction!;
    await store.update(run.id, item => { item.stopRequested = false; });
    expect(await controller().ensure(run.id)).toBe(true); expect(venue.preparations).toBe(1); expect(venue.broadcasts).toEqual([prepared.rawTransaction]);
  });
  it("durability failure before intent prevents signing; failure before broadcast prevents sending", async () => {
    const a = await setup(); a.store.failWhen = run => run.funding!.rows[0]!.status === "intent";
    expect(await a.controller().ensure(a.run.id)).toBe(false); expect(a.venue.signatures).toBe(0);
    const b = await setup(); b.store.failWhen = run => run.funding!.rows[0]!.status === "broadcast";
    expect(await b.controller().ensure(b.run.id)).toBe(false); expect(b.venue.broadcasts).toHaveLength(0);
    const prepared = (await b.store.get(b.run.id))!.funding!.rows[0]!.transaction!;
    expect(await b.controller().ensure(b.run.id)).toBe(true); expect(b.venue.preparations).toBe(1); expect(b.venue.broadcasts).toEqual([prepared.rawTransaction]);
  });
  it("does not create replacement authorizations when the saved one expires", async () => {
    const { venue, run, controller, store } = await setup();
    venue.onSign = () => store.update(run.id, item => { item.stopRequested = true; }).then(() => {});
    expect(await controller().ensure(run.id)).toBe(false);
    await store.update(run.id, item => { item.stopRequested = false; }); venue.clock += 2_000_000;
    expect(await controller().ensure(run.id)).toBe(false); expect(venue.signatures).toBe(1); expect(venue.preparations).toBe(0);
  });
  it("skips an account already funded at runtime, but never exceeds frozen payment ceiling", async () => {
    const a = await setup(); a.venue.balances.set(wallets[0]!.id, x(10)); a.venue.token = 0n; a.venue.eth = 0n;
    expect(await a.controller().ensure(a.run.id)).toBe(true); expect(a.venue.signatures).toBe(0);
    const b = await setup(); b.venue.balances.set(wallets[0]!.id, "0");
    expect(await b.controller().ensure(b.run.id)).toBe(false); expect(b.venue.signatures).toBe(0);
  });
  it("rechecks a credited receipt before the first trade, and pauses if the proof disappears", async () => {
    const { venue, run, controller, store } = await setup();
    expect(await controller().ensure(run.id)).toBe(true); venue.delayReceipt = true;
    expect(await controller().ensure(run.id)).toBe(false);
    expect((await store.get(run.id))!.funding!.message).toMatch(/回执/); expect(venue.broadcasts).toHaveLength(1);
  });
  it("records the ETH cost of a reverted original transfer without replacing it", async () => {
    const { venue, run, controller, store } = await setup(); venue.unknownAck = true;
    expect(await controller().ensure(run.id)).toBe(false);
    const receipt = [...venue.receipts.values()][0]!; receipt.status = "reverted"; receipt.transfers = []; receipt.authorizations = [];
    expect(await controller().ensure(run.id)).toBe(false);
    expect((await store.get(run.id))!.funding!.rows[0]).toMatchObject({ status: "attention", actualFeeWei: "1000", receipt: { status: "reverted" } });
    expect(await controller().ensure(run.id)).toBe(false); expect(venue.broadcasts).toHaveLength(1);
  });
  it("rejects an old deposit event even if a later unrelated balance increase matches", async () => {
    const { venue, run, controller } = await setup(); venue.delayCredit = true;
    expect(await controller().ensure(run.id)).toBe(false); venue.addCredit([...venue.auths.values()][0]!);
    venue.events.get(wallets[0]!.id)![0]!.at -= 5000;
    expect(await controller().ensure(run.id)).toBe(false); expect(venue.broadcasts).toHaveLength(1);
  });
  it("persists the current read stage before network waits and reports chain-to-Nado transitions", async () => {
    const { venue, run, controller, store } = await setup();
    const originalDda = venue.getDepositAddress.bind(venue);
    let inspectedMapping = false, inspectedBalance = false;
    venue.getDepositAddress = async wallet => {
      const current = (await store.get(run.id))!;
      expect(current.progress).toMatchObject({ phase: "funding_check", walletId: wallet.id, total: 10 });
      expect(current.progress!.message).toMatch(/地址/);
      inspectedMapping = true;
      return originalDda(wallet);
    };
    const originalSnapshot = venue.snapshot.bind(venue);
    venue.snapshot = async wallet => {
      const current = (await store.get(run.id))!;
      if (!current.funding!.rows.some(row => row.authorization)) {
        expect(current.progress).toMatchObject({ phase: "funding_check", walletId: wallet.id, total: 10 });
        expect(current.progress!.message).toMatch(/余额/);
        inspectedBalance = true;
      }
      return originalSnapshot(wallet);
    };
    expect(await controller().ensure(run.id)).toBe(true);
    expect(inspectedMapping && inspectedBalance).toBe(true);
    const saved = (await store.get(run.id))!, originalHash = saved.funding!.rows[0]!.transaction!.hash;
    expect(saved.progress).toMatchObject({ phase: "credit", message: "所有账户入账已确认，可以重新预检并开始交易" });
    for (const message of [/正在提交/, /Ink 转账已确认/, /已核实全额到账/]) {
      expect(saved.events!.some(event => event.kind === "transition" && message.test(event.message) && event.txHash === originalHash)).toBe(true);
    }
    expect(JSON.stringify(saved.events)).not.toContain("rawTransaction");
    expect(JSON.stringify(saved.events)).not.toContain("signature");
  });
  it("keeps an unknown original receipt in its credit stage and resumes without another payment", async () => {
    const { venue, run, controller, store } = await setup(); venue.delayReceipt = true;
    expect(await controller().ensure(run.id)).toBe(false);
    const before = (await store.get(run.id))!, original = before.funding!.rows[0]!;
    expect(before.progress?.phase).toBe("credit");
    expect(before.events!.at(-1)).toMatchObject({ kind: "error", phase: "credit", txHash: original.transaction!.hash });
    expect(await controller().ensure(run.id)).toBe(false);
    venue.delayReceipt = false;
    expect(await controller().ensure(run.id)).toBe(true);
    const after = (await store.get(run.id))!.funding!.rows[0]!;
    expect(after.authorization).toEqual(original.authorization);
    expect(after.transaction).toEqual(original.transaction);
    expect(venue.signatures).toBe(1); expect(venue.preparations).toBe(1); expect(venue.broadcasts).toHaveLength(1);
  });
  it("does not flood the progress journal while polling an unchanged pending Nado credit", async () => {
    const { venue, run, store } = await setup(); venue.delayCredit = true;
    const controller = new TradeFundingController(store, venue, { now: () => venue.clock, sleep: async ms => { venue.clock += ms; }, nonce: () => hash(1001), pollMs: 10, waitMs: 2000 });
    expect(await controller.ensure(run.id)).toBe(false);
    const events = (await store.get(run.id))!.events!;
    expect(events.filter(event => event.phase === "credit").length).toBeLessThan(8);
    expect(events.filter(event => /Ink 转账已确认/.test(event.message))).toHaveLength(1);
    expect(venue.broadcasts).toHaveLength(1);
  });
  it("preserves the original Nado event time separately from a delayed local credit confirmation", async () => {
    const { venue, run, controller, store } = await setup(); venue.delayCredit = true;
    expect(await controller().ensure(run.id)).toBe(false);
    const receipt = [...venue.receipts.values()][0]!, actualCreditAt = receipt.blockTimestampMs + 7000;
    venue.clock += 600_000;
    venue.addCredit([...venue.auths.values()][0]!);
    venue.events.get(wallets[0]!.id)![0]!.at = actualCreditAt;
    expect(await controller().ensure(run.id)).toBe(true);
    const credited = (await store.get(run.id))!.funding!.rows[0]!;
    expect(credited.creditedEventAt).toBe(actualCreditAt);
    expect(credited.creditedAt).toBe(venue.clock);
    expect(credited.creditedAt! - credited.creditedEventAt!).toBeGreaterThan(500_000);
    venue.clock += 600_000;
    expect(await controller().ensure(run.id)).toBe(true);
    const restored = (await store.get(run.id))!.funding!.rows[0]!;
    expect(restored.creditedEventAt).toBe(actualCreditAt);
    expect(restored.creditedAt).toBe(credited.creditedAt);
    expect(venue.broadcasts).toHaveLength(1);
  });
  it("uses lightweight balances for budget and credit while keeping both pre-payment clean checks", async () => {
    const { venue, run, controller } = await setup();
    const originalSnapshot = venue.snapshot.bind(venue);
    venue.snapshot = async wallet => {
      if (venue.receipts.size) throw new Error("must not scan all markets after a confirmed payment");
      return originalSnapshot(wallet);
    };
    expect(await controller().ensure(run.id)).toBe(true);
    expect(venue.snapshotReads).toBe(2); // Resolve intent, then check once more immediately before signing.
    expect(venue.balanceReads).toBe(11); // Ten budget balances plus one actual credit balance.
    expect(venue.mappingReads).toBe(11); // Initial cohort mapping plus the fresh per-payment mapping.
    expect(await controller().ensure(run.id)).toBe(true);
    expect(venue.snapshotReads).toBe(2);
    expect(venue.broadcasts).toHaveLength(1);
  });
  it("re-reads a briefly stale clean snapshot without widening the five-second freshness boundary", async () => {
    const { venue, run, controller, store } = await setup();
    const originalSnapshot = venue.snapshot.bind(venue);
    venue.snapshot = async wallet => {
      const snapshot = await originalSnapshot(wallet);
      return venue.snapshotReads === 1 ? { ...snapshot, observedAt: venue.clock - 6000 } : snapshot;
    };
    expect(await controller().ensure(run.id)).toBe(true);
    expect(venue.snapshotReads).toBe(3);
    expect((await store.get(run.id))!.events!.some(event => /重新读取 1 \/ 2/.test(event.message))).toBe(true);
    expect(venue.signatures).toBe(1); expect(venue.broadcasts).toHaveLength(1);
  });
  it("pauses after two stale retries and preserves a clear time-specific explanation", async () => {
    const { venue, run, controller, store } = await setup();
    const originalSnapshot = venue.snapshot.bind(venue);
    venue.snapshot = async wallet => ({ ...await originalSnapshot(wallet), observedAt: venue.clock - 6000 });
    expect(await controller().ensure(run.id)).toBe(false);
    expect(venue.snapshotReads).toBe(3);
    const saved = (await store.get(run.id))!;
    expect(saved.message).toMatch(/读取已过期.*身份核验已通过/);
    expect(saved.funding!.rows[0]!.authorization).toBeUndefined();
    expect(venue.signatures).toBe(0); expect(venue.broadcasts).toHaveLength(0);
  });
  it("retries stale credit data and confirms the original payment without scanning orders or re-paying", async () => {
    const { venue, run, controller, store } = await setup();
    const originalBalance = venue.fundingBalance.bind(venue);
    let staleCreditReads = 0;
    venue.fundingBalance = async wallet => {
      const balance = await originalBalance(wallet);
      if (venue.receipts.size && staleCreditReads++ === 0) return { ...balance, observedAt: venue.clock - 6000 };
      return balance;
    };
    expect(await controller().ensure(run.id)).toBe(true);
    expect(venue.snapshotReads).toBe(2);
    expect((await store.get(run.id))!.events!.some(event => event.phase === "credit" && /重新读取/.test(event.message))).toBe(true);
    expect(venue.signatures).toBe(1); expect(venue.preparations).toBe(1); expect(venue.broadcasts).toHaveLength(1);
  });
  it("rejects a different subaccount immediately even when its timestamp is also stale", async () => {
    for (const method of ["snapshot", "fundingBalance"] as const) {
      const { venue, run, controller, store } = await setup();
      if (method === "snapshot") {
        const original = venue.snapshot.bind(venue);
        venue.snapshot = async wallet => ({ ...await original(wallet), parentSender: `${address(999)}${"00".repeat(12)}`, observedAt: venue.clock - 6000 });
      } else {
        const original = venue.fundingBalance.bind(venue);
        venue.fundingBalance = async wallet => ({ ...await original(wallet), parentSender: `${address(999)}${"00".repeat(12)}`, observedAt: venue.clock - 6000 });
      }
      expect(await controller().ensure(run.id)).toBe(false);
      expect((await store.get(run.id))!.message).toMatch(/身份不匹配/);
      expect(method === "snapshot" ? venue.snapshotReads : venue.balanceReads).toBe(1);
      expect(venue.signatures).toBe(0); expect(venue.broadcasts).toHaveLength(0);
    }
  });
  it("does not retry invalid, future, or long-expired timestamps", async () => {
    for (const offset of [NaN, 1001, -30_001]) {
      const { venue, run, controller, store } = await setup();
      const original = venue.fundingBalance.bind(venue);
      venue.fundingBalance = async wallet => ({ ...await original(wallet), observedAt: venue.clock + offset });
      expect(await controller().ensure(run.id)).toBe(false);
      expect(venue.balanceReads).toBe(1);
      expect((await store.get(run.id))!.message).toMatch(/时间无效|时间在未来|读取已过期/);
      expect(venue.signatures).toBe(0); expect(venue.broadcasts).toHaveLength(0);
    }
  });
  it("still refuses to sign when the target has a position or open order after lightweight budget sampling", async () => {
    for (const kind of ["position", "order"] as const) {
      const { venue, run, controller } = await setup();
      const original = venue.snapshot.bind(venue);
      venue.snapshot = async wallet => {
        const result = await original(wallet);
        if (kind === "position") result.positions.push({ sender: result.parentSender, productId: 2, amountX18: x(1), quoteX18: x(1) });
        else result.openOrders.push({ sender: result.parentSender, productId: 2, digest: hash(123), amountX18: x(1), priceX18: x(1) });
        return result;
      };
      expect(await controller().ensure(run.id)).toBe(false);
      expect(venue.balanceReads).toBe(10); expect(venue.snapshotReads).toBe(1);
      expect(venue.signatures).toBe(0); expect(venue.broadcasts).toHaveLength(0);
    }
  });
  it("integrates the real browser balance reader with bounded stale-credit retries using mock transport only", async () => {
    const { venue, run, controller, store } = await setup();
    let delayedCredit = false;
    const creditObservations: number[] = [];
    const browser = createBrowserTradeTestAdapter({
      now: () => venue.clock,
      network: () => NETWORKS[57073]!,
      config: async () => ({ enabled: true, chainId: 57073, endpoint: address(999) }),
      signer: walletId => ({ address: { family: "evm", value: wallets.find(wallet => wallet.id === walletId)!.address }, signTypedData: async () => { throw new Error("real signing forbidden"); } }) as ReturnType<BrowserTradeTestDependencies["signer"]>,
      fetch: async (input, init) => {
        expect(String(input)).toBe("/api/nado/trade-test-read");
        const body = JSON.parse(String(init?.body)) as { kind: string; chainId: number; query: { type: string; subaccount: string } };
        expect(body.kind).toBe("query"); expect(body.chainId).toBe(57073); expect(body.query.type).toBe("subaccount_info");
        const wallet = wallets.find(candidate => body.query.subaccount.startsWith(candidate.address))!;
        expect(wallet).toBeDefined();
        const observedAt = venue.clock;
        if (venue.receipts.size) {
          creditObservations.push(observedAt);
          if (!delayedCredit) { delayedCredit = true; venue.clock += 5001; }
        }
        return Response.json({ chainId: 57073, observedAt, result: { status: "success", data: { subaccount: body.query.subaccount, exists: true, spot_balances: [{ product_id: 0, balance: { amount: venue.balances.get(wallet.id)! } }] } } });
      },
    });
    venue.fundingBalance = wallet => browser.fundingBalance!(wallet);
    expect(await controller().ensure(run.id)).toBe(true);
    expect(creditObservations).toHaveLength(2);
    expect(creditObservations[1]! - creditObservations[0]!).toBe(5251);
    const events = (await store.get(run.id))!.events!;
    expect(events.some(event => event.phase === "credit" && /数据已过期.*重新读取 1 \/ 2/.test(event.message))).toBe(true);
    expect(venue.snapshotReads).toBe(2);
    expect(venue.signatures).toBe(1); expect(venue.preparations).toBe(1); expect(venue.broadcasts).toHaveLength(1);
  });
});
