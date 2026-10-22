import { describe, expect, it } from "vitest";
import { FundsEngine } from "../../../../apps/console/app/lib/funds/engine";
import { buildBatchHandoff, buildTestCycle, exportRunReport, parseTokenUnits, validatePlan } from "../../../../apps/console/app/lib/funds/planner";
import { MemoryFundsStore } from "../../../../apps/console/app/lib/funds/store";
import { USDT0_ADDRESS, type FundsAdapter, type FundsAuthorization, type FundsLeg, type FundsPlan, type FundsPreparedTransaction, type FundsReceipt, type FundsWallet, type FundsWalletBalance, type Hex } from "../../../../apps/console/app/lib/funds/types";

const wallets: [FundsWallet, FundsWallet, FundsWallet] = [1, 2, 3].map(n => ({ id: `live:${n - 1}`, label: `钱包 ${n}`, address: `0x${n.toString().padStart(40, "0")}` as Hex })) as [FundsWallet, FundsWallet, FundsWallet];
const limits = { maxFeePerLegWei: "1000", maxTotalFeeWei: "3000", authorizationTtlSeconds: 900 };
const signature = `0x${"ab".repeat(65)}` as Hex;

class MockInk implements FundsAdapter {
  balances = new Map(wallets.map((wallet, i) => [wallet.id, { tokenUnits: i === 0 ? "10000000" : "0", ethWei: i === 0 ? "100000" : "0" }]));
  prepared = new Map<Hex, { plan: FundsPlan; leg: FundsLeg; auth: FundsAuthorization; tx: FundsPreparedTransaction }>();
  receipts = new Map<Hex, FundsReceipt>();
  used = new Set<string>();
  signs = 0;
  prepares = 0;
  broadcasts: Hex[] = [];
  settled = 0;
  chain = 57073;
  fee = "500";
  hideReceipts = false;
  loseBroadcastResponse = false;
  rejectBeforeSubmit = false;
  corruptRecipient = false;
  omitAuthorization = false;
  revert = false;
  businessReady = true;
  authorizationLookup = true;
  pauseAfterSignature?: () => Promise<void>;
  onValidate?: () => Promise<void>;
  onReadWallet?: (wallet: FundsWallet) => Promise<void>;
  onBroadcast?: () => Promise<void>;
  async getChainId() { return this.chain; }
  async assertIdentity(wallet: FundsWallet) { if (!this.balances.has(wallet.id)) throw new Error("identity mismatch"); }
  async readWallet(wallet: FundsWallet): Promise<FundsWalletBalance> { await this.onReadWallet?.(wallet); return { ...this.balances.get(wallet.id)! }; }
  async assertTradingReady() { if (!this.businessReady) throw new Error("交易批次未完成或仍有仓位挂单"); }
  async signAuthorization(_plan: FundsPlan, _leg: FundsLeg, _auth: FundsAuthorization) { this.signs += 1; await this.pauseAfterSignature?.(); return signature; }
  async prepareTransaction(plan: FundsPlan, leg: FundsLeg, auth: FundsAuthorization) {
    this.prepares += 1;
    const hash = `0x${this.prepares.toString(16).padStart(64, "0")}` as Hex;
    const rawTransaction = `0x${(this.prepares + 100).toString(16).padStart(8, "0")}` as Hex;
    const tx = { hash, rawTransaction, nonce: (this.prepares - 1).toString(), feeCeilingWei: this.fee };
    this.prepared.set(rawTransaction, { plan, leg, auth: structuredClone(auth), tx }); return tx;
  }
  async broadcast(raw: Hex) {
    this.broadcasts.push(raw);
    await this.onBroadcast?.();
    if (this.rejectBeforeSubmit) throw new Error("connection lost before submission");
    const { plan, leg, auth, tx } = this.prepared.get(raw)!;
    if (!this.used.has(auth.nonce)) {
      this.used.add(auth.nonce); this.settled += 1;
      if (!this.revert) {
        const from = this.balances.get(leg.from.id)!; const to = this.balances.get(leg.to.id)!;
        from.tokenUnits = (BigInt(from.tokenUnits) - BigInt(auth.value)).toString(); to.tokenUnits = (BigInt(to.tokenUnits) + BigInt(auth.value)).toString();
      }
      const treasury = this.balances.get(plan.treasury.id)!; treasury.ethWei = (BigInt(treasury.ethWei) - 210n).toString();
      this.receipts.set(tx.hash, {
        hash: tx.hash, status: this.revert ? "reverted" : "success", blockNumber: (100 + this.settled).toString(), blockTimestampMs: 1_800_000_001_000,
        gasUsed: "100", effectiveGasPrice: "2", l1FeeWei: "10",
        transfers: [{ token: USDT0_ADDRESS, from: auth.from, to: this.corruptRecipient ? wallets[0].address : auth.to, value: auth.value }],
        authorizations: this.omitAuthorization ? [] : [{ authorizer: auth.from, nonce: auth.nonce }],
      });
    }
    if (this.loseBroadcastResponse) throw new Error("node accepted then connection lost");
    return tx.hash;
  }
  async validatePreparedTransaction() { await this.onValidate?.(); }
  async getReceipt(hash: Hex) { return this.hideReceipts ? null : this.receipts.get(hash) ?? null; }
  async authorizationUsed(auth: FundsAuthorization) { return this.used.has(auth.nonce); }
  async findAuthorizationReceipt(auth: FundsAuthorization) {
    if (this.hideReceipts || !this.authorizationLookup) return null;
    return [...this.receipts.values()].find(receipt => receipt.authorizations.some(item => item.nonce === auth.nonce)) ?? null;
  }
}

