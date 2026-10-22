import { assertCleanSnapshot, planClose, planOpening, requiredTestBalance } from "./planner";
import { recordTradeProgress, safeTradeMessage } from "./progress";
import type { AccountSnapshot, OrderRequest, PreparedTestOrder, TestMarket, TestOrderReport, TradeTestAdapter, TradeTestRun, TradeTestStore, WalletTest } from "./types";

const abs = (value: bigint): bigint => value < 0n ? -value : value;
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const message = safeTradeMessage;
const terminal = (wallet: WalletTest): boolean => wallet.status === "completed" || wallet.status === "unfilled";
const POLL_MS = 1500;
const unknownReport = (digest: string): TestOrderReport => ({ digest, indexed: false, volumeX18: "0", feeX18: "0", realizedPnlX18: "0" });

/** One bounded round trip per wallet. Submission acknowledgement is never treated as a fill. */
export class TradeTestEngine {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly funding?: { ensure(id: string): Promise<boolean> };
  constructor(private readonly store: TradeTestStore, private readonly adapter: TradeTestAdapter, options: { now?: () => number; sleep?: (ms: number) => Promise<void>; funding?: { ensure(id: string): Promise<boolean> } } = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.funding = options.funding;
  }

  private async load(id: string): Promise<TradeTestRun> {
    const run = await this.store.get(id);
    if (!run) throw new Error("测试任务不存在");
    return run;
  }
  private update(id: string, change: (run: TradeTestRun) => void): Promise<TradeTestRun> {
    return this.store.update(id, run => { change(run); run.updatedAt = this.now(); });
  }
  private progress(id: string, phase: string, text: string, index?: number): Promise<TradeTestRun> {
    return this.update(id, run => recordTradeProgress(run, { phase, message: text, at: this.now(),
      walletId: index === undefined ? undefined : run.wallets[index]!.wallet.id,
      current: index === undefined ? undefined : index + 1, total: index === undefined ? undefined : run.wallets.length }));
  }
  private validate(run: TradeTestRun): void {
    if (run.mode !== this.adapter.mode) throw new Error("任务与执行器模式不一致，模拟记录不能用于真实交易");
    if (run.classification !== "internal-test" || !Number.isSafeInteger(run.chainId)) throw new Error("任务网络或分类无效");
    if (!run.wallets.length || run.wallets.length > 10) throw new Error("本轮仅支持 1 至 10 个钱包");
    if (new Set(run.wallets.map(item => item.wallet.address.toLowerCase())).size !== run.wallets.length) throw new Error("测试钱包不能重复");
    if (!Number.isSafeInteger(run.settings.maxCloseAttempts) || run.settings.maxCloseAttempts < 1 || run.settings.maxCloseAttempts > 10) throw new Error("平仓尝试次数必须在 1 至 10 次之间");
    for (const value of [run.settings.quoteWaitMs, run.settings.closeWaitMs, run.settings.maxQuoteAgeMs]) {
      if (!Number.isFinite(value) || value <= 0 || value > 300_000) throw new Error("等待时间必须为有限的正数，且不能超过 5 分钟");
    }
    for (const wallet of run.wallets) {
      if (wallet.orders.filter(order => !order.prepared.reduceOnly).length > 1) throw new Error("一个钱包只能有一笔开仓订单，禁止追补成交量");
    }
  }
  private fresh(run: TradeTestRun, snapshot: AccountSnapshot): void {
    if (!Number.isFinite(snapshot.observedAt) || this.now() - snapshot.observedAt > run.settings.maxQuoteAgeMs || snapshot.observedAt > this.now() + 1000) throw new Error("账户状态已过期，停止交易并等待重新核验");
  }
  private assertOwned(run: TradeTestRun, wallet: WalletTest, snapshot: AccountSnapshot): void {
    this.fresh(run, snapshot);
    if (!wallet.before || !same(snapshot.parentSender, wallet.before.parentSender)) throw new Error("账户发起者与预检身份不一致");
    if (snapshot.hasOtherCollateral || snapshot.hasCrossPosition) throw new Error("发现其他抵押品或全仓仓位，停止自动处理");
    const opening = wallet.orders.find(order => !order.prepared.reduceOnly)?.prepared;
    if (!opening || !wallet.market) throw new Error("缺少原开仓记录，禁止推测仓位归属");
    const positions = snapshot.positions.filter(position => BigInt(position.amountX18) !== 0n);
    if (positions.length > 1) throw new Error("发现多个仓位，无法确认本次测试仓位归属");
    for (const position of positions) {
      const amount = BigInt(position.amountX18);
      if (position.productId !== opening.productId || !position.sender.toLowerCase().startsWith(wallet.wallet.address.toLowerCase()) || (amount > 0n) !== (wallet.side === "buy") || abs(amount) > abs(BigInt(opening.amountX18))) throw new Error("发现非预期仓位或数量，停止自动处理");
    }
    for (const order of snapshot.openOrders) {
      const known = wallet.orders.find(item => same(item.prepared.digest, order.digest))?.prepared;
      if (!known || order.productId !== known.productId || !same(order.sender, known.sender) || abs(BigInt(order.amountX18)) !== abs(BigInt(known.amountX18)) || BigInt(order.priceX18) !== BigInt(known.priceX18)) throw new Error("发现不属于本次任务的挂单，禁止继续自动开平仓");
    }
  }
  private async snapshot(id: string, index: number): Promise<AccountSnapshot> {
    const run = await this.load(id), wallet = run.wallets[index]!;
    await this.adapter.assertIdentity(wallet.wallet, run.chainId);
    const snapshot = await this.adapter.snapshot(wallet.wallet);
    this.assertOwned(run, wallet, snapshot);
    return snapshot;
  }
  private async chooseMarket(run: TradeTestRun, wallet: WalletTest): Promise<{ market: TestMarket; minimumBalanceX18: string }> {
    const errors: string[] = [];
    for (const symbol of run.settings.symbols) {
      try {
        const market = await this.adapter.market(symbol);
        if (market.symbol !== symbol) throw new Error("返回的市场不匹配");
        const planned = planOpening(market, run.settings, wallet.side, this.now());
        return { market, minimumBalanceX18: planned.minimumBalanceX18 };
      } catch (error) { errors.push(`${symbol}: ${message(error)}`); }
    }
    throw new Error(`没有符合条件的市场：${errors.join("；")}`);
  }

