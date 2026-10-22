/** Write-ahead journal for one treasury payment per Nado account. No keys live here. */
import { receiptFeeWei } from "../funds/inkAdapter";
import { INK_CHAIN_ID, USDT0_ADDRESS, type FundsAdapter, type FundsAuthorization, type FundsLeg, type FundsLimits, type FundsPlan, type FundsPreparedTransaction, type FundsReceipt, type FundsWalletBalance, type Hex } from "../funds/types";
import { assertCleanSnapshot } from "./planner";
import { recordTradeProgress, safeTradeMessage } from "./progress";
import { subaccountToHex } from "@nadohq/client";
import type { AccountSnapshot, TestWallet, TradeTestRun, TradeTestStore } from "./types";

const MICRO_X18 = 10n ** 12n;
const TENTH_X18 = 10n ** 17n;
export const MIN_NADO_DEPOSIT_UNITS = 5_000_000n;
export const DEFAULT_FUNDING_LIMITS: FundsLimits = { maxFeePerLegWei: "10000000000000", maxTotalFeeWei: "100000000000000", authorizationTtlSeconds: 1800 };
const complete = (row: TestFundingRow) => row.status === "credited" || row.status === "skipped";
const uint = (value: string) => { if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error("充值金额格式无效"); return BigInt(value); };
const ceil = (v: bigint, step: bigint) => ((v + step - 1n) / step) * step;
const max = (a: bigint, b: bigint) => a > b ? a : b;
const address = (s: string) => { if (!/^0x[\da-fA-F]{40}$/.test(s) || /^0x0{40}$/i.test(s)) throw new Error("充值地址无效"); return s.toLowerCase(); };

export interface TestFundingRow {
  wallet: TestWallet; requiredX18: string; previewBalanceX18: string; targetX18: string;
  depositAddress: Hex; maxDepositUnits: string;
  status: "pending" | "intent" | "authorized" | "prepared" | "broadcast" | "confirmed" | "credited" | "skipped" | "attention";
  baselineX18?: string; amountUnits?: string; authorization?: FundsAuthorization;
  baselineSubmissionIndex?: string; creditedSubmissionIndex?: string;
  transaction?: FundsPreparedTransaction; receipt?: FundsReceipt; actualFeeWei?: string;
  createdAt?: number; broadcastStartedAt?: number; confirmedAt?: number; creditedAt?: number; creditedEventAt?: number; message?: string;
}
export interface TestFundingState {
  version: 1; treasury: TestWallet; rows: TestFundingRow[]; limits: FundsLimits;
  status: "ready" | "running" | "paused" | "completed"; message?: string;
}
export interface TestFundingAdapter {
  funds: FundsAdapter;
  assertIdentity(wallet: TestWallet, chainId: number): Promise<void>;
  snapshot(wallet: TestWallet): Promise<AccountSnapshot>;
  fundingBalance(wallet: TestWallet): Promise<Pick<AccountSnapshot, "parentSender" | "quoteBalanceX18" | "observedAt">>;
  depositEvents(wallet: TestWallet): Promise<FundingDepositEvent[]>;
  getDepositAddress(wallet: TestWallet): Promise<Hex>;
  readTreasury(wallet: TestWallet): Promise<FundsWalletBalance>;
  withTreasuryLock<T>(address: string, task: () => Promise<T>): Promise<T>;
}
export interface FundingDepositEvent { submissionIndex: string; at: number; deltaX18: string }
export interface FundingPreviewRow { wallet: TestWallet; requiredX18: string; balanceX18: string; depositAddress: Hex }
export function createFundingState(treasury: TestWallet, rows: FundingPreviewRow[]): TestFundingState {
  address(treasury.address);
  if (!rows.length || rows.length > 10 || new Set(rows.map(r => r.wallet.id)).size !== rows.length || new Set(rows.map(r => address(r.wallet.address))).size !== rows.length || new Set(rows.map(r => address(r.depositAddress))).size !== rows.length) throw new Error("充值计划必须包含 1–10 个不同账户及专属充值地址");
  return { version: 1, treasury: structuredClone(treasury), limits: { ...DEFAULT_FUNDING_LIMITS }, status: "ready", rows: rows.map(row => {
    if (address(row.depositAddress) === address(treasury.address) || address(row.depositAddress) === USDT0_ADDRESS.toLowerCase()) throw new Error("充值目标不能是资金库或代币合约");
    const required = uint(row.requiredX18), balance = uint(row.balanceX18);
    if (required <= 0n) throw new Error("最低可用余额必须大于零");
    const target = balance >= required ? required : ceil(required, TENTH_X18);
    const amount = balance >= required ? 0n : max(MIN_NADO_DEPOSIT_UNITS, ceil(target - balance, MICRO_X18) / MICRO_X18);
    return { wallet: structuredClone(row.wallet), requiredX18: required.toString(), previewBalanceX18: balance.toString(), targetX18: target.toString(), depositAddress: row.depositAddress, maxDepositUnits: amount.toString(), status: "pending" };
  }) };
}