function fixture() {
  const store = new MemoryFundsStore(); const adapter = new MockInk(); let clock = 1_800_000_000_000;
  const options = { store, adapter, now: () => clock, receiptTimeoutMs: 0 };
  const engine = new FundsEngine(options);
  const plan = buildTestCycle({ wallets, limits });
  return { store, adapter, engine, plan, options, advance: (ms: number) => { clock += ms; } };
}

describe("USDT0 funds handoff planner", () => {
  it("accepts 1 USDT0 and exact sub-dollar base units without floating point", () => {
    expect(parseTokenUnits("1")).toBe("1000000"); expect(parseTokenUnits("0.000001")).toBe("1");
    expect(parseTokenUnits("2000.123456")).toBe("2000123456");
    for (const value of ["0", "-1", "NaN", "1e3", "0.0000001", "1.1234567"]) expect(() => parseTokenUnits(value)).toThrow();
  });
  it("requires matched wallet batches and a complete durable business event", () => {
    const args = { treasury: wallets[0], sources: [wallets[0]], targets: [wallets[1]], amount: "all", completion: { eventId: "completed:trade-42", batchId: "trade-42", completedAt: new Date().toISOString(), sourceWalletIds: [wallets[0].id] }, limits };
    expect(buildBatchHandoff(args).legs[0]?.amount.kind).toBe("all");
    expect(() => buildBatchHandoff({ ...args, targets: [] })).toThrow();
    expect(() => buildBatchHandoff({ ...args, completion: { ...args.completion, sourceWalletIds: [wallets[2].id] } })).toThrow();
    expect(() => buildBatchHandoff({ ...args, targets: [wallets[0]] })).toThrow();
    const invalid = buildBatchHandoff(args); invalid.chainId = 56 as 57073; expect(() => validatePlan(invalid)).toThrow();
  });
});

