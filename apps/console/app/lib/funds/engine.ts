import { validatePlan } from "./planner";
import { INK_CHAIN_ID, type FundsAdapter, type FundsAuthorization, type FundsLeg, type FundsPlan, type FundsReceipt, type FundsRun, type FundsStore, type Hex } from "./types";

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const errorText = (error: unknown): string => error instanceof Error ? error.message : "未知错误，已暂停";

export interface FundsEngineOptions {
  store: FundsStore;
  adapter: FundsAdapter;
  onChange?: (run: FundsRun) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  receiptPollMs?: number;
  receiptTimeoutMs?: number;
}

/** All external calls are injected; creating a plan never signs or transfers funds. */
export class FundsEngine {
  private readonly store: FundsStore;
  private readonly adapter: FundsAdapter;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly onChange?: (run: FundsRun) => void;
  constructor(options: FundsEngineOptions) {
    this.store = options.store; this.adapter = options.adapter; this.onChange = options.onChange;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.pollMs = options.receiptPollMs ?? 2000; this.timeoutMs = options.receiptTimeoutMs ?? 90000;
  }
  private iso(): string { return new Date(this.now()).toISOString(); }
  private async update(id: string, change: (run: FundsRun) => void): Promise<FundsRun> {
    const run = await this.store.update(id, current => { change(current); current.updatedAt = this.iso(); return current; });
    this.onChange?.(run); return run;
  }
  private async requireRun(id: string): Promise<FundsRun> {
    const run = await this.store.get(id); if (!run) throw new Error("任务不存在"); return run;
  }
  async create(plan: FundsPlan): Promise<FundsRun> {
    validatePlan(plan);
    if (plan.legs.some(leg => leg.status !== "pending" || leg.authorization || leg.transaction || leg.receipt)) throw new Error("新计划不能包含已执行步骤，请恢复原任务");
    const run: FundsRun = { version: 1, revision: 0, plan: structuredClone(plan), status: "ready", updatedAt: this.iso(), stopRequested: false };
    const saved = await this.store.create(run); this.onChange?.(saved); return saved;
  }
  async pause(id: string): Promise<FundsRun> {
    return this.update(id, run => { if (run.status !== "completed") { run.stopRequested = true; run.message = "已请求暂停；已提交的交易仍会核验，不再提交下一笔"; if (run.status !== "running") run.status = "paused"; } });
  }
  /** Call once after page load. No automatic signing/broadcast after reload. */
  async recoverInterrupted(): Promise<void> {
    for (const run of await this.store.list()) {
      if (run.status !== "running") continue;
      try {
        await this.store.withTreasuryLock(run.plan.treasury.address, async () => {
          await this.update(run.plan.id, current => {
            if (current.status === "running") { current.status = "paused"; current.stopRequested = true; current.message = "上次执行已中断；请显式恢复。恢复会先核验原交易，不会重复生成授权"; }
          });
        });
      } catch { /* Another live tab still owns the treasury: do not change its state. */ }
    }
  }
  async run(id: string): Promise<FundsRun> {
    const initial = await this.requireRun(id);
    return this.store.withTreasuryLock(initial.plan.treasury.address, async () => {
      let run = await this.requireRun(id);
      if (run.status === "completed") return run;
      validatePlan(run.plan);
      run = await this.update(id, current => { current.status = "running"; current.stopRequested = false; current.message = undefined; });
      try {
        if (await this.adapter.getChainId() !== INK_CHAIN_ID) throw new Error("网络不是 Ink 主网，已停止");
        const wallets = new Map([run.plan.treasury, ...run.plan.legs.flatMap(leg => [leg.from, leg.to])].map(wallet => [wallet.id, wallet]));
        for (const wallet of wallets.values()) await this.adapter.assertIdentity(wallet);
        for (let index = 0; index < run.plan.legs.length; index += 1) {
          run = await this.requireRun(id);
          if (run.plan.legs[index]!.status === "confirmed") continue;
          if (run.stopRequested) return this.update(id, current => { current.status = "paused"; });
          const finished = await this.processLeg(id, index);
          if (!finished) return this.requireRun(id);
        }
        return this.update(id, current => { current.status = "completed"; current.stopRequested = false; current.message = "全部转账已通过链上事件与余额核验"; });
      } catch (error) {
        return this.update(id, current => { current.status = "paused"; current.message = errorText(error); });
      }
    });
  }
  private async attention(id: string, index: number, message: string): Promise<false> {
    await this.update(id, run => { run.status = "needs-attention"; run.message = message; run.plan.legs[index]!.status = "needs-attention"; run.plan.legs[index]!.error = message; });
    return false;
  }
  private async pauseBeforeSubmit(id: string): Promise<boolean> {
    if (!(await this.requireRun(id)).stopRequested) return false;
    await this.update(id, run => { run.status = "paused"; }); return true;
  }
  private assertAuthorization(leg: FundsLeg, authorization: FundsAuthorization): void {
    if (!same(authorization.from, leg.from.address) || !same(authorization.to, leg.to.address) || !/^0x[\da-fA-F]{64}$/.test(authorization.nonce) || BigInt(authorization.value) <= 0n || (leg.amount.kind === "fixed" && authorization.value !== leg.amount.units)) throw new Error("已保存的授权与转账计划不一致，禁止发送");
  }
  private async budget(plan: FundsPlan, feeWei: string): Promise<void> {
    const maximum = BigInt(feeWei);
    const spent = plan.legs.reduce((sum, leg) => sum + BigInt(leg.actualFeeWei ?? "0"), 0n);
    if (maximum <= 0n || maximum > BigInt(plan.limits.maxFeePerLegWei) || spent + maximum > BigInt(plan.limits.maxTotalFeeWei)) throw new Error("本笔最高费用超过单笔或整批预算，已暂停；未广播新交易");
    if (BigInt((await this.adapter.readWallet(plan.treasury)).ethWei) < maximum) throw new Error("资金库 ETH 不足以覆盖本笔最高费用，已暂停");
  }
  private async processLeg(id: string, index: number): Promise<boolean> {
    let run = await this.requireRun(id); let leg = run.plan.legs[index]!;
    if (leg.authorization) {
      this.assertAuthorization(leg, leg.authorization);
      const receipt = leg.transaction ? await this.adapter.getReceipt(leg.transaction.hash) : null;
      if (receipt) return this.confirm(id, index, receipt);
      if (await this.adapter.authorizationUsed(leg.authorization)) {
        const found = await this.adapter.findAuthorizationReceipt(leg.authorization, Date.parse(leg.createdAt ?? run.plan.createdAt));
        return found ? this.confirm(id, index, found) : this.attention(id, index, "授权已被使用，但尚未找到匹配的转账事件。禁止生成新授权或重复转账，请核对原交易");
      }
      if (this.now() >= Number(leg.authorization.validBefore) * 1000) return this.attention(id, index, "原授权已过期，且尚无可核验的到账记录。保留原任务等待人工核对，不自动重建付款");
    }
    if (!leg.authorization) {
      if (run.plan.kind === "batch-handoff") await this.adapter.assertTradingReady(run.plan);
      const [source, target] = await Promise.all([this.adapter.readWallet(leg.from), this.adapter.readWallet(leg.to)]);
      const value = leg.amount.kind === "all" ? source.tokenUnits : leg.amount.units;
      if (BigInt(value) <= 0n || BigInt(source.tokenUnits) < BigInt(value)) throw new Error(`${leg.from.label ?? leg.from.id} 的链上 USDT0 不足，资金尚未回到钱包或余额不足`);
      const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
      const nonce = `0x${[...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("")}` as Hex;
      const authorization: FundsAuthorization = { from: leg.from.address, to: leg.to.address, value, nonce, validAfter: Math.max(0, Math.floor(this.now() / 1000) - 30).toString(), validBefore: (Math.floor(this.now() / 1000) + run.plan.limits.authorizationTtlSeconds).toString() };
      run = await this.update(id, current => {
        const item = current.plan.legs[index]!; item.authorization = authorization; item.createdAt = this.iso();
        item.sourceEthBeforeWei = source.ethWei; item.targetEthBeforeWei = target.ethWei; item.targetTokenBeforeUnits = target.tokenUnits;
      }); leg = run.plan.legs[index]!;
    }
    const authorization = leg.authorization!;
    if (!authorization.signature) {
      if (await this.pauseBeforeSubmit(id)) return false;
      const signature = await this.adapter.signAuthorization(run.plan, leg, authorization);
      run = await this.update(id, current => { current.plan.legs[index]!.authorization!.signature = signature; current.plan.legs[index]!.status = "authorized"; }); leg = run.plan.legs[index]!;
    }
    if (!leg.transaction) {
      if (await this.pauseBeforeSubmit(id)) return false;
      if (run.plan.kind === "batch-handoff") await this.adapter.assertTradingReady(run.plan);
      const transaction = await this.adapter.prepareTransaction(run.plan, leg, leg.authorization!);
      await this.budget(run.plan, transaction.feeCeilingWei);
      run = await this.update(id, current => { current.plan.legs[index]!.transaction = transaction; current.plan.legs[index]!.status = "prepared"; }); leg = run.plan.legs[index]!;
    }
    if (await this.pauseBeforeSubmit(id)) return false;
    if (run.plan.kind === "batch-handoff") await this.adapter.assertTradingReady((await this.requireRun(id)).plan);
    await this.budget((await this.requireRun(id)).plan, leg.transaction!.feeCeilingWei);
    if (this.now() >= Number(leg.authorization!.validBefore) * 1000) return this.attention(id, index, "授权在发送前已过期，未广播新交易；请核对并保留原任务");
    await this.adapter.validatePreparedTransaction(run.plan, leg, leg.authorization!, leg.transaction!);
    if (await this.pauseBeforeSubmit(id)) return false;
    await this.update(id, current => { const item = current.plan.legs[index]!; item.status = "broadcast"; item.submittedAt ??= this.iso(); });
    if (await this.pauseBeforeSubmit(id)) return false;
    // Hash/raw bytes are durable BEFORE this call. Any retry uses those exact bytes.
    try {
      const hash = await this.adapter.broadcast(leg.transaction!.rawTransaction);
      if (!same(hash, leg.transaction!.hash)) return this.attention(id, index, "节点返回的交易哈希与已签名交易不一致，已停止");
      await this.update(id, current => { const item = current.plan.legs[index]!; item.status = "broadcast"; item.submittedAt ??= this.iso(); });
    } catch (error) {
      // A timeout can mean the node accepted the transaction. Never create another authorization.
      await this.update(id, current => { const item = current.plan.legs[index]!; item.status = "broadcast"; item.submittedAt ??= this.iso(); current.message = `广播结果待核验：${errorText(error)}`; });
    }
    const deadline = this.now() + this.timeoutMs;
    do {
      const receipt = await this.adapter.getReceipt(leg.transaction!.hash);
      if (receipt) return this.confirm(id, index, receipt);
      if ((await this.requireRun(id)).stopRequested) { await this.update(id, current => { current.status = "paused"; current.message = "已暂停；原交易仍待链上确认，恢复时会先核验"; }); return false; }
      if (this.now() >= deadline) break;
      await this.sleep(this.pollMs);
    } while (this.now() <= deadline);
    await this.update(id, current => { current.status = "paused"; current.message = "等待链上回执超时。恢复时将查询或重发同一已签名交易，不重复付款"; });
    return false;
  }
  private async confirm(id: string, index: number, receipt: FundsReceipt): Promise<boolean> {
    const run = await this.requireRun(id); const leg = run.plan.legs[index]!; const authorization = leg.authorization!;
    const actualFee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) + BigInt(receipt.l1FeeWei);
    if (receipt.status !== "success") {
      await this.update(id, current => { const item = current.plan.legs[index]!; item.receipt = receipt; item.actualFeeWei = actualFee.toString(); });
      return this.attention(id, index, "原交易已上链但执行失败，Gas 已消耗；不自动重建付款，请核对失败原因");
    }
    const transfer = receipt.transfers.find(item => same(item.token, run.plan.token) && same(item.from, authorization.from) && same(item.to, authorization.to) && item.value === authorization.value);
    const used = receipt.authorizations.some(item => same(item.authorizer, authorization.from) && same(item.nonce, authorization.nonce));
    if (!transfer || !used) return this.attention(id, index, "回执缺少正确收款人、金额或授权 nonce 的链上事件，不能认定到账");
    if (leg.transaction && !same(receipt.hash, leg.transaction.hash)) {
      // A third party can relay a public authorization. Its successful receipt does not
      // settle the treasury's pending transaction or account for a possible later revert fee.
      await this.update(id, current => { current.plan.legs[index]!.externalReceipt = receipt; });
      return this.attention(id, index, `同一授权已由另一交易完成（${receipt.hash}），但资金库原交易费用尚待核对。禁止重复付款或继续交接`);
    }
    const [source, target] = await Promise.all([this.adapter.readWallet(leg.from), this.adapter.readWallet(leg.to)]);
    if (BigInt(target.tokenUnits) < BigInt(leg.targetTokenBeforeUnits ?? "0") + BigInt(authorization.value)) return this.attention(id, index, "已找到转账事件，但目标当前余额未达到预期（可能已有其他支出），已暂停后续交接，请核对");
    await this.update(id, current => {
      const item = current.plan.legs[index]!; item.status = "confirmed"; item.receipt = receipt; item.confirmedAt = this.iso(); item.actualFeeWei = actualFee.toString();
      item.sourceEthAfterWei = source.ethWei; item.targetEthAfterWei = target.ethWei; item.targetTokenAfterUnits = target.tokenUnits; item.error = undefined;
    });
    return true;
  }
}