/** Immutable spend-bearing fields, useful to a durable store's update guard. */
export function fundingPlanIdentity(state: TestFundingState | undefined): string {
  return JSON.stringify(state && { version: state.version, treasury: state.treasury, limits: state.limits, rows: state.rows.map(({ wallet, requiredX18, previewBalanceX18, targetX18, depositAddress, maxDepositUnits }) => ({ wallet, requiredX18, previewBalanceX18, targetX18, depositAddress, maxDepositUnits })) });
}
export function fundingTotals(state: TestFundingState, treasuryBalance: FundsWalletBalance) {
  const pending = state.rows.filter(r => !complete(r) && !r.receipt);
  const planned = state.rows.reduce((n, r) => n + uint(r.maxDepositUnits), 0n);
  const remaining = pending.reduce((n, r) => n + uint(r.amountUnits ?? r.maxDepositUnits), 0n);
  const actual = state.rows.reduce((n, r) => n + uint(r.actualFeeWei ?? "0"), 0n);
  const neededEth = pending.filter(r => uint(r.amountUnits ?? r.maxDepositUnits) > 0n).reduce((n, r) => n + uint(r.transaction?.feeCeilingWei ?? state.limits.maxFeePerLegWei), 0n);
  return { plannedUnits: planned.toString(), remainingUnits: remaining.toString(), shortfallUnits: max(0n, remaining - uint(treasuryBalance.tokenUnits)).toString(), requiredEthWei: neededEth.toString(), ethShortfallWei: max(0n, neededEth - uint(treasuryBalance.ethWei)).toString(), actualFeeWei: actual.toString() };
}

