import { describe, expect, it } from "vitest";
import { TradeTestEngine } from "../../../../apps/console/app/lib/tradeTest/engine";
import { createTradeTestRun, DEFAULT_TEST_SETTINGS, X18 } from "../../../../apps/console/app/lib/tradeTest/planner";
import { MemoryTradeTestStore } from "../../../../apps/console/app/lib/tradeTest/store";
import { createFundingState } from "../../../../apps/console/app/lib/tradeTest/funding";
import type { AccountSnapshot, OrderRequest, PreparedTestOrder, TestMarket, TestOpenOrder, TestOrderReport, TestPosition, TestWallet, TradeTestAdapter, TradeTestRun } from "../../../../apps/console/app/lib/tradeTest/types";

const x = (value: number): string => (BigInt(value) * X18).toString();
const wallets: TestWallet[] = Array.from({ length: 10 }, (_, index) => ({ id: `live:${index}`, address: `0x${(index + 1).toString(16).padStart(40, "0")}` as `0x${string}`, label: `${index + 1}号钱包` }));
const parent = (wallet: TestWallet) => `${wallet.address}64656661756c740000000000`;
const child = (wallet: TestWallet) => `${wallet.address}${"01".repeat(12)}`;
const absolute = (amount: bigint) => amount < 0n ? -amount : amount;