  /** The first run checks the ENTIRE cohort before preparing any signed order. */
  private async preflight(id: string, requireBalance = true): Promise<void> {
    const run = await this.load(id);
    const checked: Array<{ index: number; snapshot: AccountSnapshot; market: TestMarket }> = [];
    for (let index = 0; index < run.wallets.length; index += 1) {
      const wallet = run.wallets[index]!;
      if (terminal(wallet) || wallet.orders.length) continue;
      if ((await this.load(id)).stopRequested) return;
      await this.progress(id, "preflight", `${requireBalance ? "交易前" : "充值前"}复检 ${index + 1}/${run.wallets.length}：${wallet.wallet.label} 的余额、全部挂单和仓位（只读）`, index);
      await this.adapter.assertIdentity(wallet.wallet, run.chainId);
      const snapshot = await this.adapter.snapshot(wallet.wallet);
      this.fresh(run, snapshot); assertCleanSnapshot(snapshot);
      if (!snapshot.parentSender.toLowerCase().startsWith(wallet.wallet.address.toLowerCase())) throw new Error(`${wallet.wallet.label} 的账户身份不匹配`);
      const selected = await this.chooseMarket(run, wallet);
      if (requireBalance && BigInt(snapshot.quoteBalanceX18) < requiredTestBalance(snapshot, selected.minimumBalanceX18)) throw new Error(`${wallet.wallet.label} 的可用 USDT0 不足：还需覆盖取整后的保证金与手续费预留`);
      checked.push({ index, snapshot, market: selected.market });
    }
    await this.update(id, current => {
      for (const item of checked) { const wallet = current.wallets[item.index]!; wallet.before = item.snapshot; wallet.market = item.market; }
      recordTradeProgress(current, { phase: "preflight", message: `${requireBalance ? "交易前" : "充值前"}账户与市场复检完成`, at: this.now(), kind: "transition" });
    });
  }

  async stop(id: string): Promise<TradeTestRun> {
    return this.update(id, run => {
      if (run.status === "completed") return;
      run.stopRequested = true;
      run.message = "已停止新的充值和后续开仓；已发送的充值保留记录，当前仓位将尝试撤单和平仓";
      if (run.status !== "running") run.status = "paused";
      recordTradeProgress(run, { phase: run.progress?.phase ?? "preflight", message: run.message, at: this.now(), kind: "transition" });
    });
  }