type Options = { now?: () => number; sleep?: (ms: number) => Promise<void>; nonce?: () => Hex; pollMs?: number; waitMs?: number };
class FundingPause extends Error {}
export class TradeFundingController {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly nonce: () => Hex;
  private readonly pollMs: number;
  private readonly waitMs: number;
  constructor(private readonly store: TradeTestStore, private readonly adapter: TestFundingAdapter, options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.nonce = options.nonce ?? (() => { const bytes = new Uint8Array(32); crypto.getRandomValues(bytes); return `0x${Array.from(bytes, n => n.toString(16).padStart(2, "0")).join("")}`; });
    this.pollMs = options.pollMs ?? 1500; this.waitMs = options.waitMs ?? 45_000;
  }
  private async run(id: string): Promise<TradeTestRun & { funding: TestFundingState }> {
    const run = await this.store.get(id); if (!run?.funding) throw new Error("充值计划不存在");
    return run as TradeTestRun & { funding: TestFundingState };
  }
  private async stopped(id: string) { return (await this.run(id)).stopRequested; }
  private async stopGuard(id: string) { if (await this.stopped(id)) throw new FundingPause("已停止；保留原充值记录，恢复时先核查到账"); }
  private record(run: TradeTestRun, phase: "funding_check" | "funding" | "credit", message: string, index?: number, kind: "progress" | "transition" | "error" = "progress", txHash?: string) {
    const row = index === undefined ? undefined : run.funding?.rows[index];
    recordTradeProgress(run, { phase, message, at: this.now(), kind, ...(row ? { walletId: row.wallet.id, current: index! + 1, total: run.funding!.rows.length } : {}), ...(txHash ? { txHash } : {}) });
    if (run.funding) run.funding.message = message;
  }
  private async progress(id: string, phase: "funding_check" | "funding" | "credit", message: string, index?: number, txHash?: string) { await this.store.update(id, run => this.record(run, phase, message, index, "progress", txHash)); }
  private async change(id: string, index: number, change: (row: TestFundingRow, run: TradeTestRun) => void) { await this.store.update(id, run => { if (!run.funding) throw new Error("充值计划消失"); change(run.funding.rows[index]!, run); }); }
  private async freshRead<T extends Pick<AccountSnapshot, "parentSender" | "quoteBalanceX18" | "observedAt">>(id: string, index: number, phase: "funding_check" | "credit", read: (wallet: TestWallet) => Promise<T>): Promise<T> {
    const row = (await this.run(id)).funding.rows[index]!, wallet = row.wallet;
    const expected = subaccountToHex({ subaccountOwner: wallet.address, subaccountName: "default" }).toLowerCase();
    for (let attempt = 0; attempt < 3; attempt++) {
      const value = await read(wallet);
      if (typeof value.parentSender !== "string" || value.parentSender.toLowerCase() !== expected) throw new Error(`${wallet.label} 充值账户身份不匹配；已停止，不能用重试绕过身份检查`);
      if (!Number.isFinite(value.observedAt) || value.observedAt <= 0) throw new Error(`${wallet.label} 充值余额读取时间无效`);
      const age = this.now() - value.observedAt;
      if (age < -1000) throw new Error(`${wallet.label} 充值余额读取时间在未来；请核对本地与服务时钟`);
      if (age <= 5000) return value;
      if (age > 30_000 || attempt === 2) throw new FundingPause(`${wallet.label} 充值余额读取已过期（${(age / 1000).toFixed(1)} 秒），暂停等待新数据；身份核验已通过，原充值不会重复发送`);
      await this.progress(id, phase, `${wallet.label} 充值余额数据已过期（${(age / 1000).toFixed(1)} 秒），正在重新读取 ${attempt + 1} / 2；只重读，不重复付款`, index, row.transaction?.hash ?? row.receipt?.hash);
      await this.stopGuard(id); await this.sleep(250);
    }
    throw new FundingPause("充值余额读取未完成");
  }
  private async readClean(id: string, index: number): Promise<AccountSnapshot> {
    const value = await this.freshRead(id, index, "funding_check", wallet => this.adapter.snapshot(wallet));
    assertCleanSnapshot(value); return value;
  }
  private readFundingBalance(id: string, index: number, phase: "funding_check" | "credit") {
    return this.freshRead(id, index, phase, wallet => this.adapter.fundingBalance(wallet));
  }
  private async mapping(row: TestFundingRow) { if (address(await this.adapter.getDepositAddress(row.wallet)) !== address(row.depositAddress)) throw new Error("Nado 专属充值地址已改变，停止付款并保留原记录"); }
  private plan(run: TradeTestRun & { funding: TestFundingState }, index: number): { plan: FundsPlan; leg: FundsLeg } {
    const state = run.funding, row = state.rows[index]!;
    const leg: FundsLeg = { id: `deposit:${index}`, from: state.treasury, to: { id: `dda:${row.wallet.id}`, address: row.depositAddress }, amount: { kind: "fixed", units: row.amountUnits ?? row.maxDepositUnits }, status: "pending" };
    const plan: FundsPlan = { id: `${run.id}:funding`, dedupeKey: `${run.id}:funding`, kind: "nado-deposit", chainId: INK_CHAIN_ID, token: USDT0_ADDRESS, treasury: state.treasury, legs: [leg], limits: state.limits, createdAt: new Date(run.createdAt).toISOString() };
    return { plan, leg };
  }
  private verifyReceipt(row: TestFundingRow, receipt: FundsReceipt) {
    const a = row.authorization;
    if (!a || !/^0x[\da-fA-F]{64}$/.test(receipt.hash) || receipt.status !== "success") throw new Error("原充值交易失败或缺少有效回执；不会重新付款");
    const transfers = receipt.transfers.filter(t => address(t.token) === USDT0_ADDRESS.toLowerCase() && address(t.from) === address(a.from) && address(t.to) === address(a.to) && uint(t.value) === uint(a.value));
    const auths = receipt.authorizations.filter(v => address(v.authorizer) === address(a.from) && v.nonce.toLowerCase() === a.nonce.toLowerCase());
    if (transfers.length !== 1 || auths.length !== 1) throw new Error("充值回执缺少唯一匹配的 Transfer 和 AuthorizationUsed 事件");
    if (!Number.isFinite(receipt.blockTimestampMs) || receipt.blockTimestampMs < (row.createdAt ?? Infinity) - 120_000) throw new Error("充值回执时间不匹配");
    receiptFeeWei(receipt);
  }
  private async receipt(id: string, index: number): Promise<boolean> {
    const row = (await this.run(id)).funding.rows[index]!;
    if (!row.authorization) return false;
    let receipt: FundsReceipt | null = null;
    if (row.receipt) {
      // Recheck the recorded block after a page restart; a reorg never becomes a second payment.
      receipt = await this.adapter.funds.getReceipt(row.receipt.hash);
      if (!receipt) throw new FundingPause("原充值回执暂未确认，等待节点确认后恢复，禁止补发另一笔");
      if (receipt.hash.toLowerCase() !== row.receipt.hash.toLowerCase()) throw new Error("充值回执哈希不匹配");
    } else if (row.transaction) {
      receipt = await this.adapter.funds.getReceipt(row.transaction.hash);
      if (receipt && receipt.hash.toLowerCase() !== row.transaction.hash.toLowerCase()) throw new Error("充值回执返回了其他交易");
    }
    if (!receipt && await this.adapter.funds.authorizationUsed(row.authorization)) {
      receipt = await this.adapter.funds.findAuthorizationReceipt(row.authorization, row.createdAt!);
      if (!receipt) throw new FundingPause("原充值授权已使用但回执未核实；等待核查，禁止再次付款");
    }
    if (!receipt) return false;
    if (receipt.status === "reverted") {
      const failed = receipt;
      await this.change(id, index, item => { item.receipt = failed; item.actualFeeWei = receiptFeeWei(failed).toString(); item.status = "attention"; item.message = "原充值交易回退，已记录消耗的 ETH；不会自动重新付款"; });
      throw new FundingPause("原充值交易回退，已记录实际手续费；请核查原交易，不会重新付款");
    }
    this.verifyReceipt(row, receipt);
    await this.change(id, index, (item, current) => {
      const firstConfirmation = item.confirmedAt === undefined;
      item.receipt = receipt!; item.actualFeeWei = receiptFeeWei(receipt!).toString(); item.status = "confirmed"; item.confirmedAt ??= this.now(); item.message = "Ink 转账已确认，等待 Nado 账户入账";
      if (firstConfirmation) this.record(current, "credit", `${item.wallet.label} 的 Ink 转账已确认，正在核对 Nado 入账`, index, "transition", receipt!.hash);
    });
    return true;
  }
  private async credit(id: string, index: number): Promise<boolean> {
    const row = (await this.run(id)).funding.rows[index]!;
    if (!row.receipt || row.baselineX18 === undefined || !row.amountUnits) return false;
    // Credit evidence needs only this account's current collateral balance. The
    // full no-position/no-order checks remain before a payment and before trading.
    const snapshot = await this.readFundingBalance(id, index, "credit");
    // Nado's interest-normalized balances can round by a few X18 wei. Allow at most
    // one token micro-unit, require the matching new deposit event AND usable funds.
    const expected = uint(row.amountUnits) * MICRO_X18;
    const events = await this.adapter.depositEvents(row.wallet);
    if (row.baselineSubmissionIndex === undefined || !/^(?:-1|\d+)$/.test(row.baselineSubmissionIndex)) throw new Error("缺少充值前的入账记录基线");
    const matching = events.filter(event => BigInt(event.submissionIndex) > BigInt(row.baselineSubmissionIndex!) && event.at >= row.createdAt! - 120_000 && event.at >= row.receipt!.blockTimestampMs - 2000 && event.at <= this.now() + 1000 && BigInt(event.deltaX18) >= expected - MICRO_X18 && BigInt(event.deltaX18) <= expected + MICRO_X18);
    if (matching.length > 1) throw new Error("出现多条同额充值记录，需核查后再开始交易");
    if (!matching.length || uint(snapshot.quoteBalanceX18) + MICRO_X18 < uint(row.baselineX18) + expected || uint(snapshot.quoteBalanceX18) < uint(row.requiredX18)) return false;
    await this.change(id, index, (item, current) => {
      const firstCredit = item.creditedAt === undefined;
      item.status = "credited"; item.creditedAt ??= this.now(); item.creditedEventAt ??= matching[0]!.at; item.creditedSubmissionIndex = matching[0]!.submissionIndex; item.message = "链上转账及 Nado 全额到账均已确认";
      if (firstCredit) this.record(current, "credit", `${item.wallet.label} 已核实全额到账`, index, "transition", item.receipt!.hash);
    });
    return true;
  }
  private async waitForCredit(id: string, index: number): Promise<void> {
    const row = (await this.run(id)).funding.rows[index]!;
    await this.progress(id, "credit", `正在核对 ${row.wallet.label} 的原交易和 Nado 入账；未确认前不会再充值`, index, row.transaction?.hash ?? row.receipt?.hash);
    const deadline = this.now() + this.waitMs;
    do {
      if (await this.receipt(id, index) && await this.credit(id, index)) return;
      if (await this.stopped(id)) throw new FundingPause("已停止；原充值仍待确认，恢复只核查原记录");
      if (this.now() >= deadline) break;
      await this.sleep(this.pollMs);
    } while (this.now() <= deadline);
    throw new FundingPause("充值已记录，等待链上确认或 Nado 全额入账；稍后恢复，程序不会重复充值");
  }
  private async balanceGuard(id: string, unsignedAmounts?: Map<string, string>) {
    const run = await this.run(id), sampled = structuredClone(run.funding);
    for (const row of sampled.rows) if (!complete(row) && !row.authorization && unsignedAmounts?.has(row.wallet.id)) row.amountUnits = unsignedAmounts.get(row.wallet.id)!;
    await this.progress(id, "funding_check", "正在核对 1 号资金库余额及剩余充值 Gas 预算");
    const totals = fundingTotals(sampled, await this.adapter.readTreasury(run.funding.treasury));
    if (uint(totals.shortfallUnits) > 0n) throw new FundingPause(`1 号资金库链上 USDT0 不足，还需 ${(Number(totals.shortfallUnits) / 1e6).toFixed(6)} USDT0`);
    if (uint(totals.ethShortfallWei) > 0n) throw new FundingPause("1 号资金库 Ink ETH 不足以覆盖剩余充值费用上限");
    if (uint(totals.actualFeeWei) + uint(totals.requiredEthWei) > uint(run.funding.limits.maxTotalFeeWei)) throw new FundingPause("充值累计费用预算不足，已停止新增付款");
  }
  private async resumePrepared(id: string, index: number): Promise<void> {
    const run = await this.run(id), row = run.funding.rows[index]!;
    if (!row.transaction || !row.authorization) throw new Error("原充值交易记录不完整");
    if (BigInt(row.authorization.validBefore) <= BigInt(Math.floor(this.now() / 1000) + 30)) throw new FundingPause("原充值授权已过期；保留原记录，不生成新授权或新付款");
    await this.progress(id, "funding_check", `正在核对 ${row.wallet.label} 原充值的资金库余额`, index, row.transaction.hash);
    const balance = await this.adapter.readTreasury(run.funding.treasury);
    if (uint(balance.tokenUnits) < uint(row.amountUnits!)) throw new FundingPause("原充值可能已扣款但回执仍待确认；先核查原交易，不开始新充值");
    const { plan, leg } = this.plan(run, index);
    await this.stopGuard(id);
    await this.progress(id, "funding", `正在验证 ${row.wallet.label} 已保存的原充值交易`, index, row.transaction.hash);
    await this.adapter.funds.validatePreparedTransaction(plan, leg, row.authorization, row.transaction);
    await this.stopGuard(id);
    await this.change(id, index, (item, current) => { item.broadcastStartedAt ??= this.now(); item.status = "broadcast"; this.record(current, "funding", `正在提交 ${item.wallet.label} 的原交易；沿用原哈希，不创建新付款`, index, "transition", item.transaction!.hash); });
    await this.stopGuard(id);
    const hash = await this.adapter.funds.broadcast(row.transaction.rawTransaction);
    if (hash.toLowerCase() !== row.transaction.hash.toLowerCase()) throw new Error("充值提交哈希与保存交易不一致");
    await this.waitForCredit(id, index);
  }
  private async resolveIntent(id: string, index: number): Promise<void> {
    const run = await this.run(id), row = run.funding.rows[index]!;
    if (complete(row) || row.authorization) return;
    await this.progress(id, "funding_check", `正在复核 ${index + 1} / ${run.funding.rows.length} 号充值地址及账户余额`, index);
    // The caller has just checked this exact mapping; do not repeat the same DDA read.
    await this.stopGuard(id);
    const snapshot = await this.readClean(id, index), balance = uint(snapshot.quoteBalanceX18);
    if (balance >= uint(row.requiredX18)) { await this.change(id, index, item => { item.status = "skipped"; item.amountUnits = "0"; item.message = "余额已满足预检，无需充值"; }); return; }
    const amount = max(MIN_NADO_DEPOSIT_UNITS, ceil(uint(row.targetX18) - balance, MICRO_X18) / MICRO_X18);
    if (amount > uint(row.maxDepositUnits)) throw new FundingPause("账户余额下降，所需充值超过已保存上限；请核查，禁止自动超额补款");
    await this.progress(id, "funding_check", `正在核对 ${row.wallet.label} 的专属地址是否已有待处理充值`, index);
    const pendingDda = await this.adapter.funds.readWallet({ id: `dda:${row.wallet.id}`, address: row.depositAddress });
    if (uint(pendingDda.tokenUnits) !== 0n) throw new FundingPause("该专属充值地址已有待处理 USDT0，先等待原充值入账，禁止叠加付款");
    await this.progress(id, "funding_check", `正在读取 ${row.wallet.label} 的充值前入账记录`, index);
    const events = await this.adapter.depositEvents(row.wallet);
    const baselineSubmissionIndex = events.reduce((n, event) => max(n, uint(event.submissionIndex)), -1n).toString();
    const at = this.now(), nonce = this.nonce();
    if (!/^0x[\da-fA-F]{64}$/.test(nonce) || run.funding.rows.some(r => r.authorization?.nonce.toLowerCase() === nonce.toLowerCase())) throw new Error("充值授权序号无效或重复");
    const authorization: FundsAuthorization = { from: run.funding.treasury.address, to: row.depositAddress, value: amount.toString(), nonce, validAfter: Math.max(0, Math.floor(at / 1000) - 60).toString(), validBefore: (Math.floor(at / 1000) + run.funding.limits.authorizationTtlSeconds).toString() };
    await this.stopGuard(id);
    await this.change(id, index, item => { item.baselineX18 = balance.toString(); item.baselineSubmissionIndex = baselineSubmissionIndex; item.amountUnits = amount.toString(); item.authorization = authorization; item.createdAt = at; item.status = "intent"; });
  }
  /** Budget-only observations. No nonce or expiry is created while awaiting a top-up. */
  private async sampleUnsignedAmounts(id: string): Promise<Map<string, string>> {
    const run = await this.run(id), amounts = new Map<string, string>();
    for (let i = 0; i < run.funding.rows.length; i++) {
      await this.stopGuard(id);
      const row = run.funding.rows[i]!;
      if (complete(row) || row.authorization) continue;
      await this.progress(id, "funding_check", `正在核对 ${i + 1} / ${run.funding.rows.length} 号 Nado 余额差额；此步尚未付款`, i);
      // This is a budget observation only. Every payment recipient is checked for
      // positions/orders again when resolving its intent and before signing.
      const balance = uint((await this.readFundingBalance(id, i, "funding_check")).quoteBalanceX18);
      if (balance >= uint(row.requiredX18)) { await this.change(id, i, item => { item.status = "skipped"; item.amountUnits = "0"; item.message = "余额已满足预检，无需充值"; }); continue; }
      const amount = max(MIN_NADO_DEPOSIT_UNITS, ceil(uint(row.targetX18) - balance, MICRO_X18) / MICRO_X18);
      if (amount > uint(row.maxDepositUnits)) throw new FundingPause("账户余额下降，所需充值超过已保存上限；请核查，禁止自动超额补款");
      amounts.set(row.wallet.id, amount.toString());
    }
    return amounts;
  }
  async ensure(id: string): Promise<boolean> {
    const initial = await this.run(id);
    return this.adapter.withTreasuryLock(initial.funding.treasury.address, async () => {
      try {
        let run = await this.run(id);
        if (run.chainId !== INK_CHAIN_ID || await this.adapter.funds.getChainId() !== INK_CHAIN_ID) throw new Error("自动充值只支持 Ink 主网");
        if (run.wallets.some(w => w.orders.length) && run.funding.rows.some(r => !complete(r))) throw new Error("批次已有交易订单但充值未完整结束，禁止继续充值");
        if (fundingPlanIdentity(run.funding) !== fundingPlanIdentity(initial.funding)) throw new Error("充值计划已改变");
        if (run.funding.version !== 1 || run.funding.rows.length !== run.wallets.length || run.funding.treasury.id !== run.wallets[0]!.wallet.id || address(run.funding.treasury.address) !== address(run.wallets[0]!.wallet.address)) throw new Error("充值账户或资金库与交易批次不匹配");
        if (uint(run.funding.limits.maxFeePerLegWei) <= 0n || uint(run.funding.limits.maxFeePerLegWei) > uint(DEFAULT_FUNDING_LIMITS.maxFeePerLegWei) || uint(run.funding.limits.maxTotalFeeWei) <= 0n || uint(run.funding.limits.maxTotalFeeWei) > uint(DEFAULT_FUNDING_LIMITS.maxTotalFeeWei) || !Number.isInteger(run.funding.limits.authorizationTtlSeconds) || run.funding.limits.authorizationTtlSeconds < 60 || run.funding.limits.authorizationTtlSeconds > DEFAULT_FUNDING_LIMITS.authorizationTtlSeconds) throw new Error("充值费用或授权时限超过允许范围");
        for (let i = 0; i < run.funding.rows.length; i++) {
          const row = run.funding.rows[i]!;
          if (row.wallet.id !== run.wallets[i]!.wallet.id || address(row.wallet.address) !== address(run.wallets[i]!.wallet.address) || uint(row.targetX18) < uint(row.requiredX18)) throw new Error("保存的充值账户或额度不匹配");
          if (row.amountUnits !== undefined && uint(row.amountUnits) > uint(row.maxDepositUnits)) throw new Error("保存的充值超过已确认上限");
          if (row.authorization && (address(row.authorization.from) !== address(run.funding.treasury.address) || address(row.authorization.to) !== address(row.depositAddress) || row.authorization.value !== row.amountUnits || row.baselineX18 === undefined || !row.createdAt)) throw new Error("保存的充值授权与计划不匹配");
        }
        await this.progress(id, "funding_check", "正在核对 1 号资金库身份和 Ink 主网配置");
        await this.adapter.assertIdentity(run.funding.treasury, run.chainId);
        for (const [i, row] of run.funding.rows.entries()) {
          await this.progress(id, "funding_check", `正在核对 ${i + 1} / ${run.funding.rows.length} 号账户身份及专属充值地址`, i);
          await this.adapter.assertIdentity(row.wallet, run.chainId); await this.mapping(row);
        }
        if (await this.stopped(id)) {
          for (let i = 0; i < run.funding.rows.length; i++) if (!complete(run.funding.rows[i]!) && run.funding.rows[i]!.authorization && await this.receipt(id, i)) await this.credit(id, i);
          throw new FundingPause("已停止；未开始新的充值，已核查可确认的原交易");
        }
        await this.store.update(id, current => { current.funding!.status = "running"; current.funding!.message = "先补足每户 Nado 余额，全部到账后才开始交易"; });
        // Reconcile prior broadcast before checking balances: it may already have debited treasury.
        for (let i = 0; i < run.funding.rows.length; i++) {
          const row = (await this.run(id)).funding.rows[i]!;
          if (row.authorization) await this.progress(id, "credit", `正在核查 ${row.wallet.label} 的原充值记录；先核对原交易再决定后续步骤`, i, row.transaction?.hash ?? row.receipt?.hash);
          if (row.status === "credited" && !run.wallets.some(wallet => wallet.orders.length)) {
            if (!await this.receipt(id, i)) throw new FundingPause("已充值账户的原回执暂不可验证，禁止开始交易");
            await this.waitForCredit(id, i);
          }
          if (!complete(row) && row.authorization) {
            if (await this.receipt(id, i)) await this.waitForCredit(id, i);
            else if (row.transaction) await this.resumePrepared(id, i);
          }
        }
        // Resolve unsigned deficits only in memory. A budget pause must not start
        // authorization expiry for an untouched account or poison next-day recovery.
        const unsignedAmounts = await this.sampleUnsignedAmounts(id);
        await this.balanceGuard(id, unsignedAmounts);
        for (let i = 0; i < run.funding.rows.length; i++) {
          await this.stopGuard(id);
          run = await this.run(id); let row = run.funding.rows[i]!;
          if (complete(row)) continue;
          await this.progress(id, "funding_check", `正在复核 ${i + 1} / ${run.funding.rows.length} 号专属充值地址`, i);
          await this.mapping(row);
          await this.resolveIntent(id, i);
          row = (await this.run(id)).funding.rows[i]!;
          if (complete(row)) continue;
          if (!row.authorization) throw new Error("充值意图尚未持久化");
          await this.balanceGuard(id, unsignedAmounts); await this.stopGuard(id);
          run = await this.run(id); row = run.funding.rows[i]!;
          await this.progress(id, "credit", `正在核对 ${row.wallet.label} 原授权是否已使用；防止重复付款`, i, row.transaction?.hash);
          if (await this.receipt(id, i)) { await this.waitForCredit(id, i); continue; }
          if (BigInt(row.authorization!.validBefore) <= BigInt(Math.floor(this.now() / 1000) + 30)) throw new FundingPause("原充值授权已过期；保留原记录，不生成新授权或新付款");
          const { plan, leg } = this.plan(run, i);
          if (!row.authorization!.signature) {
            await this.progress(id, "funding_check", `正在进行 ${row.wallet.label} 充值签名前的最后余额检查`, i);
            const current = await this.readClean(id, i), currentBalance = uint(current.quoteBalanceX18);
            if (currentBalance >= uint(row.requiredX18)) { await this.change(id, i, item => { item.status = "skipped"; item.message = "签名前账户余额已补足，未签名或发送本笔充值"; }); continue; }
            if (currentBalance + MICRO_X18 < uint(row.baselineX18!)) throw new FundingPause("充值前账户余额减少，原充值计划可能不足，停止签名");
            await this.stopGuard(id);
            await this.progress(id, "funding", `正在为 ${row.wallet.label} 签署已保存的充值授权；此步尚未广播`, i);
            const signature = await this.adapter.funds.signAuthorization(plan, leg, row.authorization!);
            await this.change(id, i, item => { item.authorization!.signature = signature; item.status = "authorized"; });
          }
          await this.stopGuard(id); row = (await this.run(id)).funding.rows[i]!;
          if (!row.transaction) {
            await this.progress(id, "funding", `正在为 ${row.wallet.label} 准备并核算充值交易费用；此步尚未广播`, i);
            const transaction = await this.adapter.funds.prepareTransaction(plan, leg, row.authorization!);
            if (uint(transaction.feeCeilingWei) > uint(run.funding.limits.maxFeePerLegWei)) throw new Error("充值费用超过单笔上限");
            await this.change(id, i, item => { item.transaction = transaction; item.status = "prepared"; });
          }
          await this.stopGuard(id); await this.balanceGuard(id, unsignedAmounts);
          row = (await this.run(id)).funding.rows[i]!;
          await this.progress(id, "funding", `正在验证 ${row.wallet.label} 已保存的充值交易`, i, row.transaction!.hash);
          await this.adapter.funds.validatePreparedTransaction(plan, leg, row.authorization!, row.transaction!);
          await this.stopGuard(id);
          await this.change(id, i, (item, current) => { item.broadcastStartedAt ??= this.now(); item.status = "broadcast"; this.record(current, "funding", `正在提交 ${item.wallet.label} 的充值交易`, i, "transition", item.transaction!.hash); });
          await this.stopGuard(id);
          const hash = await this.adapter.funds.broadcast(row.transaction!.rawTransaction);
          if (hash.toLowerCase() !== row.transaction!.hash.toLowerCase()) throw new Error("充值提交哈希与保存交易不一致");
          await this.waitForCredit(id, i);
        }
        await this.stopGuard(id);
        await this.store.update(id, current => { if (current.funding!.rows.some(row => !complete(row))) throw new Error("仍有未完成充值"); current.funding!.status = "completed"; this.record(current, "credit", "所有账户入账已确认，可以重新预检并开始交易", undefined, "transition"); });
        return true;
      } catch (error) {
        const message = safeTradeMessage(error);
        await this.store.update(id, current => {
          current.funding!.status = "paused"; current.funding!.message = message; current.message = message; current.status = "paused";
          const previous = current.progress;
          const txHash = current.events?.at(-1)?.txHash;
          recordTradeProgress(current, { phase: previous?.phase ?? "funding_check", message, at: this.now(), kind: "error", ...(previous?.walletId ? { walletId: previous.walletId } : {}), ...(previous?.current !== undefined ? { current: previous.current } : {}), ...(previous?.total !== undefined ? { total: previous.total } : {}), ...(txHash ? { txHash } : {}) });
        });
        return false;
      }
    });
  }
}