class Venue implements TradeTestAdapter {
  readonly mode = "simulation" as const;
  clock = 100_000;
  sequence = 0;
  prepared: PreparedTestOrder[] = [];
  broadcasts: PreparedTestOrder[] = [];
  cancellations: string[] = [];
  positions = new Map<string, TestPosition>();
  orders = new Map<string, TestOpenOrder>();
  reportsByDigest = new Map<string, TestOrderReport>();
  balances = new Map(wallets.map(wallet => [wallet.id, x(20)]));
  fixedFeeReserveX18 = "0";
  openingFillBps = 10_000;
  closingFillBps: number[] = [];
  acceptThenTimeout = false;
  acceptThenTimeoutClose = false;
  keepOrdersAfterCancel = false;
  cancelThrows = false;
  failReadsAfterOpening = false;
  badIdentity = false;
  archiveDelayed = false;
  reportReads = 0;
  onSnapshot?: (wallet: TestWallet) => Promise<void>;
  onBroadcast?: (order: PreparedTestOrder) => Promise<void>;
  onPrepare?: () => Promise<void>;
  onBeforeSend?: () => Promise<void>;
  async assertIdentity(wallet: TestWallet, chainId: number) {
    if (this.badIdentity || chainId !== 57073 || !wallets.some(item => item.id === wallet.id && item.address === wallet.address)) throw new Error("身份或网络不一致");
  }
  async market(symbol: string): Promise<TestMarket> {
    return { symbol, productId: 92, observedAt: this.clock, isOpen: true, isolatedOnly: true, maxLeverage: 40,
      minNotionalX18: x(100), sizeIncrementX18: x(1), priceIncrementX18: "100000000000000", bidX18: x(1), askX18: "1000100000000000000", oracleX18: x(1), makerFeeRateX18: "20000000000000", takerFeeRateX18: "70000000000000" };
  }
  async snapshot(wallet: TestWallet): Promise<AccountSnapshot> {
    await this.onSnapshot?.(wallet);
    if (this.failReadsAfterOpening && this.broadcasts.length) throw new Error("模拟页面中断后账户查询失败");
    return { observedAt: this.clock, parentSender: parent(wallet), quoteBalanceX18: this.balances.get(wallet.id)!, equityX18: this.balances.get(wallet.id)!,
      fixedFeeReserveX18: this.fixedFeeReserveX18,
      positions: this.positions.has(wallet.id) ? [structuredClone(this.positions.get(wallet.id)!)] : [],
      openOrders: [...this.orders.values()].filter(order => order.sender.startsWith(wallet.address)), hasOtherCollateral: false, hasCrossPosition: false };
  }
  async prepare(request: OrderRequest): Promise<PreparedTestOrder> {
    await this.onPrepare?.();
    if (request.reduceOnly) expect(request.sender).toBe(child(request.wallet));
    const order: PreparedTestOrder = { digest: `0x${(++this.sequence).toString(16).padStart(64, "0")}`, sender: parent(request.wallet), productId: request.market.productId,
      side: request.side, amountX18: request.amountX18, priceX18: request.priceX18, marginX18: request.marginX18, reduceOnly: request.reduceOnly, expiresAt: request.expiresAt, payload: { localTest: true } };
    this.prepared.push(order); return order;
  }
  async broadcast(order: PreparedTestOrder, beforeSend?: () => void | Promise<void>): Promise<void> {
    await this.onBeforeSend?.();
    await beforeSend?.();
    this.broadcasts.push(order);
    const wallet = wallets.find(item => order.sender.startsWith(item.address))!;
    const amount = BigInt(order.amountX18);
    let filled: bigint;
    if (!order.reduceOnly) {
      filled = amount * BigInt(this.openingFillBps) / 10_000n;
      if (filled) this.positions.set(wallet.id, { sender: child(wallet), productId: order.productId, amountX18: (filled * (order.side === "buy" ? 1n : -1n)).toString(), quoteX18: x(5) });
      if (filled < amount) this.orders.set(order.digest, { digest: order.digest, sender: order.sender, productId: order.productId, amountX18: order.amountX18, priceX18: order.priceX18 });
    } else {
      expect(order.sender).toBe(parent(wallet));
      expect(order.marginX18).toBeUndefined();
      const position = this.positions.get(wallet.id)!;
      expect(amount).toBe(absolute(BigInt(position.amountX18)));
      filled = amount * BigInt(this.closingFillBps.shift() ?? 10_000) / 10_000n;
      const left = absolute(BigInt(position.amountX18)) - filled;
      if (left === 0n) this.positions.delete(wallet.id);
      else this.positions.set(wallet.id, { ...position, amountX18: (left * (BigInt(position.amountX18) > 0n ? 1n : -1n)).toString() });
    }
    this.reportsByDigest.set(order.digest, { digest: order.digest, indexed: true, volumeX18: (filled * BigInt(order.priceX18) / X18).toString(), feeX18: "1", realizedPnlX18: "0", firstFillAt: this.clock, lastFillAt: this.clock });
    await this.onBroadcast?.(order);
    if (this.acceptThenTimeout && !order.reduceOnly) throw new Error("relay timeout after acceptance");
    if (this.acceptThenTimeoutClose && order.reduceOnly) throw new Error("close relay timeout after acceptance");
  }
  async cancel(_wallet: TestWallet, order: PreparedTestOrder): Promise<void> {
    this.cancellations.push(order.digest);
    if (this.cancelThrows) throw new Error("撤单返回结果未知");
    if (!this.keepOrdersAfterCancel) this.orders.delete(order.digest);
  }
  async reports(_wallet: TestWallet, orders: PreparedTestOrder[]): Promise<TestOrderReport[]> {
    this.reportReads += 1;
    return this.archiveDelayed ? [] : orders.flatMap(order => this.reportsByDigest.has(order.digest) ? [this.reportsByDigest.get(order.digest)!] : []);
  }
}

class FaultStore extends MemoryTradeTestStore {
  failWhen?: (before: TradeTestRun, after: TradeTestRun) => boolean;
  override async update(id: string, change: (run: TradeTestRun) => void) {
    const before = (await this.get(id))!, after = structuredClone(before); change(after);
    if (this.failWhen?.(before, after)) { this.failWhen = undefined; throw new Error("durable journal failed"); }
    return super.update(id, change);
  }
}

async function setup(count = 1, withFunding = false) {
  const store = new FaultStore(), venue = new Venue();
  const run = createTradeTestRun(wallets, { ...DEFAULT_TEST_SETTINGS, quoteWaitMs: 1000, closeWaitMs: 500 }, "simulation", 57073, "test", venue.clock);
  run.wallets = run.wallets.slice(0, count);
  if (withFunding) run.funding = createFundingState(wallets[0]!, run.wallets.map(({ wallet }, index) => ({ wallet, requiredX18: x(7), balanceX18: "0", depositAddress: `0x${(index + 100).toString(16).padStart(40, "0")}` })));
  await store.create(run);
  const options = { now: () => venue.clock, sleep: async (ms: number) => { venue.clock += ms; } };
  const engine = new TradeTestEngine(store, venue, options);
  return { store, venue, run, engine, options };
}