  async run(id: string, options: { cleanupOnly?: boolean } = {}): Promise<TradeTestRun> {
    const initial = await this.load(id);
    this.validate(initial);
    return this.store.withLock(initial.chainId, async () => {
      let run = await this.load(id);
      this.validate(run);
      if (run.status === "completed") return run;
      const recovering = new Set(run.wallets.flatMap((wallet, index) => wallet.orders.length && !terminal(wallet) ? [index] : []));
      await this.update(id, current => {
        current.status = "running"; current.stopRequested = options.cleanupOnly === true; current.message = undefined;
        recordTradeProgress(current, { phase: options.cleanupOnly || recovering.size ? "closing" : current.funding ? "funding_check" : "preflight",
          message: options.cleanupOnly ? "正在核对原订单并收尾，不发起新充值或开仓" : "已启动原批次，先核对已有充值和订单记录", at: this.now(), kind: "transition" });
      });
      let activeIndex: number | undefined;
      try {
        // A surviving position is cleaned up before any fresh cohort preflight or new opening.
        for (const index of recovering) { activeIndex = index; await this.cleanupAndClose(id, index); activeIndex = undefined; }
        if (options.cleanupOnly) return this.update(id, current => {
          current.stopRequested = true;
          current.status = current.wallets.every(terminal) ? "completed" : "paused";
          current.message = "已核对并收尾原有订单；后续账户保持停止，本次没有开启新仓位";
          recordTradeProgress(current, { phase: current.status === "completed" ? "completed" : "closing", message: current.message, at: this.now(), kind: "transition" });
        });
        if ((await this.load(id)).stopRequested) return this.update(id, current => { current.status = "paused"; });
        // Funding runs under the same exclusive trading lock. A recovered position
        // is handled first; cleanup-only never initiates or continues a payment.
        if ((await this.load(id)).funding) {
          if (!this.funding) throw new Error("该批次包含自动充值，缺少充值核对器，不能直接开始交易");
          const pendingFunding = (await this.load(id)).funding!;
          // Before the first payment validate the whole cohort and the current market.
          // On recovery settle saved payment evidence before making any new decision.
          if (pendingFunding.status !== "completed" && pendingFunding.rows.every(row => !row.authorization && !row.transaction && !["credited", "skipped"].includes(row.status))) await this.preflight(id, false);
          const funded = await this.funding.ensure(id);
          if (!funded) return this.update(id, current => { current.status = "paused"; current.message = current.funding?.message ?? "充值尚未全部到账，暂停交易"; });
          const checked = await this.load(id);
          if (checked.funding?.status !== "completed" || checked.funding.rows.some(row => !["credited", "skipped"].includes(row.status))) throw new Error("充值核对未完整结束，禁止开始交易");
          if (checked.stopRequested) return this.update(id, current => { current.status = "paused"; });
        }
        await this.preflight(id);
        run = await this.load(id);
        for (let index = 0; index < run.wallets.length; index += 1) {
          run = await this.load(id);
          if (terminal(run.wallets[index]!)) continue;
          if (run.stopRequested || this.lossStop(run)) return this.update(id, current => { current.status = "paused"; current.message ??= "已达到累计损耗限制，停止后续开仓"; });
          activeIndex = index;
          await this.openOnce(id, index);
          if ((await this.load(id)).wallets[index]!.orders.length) await this.cleanupAndClose(id, index);
          activeIndex = undefined;
        }
        return this.update(id, current => {
          current.status = current.wallets.every(terminal) ? "completed" : "paused";
          current.message = current.status === "completed" ? "本轮已结束，实际成交及费用以归档记录为准；未成交部分不会补开" : "已暂停后续账户，保留原任务等待恢复";
          recordTradeProgress(current, { phase: current.status === "completed" ? "completed" : current.progress?.phase ?? "preflight", message: current.message, at: this.now(), kind: "transition" });
        });
      } catch (error) {
        // If this durable write also fails, propagate the storage error. Never continue sending.
        return this.update(id, current => {
          current.status = activeIndex === undefined ? "paused" : "attention";
          current.message = message(error);
          if (activeIndex !== undefined) { const wallet = current.wallets[activeIndex]!; wallet.status = "attention"; wallet.message = message(error); }
          recordTradeProgress(current, { phase: current.progress?.phase ?? "preflight", message: `已暂停：${current.message}`, at: this.now(),
            walletId: activeIndex === undefined ? current.progress?.walletId : current.wallets[activeIndex]!.wallet.id, kind: "error" });
        });
      }
    });
  }
  private lossStop(run: TradeTestRun): boolean {
    if (run.settings.lossLimitX18 === null) return false;
    const netLoss = run.wallets.reduce((sum, wallet) => wallet.before && wallet.after && terminal(wallet) ? sum + BigInt(wallet.before.equityX18) - BigInt(wallet.after.equityX18) : sum, 0n);
    return netLoss >= BigInt(run.settings.lossLimitX18);
  }
  private assertPrepared(request: OrderRequest, order: PreparedTestOrder, parent: string): void {
    // The adapter checks request.sender against the isolated child position, while the actual
    // current venue close order is signed by its parent with isolated margin=0 and reduce-only.
    if (!order.digest || !same(order.sender, parent) || order.productId !== request.market.productId || order.side !== request.side || order.reduceOnly !== request.reduceOnly || BigInt(order.amountX18) !== BigInt(request.amountX18) || BigInt(order.priceX18) !== BigInt(request.priceX18) || order.marginX18 !== request.marginX18 || order.expiresAt !== request.expiresAt) throw new Error("签名订单与已核对计划不一致，禁止发送");
  }
  private assertFreshOrder(run: TradeTestRun, order: TradeTestRun["wallets"][number]["orders"][number]): void {
    if (order.prepared.expiresAt <= this.now()) throw new Error("已签名订单已经到期，保留原记录且不发送");
    for (const observedAt of [order.marketObservedAt, order.accountObservedAt]) {
      if (observedAt === undefined || !Number.isFinite(observedAt) || observedAt > this.now() + 1000 || this.now() - observedAt > run.settings.maxQuoteAgeMs) throw new Error("签名后行情或账户状态已经过期，保留原订单且不发送，请恢复原任务核对收尾");
    }
  }
  private async prepareAndSend(id: string, index: number, request: OrderRequest, accountObservedAt: number): Promise<void> {
    const current = await this.load(id), wallet = current.wallets[index]!;
    if (!request.reduceOnly && current.stopRequested) return;
    const phase = request.reduceOnly ? "closing" : "opening", action = request.reduceOnly ? "平仓" : "开仓";
    await this.adapter.assertIdentity(wallet.wallet, current.chainId);
    const prepared = await this.adapter.prepare(request);
    this.assertPrepared(request, prepared, wallet.before!.parentSender);
    await this.update(id, run => {
      const item = run.wallets[index]!;
      if (!prepared.reduceOnly && item.orders.some(order => !order.prepared.reduceOnly)) throw new Error("原开仓订单已存在，禁止重复开仓");
      item.orders.push({ prepared, preparedAt: this.now(), marketObservedAt: request.market.observedAt, accountObservedAt });
      item.reports.push(unknownReport(prepared.digest));
      recordTradeProgress(run, { phase, message: `${item.wallet.label}：${action}订单已保存，尚未提交`, at: this.now(), walletId: item.wallet.id, kind: "transition", orderDigest: prepared.digest });
    });
    if (!request.reduceOnly && (await this.load(id)).stopRequested) return;
    await this.adapter.assertIdentity(wallet.wallet, current.chainId);
    const ready = await this.load(id);
    if (!request.reduceOnly && ready.stopRequested) return;
    this.assertFreshOrder(ready, ready.wallets[index]!.orders.find(order => same(order.prepared.digest, prepared.digest))!);
    await this.update(id, run => {
      run.wallets[index]!.orders.find(order => same(order.prepared.digest, prepared.digest))!.broadcastStartedAt = this.now();
      recordTradeProgress(run, { phase, message: `${wallet.wallet.label}：正在提交原${action}订单，等待 Nado 受理`, at: this.now(), walletId: wallet.wallet.id, kind: "transition", orderDigest: prepared.digest });
    });
    // Strict storage or an identity check can itself take long enough to invalidate the signed quote.
    const sending = await this.load(id);
    if (!request.reduceOnly && sending.stopRequested) return;
    this.assertFreshOrder(sending, sending.wallets[index]!.orders.find(order => same(order.prepared.digest, prepared.digest))!);
    try {
      await this.adapter.broadcast(prepared, async () => {
        // The live adapter may have awaited network configuration since the check above.
        const final = await this.load(id);
        if (!prepared.reduceOnly && final.stopRequested) throw new Error("已停止开新仓，原订单不再提交");
        this.assertFreshOrder(final, final.wallets[index]!.orders.find(order => same(order.prepared.digest, prepared.digest))!);
      });
    }
    catch (error) {
      // Transport errors may follow an accepted order. Cleanup queries the SAME digest and never reopens.
      await this.update(id, run => {
        run.wallets[index]!.orders.find(order => same(order.prepared.digest, prepared.digest))!.error = message(error);
        recordTradeProgress(run, { phase, message: `${wallet.wallet.label}：${action}提交结果待核对，先查原订单，不创建重复订单`, at: this.now(), walletId: wallet.wallet.id, kind: "error", orderDigest: prepared.digest });
      });
      return;
    }
    // A journal failure after acceptance must escape instead of being disguised as a network error.
    await this.update(id, run => {
      run.wallets[index]!.orders.find(order => same(order.prepared.digest, prepared.digest))!.acknowledgedAt = this.now();
      recordTradeProgress(run, { phase, message: `${wallet.wallet.label}：${action}订单已受理，等待实际成交与仓位确认`, at: this.now(), walletId: wallet.wallet.id, kind: "transition", orderDigest: prepared.digest });
    });
  }
  private async openOnce(id: string, index: number): Promise<void> {
    const run = await this.load(id), wallet = run.wallets[index]!;
    if (wallet.orders.length) throw new Error("已有订单的账户只能恢复收尾，不能再次开仓");
    // Recheck prior wallets: an external/manual position must never be silently carried into the next account.
    for (let prior = 0; prior < index; prior += 1) {
      const previous = run.wallets[prior]!;
      if (!terminal(previous)) throw new Error("上一账户尚未完成收尾");
      await this.progress(id, "opening", `${wallet.wallet.label} 开仓前：复核 ${previous.wallet.label} 已无挂单和仓位`, index);
      const state = await this.adapter.snapshot(previous.wallet);
      this.fresh(run, state); assertCleanSnapshot(state);
      if (!previous.before || !same(previous.before.parentSender, state.parentSender)) throw new Error("上一账户身份发生变化");
    }
    // Read this account AFTER prior-wallet checks, which may be slow for a larger cohort.
    await this.progress(id, "opening", `${wallet.wallet.label}：核对最新余额和盘口，准备一次开仓`, index);
    await this.adapter.assertIdentity(wallet.wallet, run.chainId);
    const before = await this.adapter.snapshot(wallet.wallet);
    this.fresh(run, before); assertCleanSnapshot(before);
    if (!wallet.before || !same(before.parentSender, wallet.before.parentSender)) throw new Error("预检之后账户身份发生变化");
    const selected = await this.chooseMarket(run, wallet);
    const planned = planOpening(selected.market, run.settings, wallet.side, this.now());
    this.fresh(run, before);
    if (BigInt(before.quoteBalanceX18) < requiredTestBalance(before, planned.minimumBalanceX18)) throw new Error("开仓前可用 USDT0 不足，需覆盖保证金与手续费预留");
    if ((await this.load(id)).stopRequested) return;
    await this.update(id, current => {
      const item = current.wallets[index]!; item.before = before; item.market = selected.market; item.status = "opening"; item.startedAt ??= this.now();
      recordTradeProgress(current, { phase: "opening", message: `${item.wallet.label}：准备 ${selected.market.symbol} ${item.side === "buy" ? "买入" : "卖出"}挂单`, at: this.now(), walletId: item.wallet.id, current: index + 1, total: current.wallets.length });
    });
    await this.prepareAndSend(id, index, { wallet: wallet.wallet, market: selected.market, side: wallet.side, amountX18: planned.amountX18, priceX18: planned.priceX18, marginX18: planned.marginX18, reduceOnly: false, expiresAt: this.now() + run.settings.quoteWaitMs + 60_000 }, before.observedAt);
    const deadline = this.now() + run.settings.quoteWaitMs;
    while (true) {
      const latest = await this.load(id);
      if (!latest.wallets[index]!.orders.length || latest.stopRequested) return;
      await this.progress(id, "opening", `${wallet.wallet.label}：等待开仓成交，最长 ${run.settings.quoteWaitMs / 1000} 秒；未成交不补开`, index);
      const state = await this.snapshot(id, index);
      if (state.positions.some(position => BigInt(position.amountX18) !== 0n)) {
        await this.progress(id, "opening", `${wallet.wallet.label}：已观察到实际仓位，开始撤销剩余挂单并准备平仓`, index);
        return;
      }
      if (this.now() >= deadline) return;
      await this.sleep(Math.min(POLL_MS, Math.max(1, deadline - this.now())));
    }
  }