describe("durable funds transfer engine", () => {
  it("moves 1 USDT0 1→2→3→1 with zero ETH on 2/3 and actual fee/timing records", async () => {
    const f = fixture(); await f.engine.create(f.plan);
    const result = await f.engine.run(f.plan.id);
    expect(result.status).toBe("completed"); expect(f.adapter.settled).toBe(3);
    expect(f.adapter.balances.get(wallets[0].id)).toEqual({ tokenUnits: "10000000", ethWei: "99370" });
    for (const wallet of wallets.slice(1)) expect(f.adapter.balances.get(wallet.id)).toEqual({ tokenUnits: "0", ethWei: "0" });
    for (const leg of result.plan.legs) {
      expect(leg.actualFeeWei).toBe("210"); expect(leg.submittedAt).toBeTruthy(); expect(leg.confirmedAt).toBeTruthy(); expect(leg.receipt?.blockTimestampMs).toBe(1_800_000_001_000);
    }
    expect(result.plan.legs[1]?.sourceEthBeforeWei).toBe("0"); expect(result.plan.legs[1]?.sourceEthAfterWei).toBe("0");
    expect(result.plan.legs[2]?.sourceEthBeforeWei).toBe("0"); expect(result.plan.legs[2]?.sourceEthAfterWei).toBe("0");
    await f.engine.run(f.plan.id); expect(f.adapter.broadcasts).toHaveLength(3);
  });
  it("persists the same raw bytes before every broadcast and recovers an interruption before submission", async () => {
    const f = fixture(); await f.engine.create(f.plan); f.adapter.rejectBeforeSubmit = true;
    f.adapter.onBroadcast = async () => {
      const saved = await f.store.get(f.plan.id); const prepared = saved?.plan.legs.find(leg => leg.transaction?.rawTransaction === f.adapter.broadcasts.at(-1));
      expect(prepared?.authorization?.signature).toBe(signature); expect(prepared?.transaction?.hash).toBeTruthy();
    };
    const paused = await f.engine.run(f.plan.id); expect(paused.status).toBe("paused"); expect(f.adapter.settled).toBe(0);
    const firstRaw = f.adapter.broadcasts[0]; const firstNonce = paused.plan.legs[0]?.authorization?.nonce;
    f.adapter.rejectBeforeSubmit = false;
    const reloaded = new FundsEngine(f.options); const result = await reloaded.run(f.plan.id);
    expect(result.status).toBe("completed"); expect(f.adapter.broadcasts[1]).toBe(firstRaw);
    expect(result.plan.legs[0]?.authorization?.nonce).toBe(firstNonce); expect(f.adapter.signs).toBe(3); expect(f.adapter.settled).toBe(3);
  });
  it("recovers an accepted broadcast with lost response without paying the first leg again", async () => {
    const f = fixture(); await f.engine.create(f.plan); f.adapter.loseBroadcastResponse = true; f.adapter.hideReceipts = true;
    expect((await f.engine.run(f.plan.id)).status).toBe("paused"); expect(f.adapter.settled).toBe(1);
    f.adapter.loseBroadcastResponse = false; f.adapter.hideReceipts = false;
    expect((await new FundsEngine(f.options).run(f.plan.id)).status).toBe("completed");
    expect(f.adapter.broadcasts).toHaveLength(3); expect(f.adapter.settled).toBe(3); expect(f.adapter.signs).toBe(3);
  });
  it("does not infer success or regenerate an authorization when used but its receipt is unknown", async () => {
    const f = fixture(); await f.engine.create(f.plan); f.adapter.hideReceipts = true;
    await f.engine.run(f.plan.id); const result = await f.engine.run(f.plan.id);
    expect(result.status).toBe("needs-attention"); expect(f.adapter.signs).toBe(1); expect(f.adapter.broadcasts).toHaveLength(1);
  });
  it("does not attribute a third-party relayer's fee to the treasury while its original transaction is unresolved", async () => {
    const f = fixture(); await f.engine.create(f.plan); f.adapter.hideReceipts = true; await f.engine.run(f.plan.id);
    const [originalHash, receipt] = [...f.adapter.receipts.entries()][0]!;
    f.adapter.receipts.delete(originalHash);
    const externalHash = `0x${"f".repeat(64)}` as Hex;
    f.adapter.receipts.set(externalHash, { ...receipt, hash: externalHash }); f.adapter.hideReceipts = false;
    const result = await f.engine.run(f.plan.id);
    expect(result.status).toBe("needs-attention"); expect(result.plan.legs[0]?.externalReceipt?.hash).toBe(externalHash);
    expect(result.plan.legs[0]?.actualFeeWei).toBeUndefined(); expect(f.adapter.broadcasts).toHaveLength(1);
  });
  it("stops on a wrong recipient or missing authorization event even if the transaction succeeded", async () => {
    for (const flag of ["corruptRecipient", "omitAuthorization"] as const) {
      const f = fixture(); f.adapter[flag] = true; await f.engine.create(f.plan);
      const result = await f.engine.run(f.plan.id); expect(result.status).toBe("needs-attention"); expect(f.adapter.broadcasts).toHaveLength(1);
    }
  });
  it("never makes another payment after an authorization expires during interruption", async () => {
    const f = fixture(); f.adapter.rejectBeforeSubmit = true; await f.engine.create(f.plan); await f.engine.run(f.plan.id);
    f.advance(901000); f.adapter.rejectBeforeSubmit = false;
    expect((await f.engine.run(f.plan.id)).status).toBe("needs-attention"); expect(f.adapter.signs).toBe(1); expect(f.adapter.broadcasts).toHaveLength(1);
  });
  it("rejects duplicate batch creation even if the previous batch completed", async () => {
    const f = fixture(); await f.engine.create(f.plan); await f.engine.run(f.plan.id);
    const duplicate = buildTestCycle({ wallets, limits, dedupeKey: f.plan.dedupeKey });
    await expect(f.engine.create(duplicate)).rejects.toThrow("已经存在");
  });
  it("atomically blocks a new test identifier while an earlier treasury test is unfinished", async () => {
    const f = fixture();
    const results = await Promise.allSettled([f.engine.create(f.plan), f.engine.create(buildTestCycle({ wallets, limits }))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await f.store.list()).toHaveLength(1);
  });
  it("locks a treasury against concurrent engines", async () => {
    const f = fixture(); await f.engine.create(f.plan); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const enteredGate = new Promise<void>(resolve => { entered = resolve; });
    f.adapter.onBroadcast = async () => { entered(); await gate; };
    const running = f.engine.run(f.plan.id); await enteredGate;
    await expect(new FundsEngine(f.options).run(f.plan.id)).rejects.toThrow("已有任务");
    release(); expect((await running).status).toBe("completed");
  });
  it("marks interrupted work paused without signing or broadcasting on page reload", async () => {
    const f = fixture(); await f.engine.create(f.plan);
    await f.store.update(f.plan.id, run => ({ ...run, status: "running" }));
    await new FundsEngine(f.options).recoverInterrupted();
    expect((await f.store.get(f.plan.id))?.status).toBe("paused"); expect(f.adapter.broadcasts).toHaveLength(0);
  });
  it("checks per-leg and total gas limits before broadcasting", async () => {
    const f = fixture(); f.plan.limits.maxFeePerLegWei = "100"; await f.engine.create(f.plan);
    const result = await f.engine.run(f.plan.id); expect(result.status).toBe("paused"); expect(f.adapter.broadcasts).toHaveLength(0);
    const total = fixture(); total.plan.limits.maxTotalFeeWei = "600"; await total.engine.create(total.plan);
    const partial = await total.engine.run(total.plan.id); expect(partial.status).toBe("paused"); expect(total.adapter.broadcasts).toHaveLength(1);
  });
  it("requires business completion readiness before authorizing a handoff", async () => {
    const f = fixture(); f.adapter.businessReady = false;
    const plan = buildBatchHandoff({ treasury: wallets[0], sources: [wallets[0]], targets: [wallets[1]], amount: "all", limits,
      completion: { eventId: "event42", batchId: "batch42", completedAt: new Date().toISOString(), sourceWalletIds: [wallets[0].id] } });
    await f.engine.create(plan); expect((await f.engine.run(plan.id)).status).toBe("paused");
    expect(f.adapter.signs).toBe(0); expect(f.adapter.broadcasts).toHaveLength(0);
    f.adapter.businessReady = true; expect((await f.engine.run(plan.id)).status).toBe("completed");
    expect(f.adapter.balances.get(wallets[1].id)?.tokenUnits).toBe("10000000");
  });
  it("pause after signature prevents a new transaction and resumes the existing authorization", async () => {
    const f = fixture(); await f.engine.create(f.plan); f.adapter.pauseAfterSignature = async () => { await f.engine.pause(f.plan.id); };
    const paused = await f.engine.run(f.plan.id); expect(paused.status).toBe("paused"); expect(f.adapter.broadcasts).toHaveLength(0);
    f.adapter.pauseAfterSignature = undefined; await f.engine.run(f.plan.id); expect(f.adapter.signs).toBe(3);
  });
  it("honors pause during the final raw transaction validation without broadcasting", async () => {
    const f = fixture(); await f.engine.create(f.plan);
    f.adapter.onValidate = async () => { await f.engine.pause(f.plan.id); };
    expect((await f.engine.run(f.plan.id)).status).toBe("paused"); expect(f.adapter.broadcasts).toHaveLength(0);
    f.adapter.onValidate = undefined;
    expect((await f.engine.run(f.plan.id)).status).toBe("completed"); expect(f.adapter.signs).toBe(3);
  });
  it("honors pause during the treasury fee budget read", async () => {
    const f = fixture(); await f.engine.create(f.plan);
    f.adapter.onReadWallet = async wallet => { if (f.adapter.prepares > 0 && wallet.id === wallets[0].id) await f.engine.pause(f.plan.id); };
    expect((await f.engine.run(f.plan.id)).status).toBe("paused"); expect(f.adapter.broadcasts).toHaveLength(0);
  });
  it("rechecks pause after durably marking the submission intent", async () => {
    const f = fixture(); let engine: FundsEngine;
    engine = new FundsEngine({ ...f.options, onChange: run => { if (run.status === "running" && run.plan.legs[0]?.status === "broadcast" && !run.stopRequested) void engine.pause(run.plan.id); } });
    await engine.create(f.plan);
    expect((await engine.run(f.plan.id)).status).toBe("paused"); expect(f.adapter.broadcasts).toHaveLength(0);
  });
  it("records mined failure fees and never retries with another authorization", async () => {
    const f = fixture(); f.adapter.revert = true; await f.engine.create(f.plan);
    const result = await f.engine.run(f.plan.id); expect(result.status).toBe("needs-attention"); expect(result.plan.legs[0]?.actualFeeWei).toBe("210");
    await f.engine.run(f.plan.id); expect(f.adapter.broadcasts).toHaveLength(1); expect(f.adapter.signs).toBe(1);
  });
  it("exports accounting without executable signatures or raw transactions", async () => {
    const f = fixture(); await f.engine.create(f.plan); const result = await f.engine.run(f.plan.id);
    const report = JSON.stringify(exportRunReport(result)); expect(report).not.toContain(signature);
    expect(report).not.toContain(result.plan.legs[0]?.transaction?.rawTransaction); expect(report).toContain("actualFeeWei");
  });
});