describe("bounded trade test engine", () => {
  it("rechecks the saved quote after a slow final adapter identity read", async () => {
    const { venue, run, engine } = await setup();
    venue.onBeforeSend = async () => { venue.clock += 5001; };
    const result = await engine.run(run.id);
    expect(venue.prepared).toHaveLength(1);
    expect(venue.broadcasts).toHaveLength(0);
    expect(result.wallets[0]!.orders[0]!.error).toContain("过期");
    expect(result.status).toBe("attention");
  });
  it("persists per-wallet progress before slow network checks and records orders without replayable data", async () => {
    const { store, venue, run, engine } = await setup(2);
    const observed: number[] = [];
    venue.onSnapshot = async wallet => {
      if (venue.broadcasts.length || venue.prepared.length) return;
      const current = (await store.get(run.id))!;
      if (current.progress?.phase === "preflight") {
        expect(current.progress.walletId).toBe(wallet.id);
        expect(current.progress.message).toContain("只读");
        observed.push(current.progress.current!);
      }
    };
    const result = await engine.run(run.id);
    expect(observed.slice(0, 2)).toEqual([1, 2]);
    expect(result.status).toBe("completed");
    expect(result.progress?.phase).toBe("completed");
    expect(result.events?.some(e => e.phase === "opening" && e.message.includes("已受理") && e.orderDigest)).toBe(true);
    expect(result.events?.some(e => e.phase === "closing" && e.orderDigest)).toBe(true);
    expect(JSON.stringify(result.events)).not.toContain("localTest");
    expect(result.wallets.every(w => w.orders.length === 2)).toBe(true);
  });

  it("retains the failed stage for a read failure before funding and signs nothing", async () => {
    const { store, venue, run, engine } = await setup(2);
    venue.onSnapshot = async wallet => { if (wallet.id === wallets[1]!.id) throw new Error("mock node unavailable"); };
    const result = await engine.run(run.id);
    expect(result.status).toBe("paused");
    expect(result.progress?.phase).toBe("preflight");
    expect(result.progress?.walletId).toBe(wallets[1]!.id);
    expect(result.events?.at(-1)?.kind).toBe("error");
    expect(venue.prepared).toHaveLength(0);
    expect(venue.broadcasts).toHaveLength(0);
    expect((await store.get(run.id))?.progress?.message).toContain("mock node unavailable");
  });
  it("keeps the trade lock and signs nothing until every automatic deposit is durably credited", async () => {
    const { store, venue, run, options } = await setup(2, true);
    venue.balances.set(wallets[0]!.id, "0"); venue.balances.set(wallets[1]!.id, "0");
    let calls = 0;
    const funding = { ensure: async () => {
      calls++;
      expect(venue.prepared).toHaveLength(0);
      await expect(store.withLock(57073, async () => {})).rejects.toThrow("已有测试");
      await store.update(run.id, r => { r.funding!.status = "paused"; r.funding!.message = "等待入账"; });
      return false;
    } };
    const engine = new TradeTestEngine(store, venue, { ...options, funding });
    expect((await engine.run(run.id)).message).toBe("等待入账");
    expect(calls).toBe(1); expect(venue.prepared).toHaveLength(0);
    funding.ensure = async () => {
      for (const wallet of wallets.slice(0, 2)) venue.balances.set(wallet.id, x(8));
      await store.update(run.id, r => { r.funding!.status = "completed"; r.funding!.rows.forEach(row => { row.status = "credited"; }); });
      return true;
    };
    const result = await engine.run(run.id);
    expect(result.status).toBe("completed");
    expect(result.wallets.every(w => w.before?.quoteBalanceX18 === x(8))).toBe(true);
    expect(venue.broadcasts).toHaveLength(4);
  });

  it("requires a funding controller and persisted completion rather than trusting a success response", async () => {
    const { store, venue, run, options } = await setup(1, true);
    expect((await new TradeTestEngine(store, venue, options).run(run.id)).message).toContain("缺少充值核对器");
    const liar = new TradeTestEngine(store, venue, { ...options, funding: { ensure: async () => true } });
    expect((await liar.run(run.id)).message).toContain("未完整结束");
    expect(venue.prepared).toHaveLength(0);
  });

  it("rechecks balances after funding and never trades a partially funded cohort", async () => {
    const { store, venue, run, options } = await setup(2, true);
    const funding = { ensure: async () => {
      await store.update(run.id, r => { r.funding!.status = "completed"; r.funding!.rows.forEach(row => { row.status = "credited"; }); });
      venue.balances.set(wallets[1]!.id, x(4));
      return true;
    } };
    const result = await new TradeTestEngine(store, venue, { ...options, funding }).run(run.id);
    expect(result.status).toBe("paused"); expect(result.message).toContain("不足"); expect(venue.prepared).toHaveLength(0);
  });

  it("checks every account for existing exposure before the first payment", async () => {
    const { store, venue, run, options } = await setup(2, true);
    venue.positions.set(wallets[1]!.id, { sender: child(wallets[1]!), productId: 92, amountX18: x(1), quoteX18: x(5) });
    let funded = false;
    const result = await new TradeTestEngine(store, venue, { ...options, funding: { ensure: async () => { funded = true; return false; } } }).run(run.id);
    expect(result.status).toBe("paused"); expect(funded).toBe(false); expect(venue.prepared).toHaveLength(0);
  });

  it("honors stop during funding and never initiates funding in cleanup-only recovery", async () => {
    const { store, venue, run, options } = await setup(1, true);
    let calls = 0;
    const funding = { ensure: async () => {
      calls++;
      await store.update(run.id, r => { r.stopRequested = true; r.funding!.status = "completed"; r.funding!.rows.forEach(row => { row.status = "credited"; }); });
      return true;
    } };
    const engine = new TradeTestEngine(store, venue, { ...options, funding });
    expect((await engine.run(run.id, { cleanupOnly: true })).status).toBe("paused");
    expect(calls).toBe(0);
    expect((await engine.run(run.id)).status).toBe("paused");
    expect(calls).toBe(1); expect(venue.prepared).toHaveLength(0);
  });

  it("performs one independent round trip per wallet and derives statistics only from fills", async () => {
    const { engine, run, venue } = await setup(2);
    const result = await engine.run(run.id);
    expect(result.status).toBe("completed");
    expect(venue.broadcasts.map(order => [order.reduceOnly, order.side])).toEqual([[false, "buy"], [true, "sell"], [false, "sell"], [true, "buy"]]);
    expect(result.wallets.every(wallet => wallet.status === "completed" && wallet.reports.every(report => report.indexed))).toBe(true);
    expect(venue.positions.size).toBe(0);
  });

  it("preflights every wallet before signing anything when a later wallet lacks collateral", async () => {
    const { engine, run, venue } = await setup(2);
    venue.balances.set(wallets[1]!.id, x(5));
    expect((await engine.run(run.id)).status).toBe("paused");
    expect(venue.prepared).toHaveLength(0);
    expect(venue.broadcasts).toHaveLength(0);
  });
  it("does not start with enough margin but too little fixed-fee reserve", async () => {
    const { engine, run, venue } = await setup();
    venue.balances.set(wallets[0]!.id, "5100000000000000000");
    venue.fixedFeeReserveX18 = "300000000000000000";
    const result = await engine.run(run.id);
    expect(result.status).toBe("paused");
    expect(result.message).toContain("手续费预留");
    expect(venue.prepared).toHaveLength(0);
    expect(venue.broadcasts).toHaveLength(0);
  });

  it("does not reopen after refresh when an opening was accepted but subsequent reads failed", async () => {
    const { engine, run, venue, store, options } = await setup();
    venue.failReadsAfterOpening = true;
    expect((await engine.run(run.id)).status).toBe("attention");
    expect(venue.broadcasts).toHaveLength(1);
    venue.failReadsAfterOpening = false;
    const recovered = await new TradeTestEngine(store, venue, options).run(run.id);
    expect(recovered.status).toBe("completed");
    expect(venue.broadcasts.filter(order => !order.reduceOnly)).toHaveLength(1);
    expect(venue.broadcasts.filter(order => order.reduceOnly)).toHaveLength(1);
  });

  it("cleans up a fill after acknowledgement timeout but waits past expiry before advancing", async () => {
    const { engine, run, venue } = await setup(); venue.acceptThenTimeout = true;
    const result = await engine.run(run.id);
    expect(result.status).toBe("attention");
    expect(result.message).toContain("迟到受理");
    expect(venue.broadcasts.filter(order => !order.reduceOnly)).toHaveLength(1);
    expect(result.wallets[0]!.orders[0]!.error).toContain("timeout");
    expect(venue.positions.size).toBe(0);
    venue.clock = venue.broadcasts[0]!.expiresAt + 2001;
    expect((await engine.run(run.id)).status).toBe("completed");
    expect(venue.broadcasts.filter(order => !order.reduceOnly)).toHaveLength(1);
  });

  it("does not trust cancel-before-delayed-placement when both initial snapshots were empty", async () => {
    const { engine, run, venue } = await setup(2);
    venue.openingFillBps = 0; venue.acceptThenTimeout = true;
    const first = await engine.run(run.id);
    expect(first.status).toBe("attention");
    expect(first.wallets[1]!.status).toBe("pending");
    expect(venue.broadcasts).toHaveLength(1);
    // The old request arrives after the cancellation/no-order observations.
    venue.positions.set(wallets[0]!.id, { sender: child(wallets[0]!), productId: 92, amountX18: x(100), quoteX18: x(5) });
    venue.clock = venue.broadcasts[0]!.expiresAt + 2001;
    venue.acceptThenTimeout = false; venue.openingFillBps = 10_000;
    const recovered = await engine.run(run.id);
    expect(recovered.status).toBe("completed");
    expect(venue.broadcasts.filter(order => !order.reduceOnly && order.sender === parent(wallets[0]!))).toHaveLength(1);
    expect(venue.broadcasts[1]!.reduceOnly).toBe(true);
  });

  it("does not finalize or advance a flat account while an unacknowledged close can still arrive", async () => {
    const { engine, run, venue } = await setup(2); venue.acceptThenTimeoutClose = true;
    const first = await engine.run(run.id);
    expect(first.status).toBe("attention");
    expect(first.message).toContain("原平仓提交结果未知");
    expect(venue.positions.size).toBe(0);
    expect(first.wallets[1]!.status).toBe("pending");
    expect(venue.broadcasts).toHaveLength(2);
    venue.clock = venue.broadcasts[1]!.expiresAt + 2001;
    venue.acceptThenTimeoutClose = false;
    const recovered = await engine.run(run.id);
    expect(recovered.status).toBe("completed");
    expect(venue.broadcasts.filter(order => order.sender === parent(wallets[0]!))).toHaveLength(2);
  });

  it("closes partial opening quantities without topping up volume or inflating a residual to 100U", async () => {
    const { engine, run, venue } = await setup();
    venue.openingFillBps = 4000; venue.closingFillBps = [5000, 10_000];
    const result = await engine.run(run.id);
    expect(result.status).toBe("completed");
    expect(venue.broadcasts.map(order => order.amountX18)).toEqual([x(100), x(40), x(20)]);
    const volume = result.wallets[0]!.reports.reduce((sum, report) => sum + BigInt(report.volumeX18), 0n);
    expect(volume).toBeLessThan(BigInt(x(100)));
    expect(venue.broadcasts.filter(order => !order.reduceOnly)).toHaveLength(1);
  });

  it("ends an unfilled attempt without placing another opening order", async () => {
    const { engine, run, venue } = await setup(); venue.openingFillBps = 0;
    const result = await engine.run(run.id);
    expect(result.status).toBe("completed");
    expect(result.wallets[0]!.status).toBe("unfilled");
    expect(venue.broadcasts).toHaveLength(1);
    expect(result.wallets[0]!.reports[0]!.volumeX18).toBe("0");
  });

  it("does not close or advance when cancellation is acknowledged but orders remain", async () => {
    const { engine, run, venue } = await setup(2);
    venue.openingFillBps = 5000; venue.keepOrdersAfterCancel = true;
    const result = await engine.run(run.id);
    expect(result.status).toBe("attention");
    expect(result.message).toContain("撤单");
    expect(venue.broadcasts).toHaveLength(1);
    expect(result.wallets[1]!.status).toBe("pending");
  });

  it("does not close or advance when cancellation outcome is unknown", async () => {
    const { engine, run, venue } = await setup(2); venue.cancelThrows = true;
    expect((await engine.run(run.id)).status).toBe("attention");
    expect(venue.broadcasts).toHaveLength(1);
  });

  it("never broadcasts when persisting the prepared order fails", async () => {
    const { engine, run, venue, store } = await setup();
    store.failWhen = (before, after) => before.wallets[0]!.orders.length === 0 && after.wallets[0]!.orders.length === 1;
    expect((await engine.run(run.id)).status).toBe("attention");
    expect(venue.prepared).toHaveLength(1);
    expect(venue.broadcasts).toHaveLength(0);
  });

  it("stops further sending on a journal failure after the opening was accepted", async () => {
    const { engine, run, venue, store } = await setup();
    store.failWhen = (_before, after) => after.wallets[0]!.orders[0]?.acknowledgedAt !== undefined;
    expect((await engine.run(run.id)).status).toBe("attention");
    expect(venue.broadcasts).toHaveLength(1);
    expect(venue.positions.size).toBe(1);
  });

  it("a stop after opening prevents later wallets but still attempts reduce-only cleanup", async () => {
    const { engine, run, venue } = await setup(2);
    venue.onBroadcast = async order => { if (!order.reduceOnly) await engine.stop(run.id); };
    const result = await engine.run(run.id);
    expect(result.status).toBe("paused");
    expect(venue.broadcasts.map(order => order.reduceOnly)).toEqual([false, true]);
    expect(venue.positions.size).toBe(0);
    expect(result.wallets[1]!.status).toBe("pending");
  });

  it("a stop while signing persists the prepared order without sending it", async () => {
    const { engine, run, venue } = await setup(2);
    venue.onPrepare = async () => { await engine.stop(run.id); };
    const result = await engine.run(run.id);
    expect(result.status).toBe("paused");
    expect(venue.prepared).toHaveLength(1);
    expect(venue.broadcasts).toHaveLength(0);
  });

  it("resolves a durable but definitely unsent order locally without claiming indexer confirmation", async () => {
    const { engine, run, venue } = await setup(2);
    venue.archiveDelayed = true;
    venue.onPrepare = async () => { await engine.stop(run.id); };
    const result = await engine.run(run.id);
    expect(result.wallets[0]!.status).toBe("unfilled");
    expect(result.wallets[0]!.reports[0]).toMatchObject({ indexed: false, notBroadcast: true, volumeX18: "0", feeX18: "0" });
    expect(result.wallets[0]!.message).toContain("未发送");
    expect(venue.reportReads).toBe(0);
    expect(venue.broadcasts).toHaveLength(0);
  });

  it("cleanup-only resumes an existing position without preflighting or opening later wallets", async () => {
    const { engine, run, venue, store, options } = await setup(2);
    venue.failReadsAfterOpening = true;
    expect((await engine.run(run.id)).status).toBe("attention");
    venue.failReadsAfterOpening = false;
    venue.balances.set(wallets[1]!.id, "0"); // A future funding problem must not block cleanup.
    await engine.stop(run.id);
    const result = await new TradeTestEngine(store, venue, options).run(run.id, { cleanupOnly: true });
    expect(result.status).toBe("paused");
    expect(result.stopRequested).toBe(true);
    expect(venue.positions.size).toBe(0);
    expect(venue.broadcasts.map(order => order.reduceOnly)).toEqual([false, true]);
    expect(result.wallets[1]!.status).toBe("pending");
  });

  it("cleanup-only on a ready batch does not sign or open any account", async () => {
    const { engine, run, venue } = await setup(2);
    const result = await engine.run(run.id, { cleanupOnly: true });
    expect(result.status).toBe("paused");
    expect(result.stopRequested).toBe(true);
    expect(venue.prepared).toHaveLength(0);
    expect(venue.broadcasts).toHaveLength(0);
  });

  it("reads the active account after slow prior-wallet checks rather than using an aged snapshot", async () => {
    const { engine, run, venue } = await setup(2);
    venue.onSnapshot = async wallet => {
      if (venue.reportReads === 1 && wallet.id === wallets[0]!.id) venue.clock += DEFAULT_TEST_SETTINGS.maxQuoteAgeMs + 1;
    };
    const result = await engine.run(run.id);
    expect(result.status).toBe("completed");
    expect(venue.broadcasts.filter(order => !order.reduceOnly)).toHaveLength(2);
  });

  it("persists but never broadcasts an order whose account and quote expired while signing", async () => {
    const { engine, run, venue } = await setup();
    venue.onPrepare = async () => { venue.clock += DEFAULT_TEST_SETTINGS.maxQuoteAgeMs + 1; };
    const result = await engine.run(run.id);
    expect(result.status).toBe("attention");
    expect(result.message).toContain("已经过期");
    expect(venue.prepared).toHaveLength(1);
    expect(venue.broadcasts).toHaveLength(0);
    expect(result.wallets[0]!.orders[0]!.broadcastStartedAt).toBeUndefined();
    expect(result.wallets[0]!.orders[0]!.marketObservedAt).toBeDefined();
    expect(result.wallets[0]!.orders[0]!.accountObservedAt).toBeDefined();
  });

  it("limits repeated partial closes and leaves the real residual visible", async () => {
    const { engine, run, venue } = await setup(2); venue.closingFillBps = [0, 0, 0];
    const result = await engine.run(run.id);
    expect(result.status).toBe("attention");
    expect(result.message).toContain("平仓尝试次数");
    expect(venue.broadcasts.filter(order => order.reduceOnly)).toHaveLength(3);
    expect(venue.positions.size).toBe(1);
    expect(result.wallets[1]!.status).toBe("pending");
  });

  it("does not interpret unavailable archive reports as zero fees and can refresh later", async () => {
    const { engine, run, venue } = await setup(); venue.archiveDelayed = true;
    const result = await engine.run(run.id);
    expect(result.status).toBe("completed");
    expect(result.wallets[0]!.reports.every(report => report.indexed === false)).toBe(true);
    venue.archiveDelayed = false;
    const updated = await engine.refreshReports(run.id);
    expect(updated.wallets[0]!.reports.every(report => report.indexed)).toBe(true);
    expect(venue.broadcasts).toHaveLength(2);
  });

  it("does not label a flat but unindexed opening as a proven zero-fill order", async () => {
    const { engine, run, venue } = await setup();
    venue.openingFillBps = 0; venue.archiveDelayed = true;
    const result = await engine.run(run.id);
    expect(result.status).toBe("completed");
    expect(result.wallets[0]!.status).toBe("completed");
    expect(result.wallets[0]!.reports[0]!.indexed).toBe(false);
    venue.archiveDelayed = false;
    expect((await engine.refreshReports(run.id)).wallets[0]!.status).toBe("unfilled");
    expect(venue.broadcasts).toHaveLength(1);
  });

  it("rejects a concurrent run under the same network lock without signing twice", async () => {
    const { engine, run, venue, store, options } = await setup();
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    venue.onPrepare = async () => { reached(); await gate; };
    const first = engine.run(run.id);
    await entered;
    await expect(new TradeTestEngine(store, venue, options).run(run.id)).rejects.toThrow("已有测试");
    release();
    expect((await first).status).toBe("completed");
    expect(venue.broadcasts.filter(order => !order.reduceOnly)).toHaveLength(1);
  });

  it("refuses a different mode or wallet identity before signing", async () => {
    const { engine, run, venue, store, options } = await setup();
    const wrongMode: TradeTestAdapter = Object.assign(Object.create(venue), { mode: "live" });
    await expect(new TradeTestEngine(store, wrongMode, options).run(run.id)).rejects.toThrow("模式");
    venue.badIdentity = true;
    expect((await engine.run(run.id)).status).toBe("paused");
    expect(venue.prepared).toHaveLength(0);
  });

  it("refuses an unrelated order discovered after the opening instead of cancelling it", async () => {
    const { engine, run, venue } = await setup();
    venue.onBroadcast = async order => {
      if (!order.reduceOnly) venue.orders.set("unrelated", { digest: "unrelated", sender: parent(wallets[0]!), productId: 92, amountX18: x(1), priceX18: x(1) });
    };
    expect((await engine.run(run.id)).status).toBe("attention");
    expect(venue.cancellations).not.toContain("unrelated");
    expect(venue.broadcasts).toHaveLength(1);
  });
});