  /** Cancel every possibly submitted digest, then require two independent clean order reads. */
  private async cancelAndVerify(id: string, index: number): Promise<AccountSnapshot> {
    const run = await this.load(id), wallet = run.wallets[index]!;
    for (const order of wallet.orders) {
      if (order.broadcastStartedAt === undefined) continue;
      await this.progress(id, "closing", `${wallet.wallet.label}：核对并撤销原订单剩余挂单`, index);
      await this.adapter.assertIdentity(wallet.wallet, run.chainId);
      await this.adapter.cancel(wallet.wallet, order.prepared);
    }
    const deadline = this.now() + run.settings.closeWaitMs;
    let clearReads = 0;
    while (true) {
      await this.progress(id, "closing", `${wallet.wallet.label}：连续复核撤单结果与剩余仓位`, index);
      const snapshot = await this.snapshot(id, index);
      clearReads = snapshot.openOrders.length ? 0 : clearReads + 1;
      if (clearReads >= 2) return snapshot;
      if (this.now() >= deadline) throw new Error("撤单尚未通过连续账户查询核实，保留原任务，不进入下一钱包");
      await this.sleep(Math.min(POLL_MS, Math.max(1, deadline - this.now())));
    }
  }
  private async cleanupAndClose(id: string, index: number): Promise<void> {
    await this.update(id, run => {
      const item = run.wallets[index]!; item.status = "closing";
      recordTradeProgress(run, { phase: "closing", message: `${item.wallet.label}：核对原订单并处理实际剩余仓位`, at: this.now(), walletId: item.wallet.id, current: index + 1, total: run.wallets.length, kind: "transition" });
    });
    let state = await this.cancelAndVerify(id, index);
    while (state.positions.some(position => BigInt(position.amountX18) !== 0n)) {
      const run = await this.load(id), wallet = run.wallets[index]!;
      const attempts = wallet.orders.filter(order => order.prepared.reduceOnly).length;
      if (attempts >= run.settings.maxCloseAttempts) throw new Error("已达到平仓尝试次数，仍有残余仓位；不会扩大数量或继续开仓");
      await this.progress(id, "closing", `${wallet.wallet.label}：准备第 ${attempts + 1}/${run.settings.maxCloseAttempts} 次只减仓平仓`, index);
      const position = state.positions.find(item => BigInt(item.amountX18) !== 0n)!;
      const market = await this.adapter.market(wallet.market!.symbol);
      if (market.productId !== wallet.market!.productId || market.symbol !== wallet.market!.symbol) throw new Error("平仓市场与原仓位不一致");
      const planned = planClose(market, run.settings, position, this.now());
      const side = BigInt(position.amountX18) > 0n ? "sell" : "buy";
      await this.prepareAndSend(id, index, { wallet: wallet.wallet, market, side, amountX18: planned.amountX18, priceX18: planned.priceX18, sender: position.sender, reduceOnly: true, expiresAt: this.now() + run.settings.closeWaitMs + 60_000 }, state.observedAt);
      const deadline = this.now() + run.settings.closeWaitMs;
      while (true) {
        await this.progress(id, "closing", `${wallet.wallet.label}：核对平仓成交及剩余仓位`, index);
        const snapshot = await this.snapshot(id, index);
        const remaining = snapshot.positions.find(item => BigInt(item.amountX18) !== 0n);
        if (!remaining || abs(BigInt(remaining.amountX18)) < abs(BigInt(position.amountX18)) || this.now() >= deadline) break;
        await this.sleep(Math.min(POLL_MS, Math.max(1, deadline - this.now())));
      }
      // IOC leftovers are reconciled/cancelled before using the freshly observed remaining quantity.
      state = await this.cancelAndVerify(id, index);
    }
    // A zero read is not enough: separately confirm flatness after the no-order barrier above.
    await this.progress(id, "closing", `${(await this.load(id)).wallets[index]!.wallet.label}：最终复核挂单和仓位均已清零`, index);
    await this.sleep(POLL_MS);
    const final = await this.snapshot(id, index);
    if (final.openOrders.length || final.positions.some(position => BigInt(position.amountX18) !== 0n)) throw new Error("最终复核仍有挂单或仓位，停止进入下一账户");
    const latest = await this.load(id);
    const uncertainOrder = latest.wallets[index]!.orders.find(order => order.broadcastStartedAt !== undefined && order.acknowledgedAt === undefined && this.now() <= order.prepared.expiresAt + 2000);
    if (uncertainOrder) throw new Error(`原${uncertainOrder.prepared.reduceOnly ? "平仓" : "开仓"}提交结果未知，当前虽已清零，仍须防止迟到受理影响本账户后续批次。原订单到期时间 ${new Date(uncertainOrder.prepared.expiresAt).toISOString()}；请在到期至少 2 秒后恢复并重新核对，当前不会进入下一钱包`);
    await this.update(id, run => {
      const wallet = run.wallets[index]!;
      wallet.after = final; wallet.finishedAt = this.now();
      // Flat snapshots alone cannot prove zero fills: an external close/liquidation may have happened.
      // Only an indexed zero-volume opening below earns the explicit "unfilled" classification.
      wallet.status = "completed";
      wallet.message = "挂单及仓位已清零，等待或核对真实成交归档；不会为了补足目标成交量再开仓";
      recordTradeProgress(run, { phase: "reporting", message: `${wallet.wallet.label}：挂单及仓位已清零，正在核对成交和费用`, at: this.now(), walletId: wallet.wallet.id, kind: "transition" });
    });
    await this.refreshWalletReports(id, index);
  }
  private async refreshWalletReports(id: string, index: number): Promise<void> {
    const run = await this.load(id), wallet = run.wallets[index]!;
    if (!wallet.orders.length) return;
    await this.progress(id, "reporting", `${wallet.wallet.label}：读取原订单的实际成交与手续费`, index);
    const submitted = wallet.orders.filter(order => order.broadcastStartedAt !== undefined);
    let reports: TestOrderReport[] = [];
    try { if (submitted.length) reports = await this.adapter.reports(wallet.wallet, submitted.map(order => order.prepared)); }
    catch { /* Keep indexed prior reports and local not-sent facts; never invent archive results. */ }
    const known = new Set(submitted.map(order => order.prepared.digest.toLowerCase()));
    if (reports.some(report => !known.has(report.digest.toLowerCase())) || new Set(reports.map(report => report.digest.toLowerCase())).size !== reports.length) throw new Error("成交归档包含非本次订单或重复记录，停止统计");
    for (const report of reports.filter(item => item.indexed)) {
      if (BigInt(report.volumeX18) < 0n) throw new Error("成交归档的名义金额不正确，停止统计");
      BigInt(report.feeX18); BigInt(report.realizedPnlX18);
    }
    await this.update(id, current => {
      const item = current.wallets[index]!;
      item.reports = item.orders.map(order => {
        if (order.broadcastStartedAt === undefined) return { ...unknownReport(order.prepared.digest), notBroadcast: true };
        const report = reports.find(entry => same(entry.digest, order.prepared.digest));
        const prior = item.reports.find(entry => same(entry.digest, order.prepared.digest));
        return report?.indexed ? report : prior?.indexed ? prior : unknownReport(order.prepared.digest);
      });
      if (terminal(item) && !item.orders.some(order => order.prepared.reduceOnly) && item.reports.length && item.reports.every(report => (report.indexed || report.notBroadcast) && BigInt(report.volumeX18) === 0n)) {
        item.status = "unfilled";
        item.message = item.reports.every(report => report.notBroadcast) ? "本地写前日志确认订单未发送，成交量和交易手续费均为 0；不会补开仓位" : "归档确认未成交，原订单已撤；不会为了补足目标成交量再开仓";
      }
      recordTradeProgress(current, { phase: "reporting", message: `${item.wallet.label}：${item.reports.every(r => r.indexed || r.notBroadcast) ? "成交与费用已核对" : "成交归档仍待返回，不按零成交统计"}`, at: this.now(), walletId: item.wallet.id, kind: "transition" });
    });
  }
  async refreshReports(id: string): Promise<TradeTestRun> {
    const run = await this.load(id);
    this.validate(run);
    return this.store.withLock(run.chainId, async () => {
      for (let index = 0; index < run.wallets.length; index += 1) await this.refreshWalletReports(id, index);
      return this.load(id);
    });
  }
}
