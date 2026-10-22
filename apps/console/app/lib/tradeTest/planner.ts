import { formatUnits, parseUnits } from "viem";
import { progressReport, safeTradeMessage } from "./progress";
import type { AccountSnapshot, TestMarket, TestPosition, TestSettings, TestWallet, TradeTestRun } from "./types";

export const X18 = 10n ** 18n;
const MICRO = 10n ** 12n;
const ceil = (value: bigint, step: bigint) => ((value + step - 1n) / step) * step;
export const human = (value: string | undefined) => value === undefined ? "—" : formatUnits(BigInt(value), 18);
export function requiredTestBalance(snapshot: AccountSnapshot, baseMinimumX18: string): bigint {
  const reserve = BigInt(snapshot.fixedFeeReserveX18 ?? "0");
  if (reserve < 0n) throw new Error("固定手续费预留无效");
  return BigInt(baseMinimumX18) + reserve;
}
export const DEFAULT_TEST_SETTINGS: TestSettings = {
  symbols: ["EURUSD-PERP", "GBPUSD-PERP", "USDJPY-PERP"],
  leverage: 20, targetNotionalX18: parseUnits("100", 18).toString(), marginX18: parseUnits("5", 18).toString(),
  quoteWaitMs: 60_000, closeWaitMs: 5_000, maxCloseAttempts: 3,
  maxSpreadBps: 10, maxSlippageBps: 10, maxQuoteAgeMs: 5_000, lossLimitX18: null,
};

export function validateSettings(settings: TestSettings): void {
  if (!settings.symbols.length || settings.symbols.length > 8 || new Set(settings.symbols).size !== settings.symbols.length || settings.symbols.some(s => !/^[A-Z0-9]+-PERP$/.test(s))) throw new Error("请明确选择永续市场，不能自动使用默认品种");
  if (!Number.isInteger(settings.leverage) || settings.leverage < 1 || settings.leverage > 20) throw new Error("首批测试杠杆必须在 1 到 20 倍之间");
  if (BigInt(settings.targetNotionalX18) <= 0n || BigInt(settings.targetNotionalX18) > 150n * X18 || BigInt(settings.marginX18) <= 0n) throw new Error("首批单笔目标必须大于零且不超过 150U");
  if (settings.lossLimitX18 !== null && BigInt(settings.lossLimitX18) <= 0n) throw new Error("损耗上限必须为正数，或明确选择不设上限");
  if (!Number.isFinite(settings.quoteWaitMs) || settings.quoteWaitMs < 1_000 || settings.quoteWaitMs > 300_000 || !Number.isFinite(settings.closeWaitMs) || settings.closeWaitMs < 500 || settings.closeWaitMs > 30_000 || !Number.isInteger(settings.maxCloseAttempts) || settings.maxCloseAttempts < 1 || settings.maxCloseAttempts > 5) throw new Error("等待时间或平仓尝试次数超出首批范围");
  for (const value of [settings.maxSpreadBps, settings.maxSlippageBps]) if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error("点差和价格保护必须在 1–100 个基点之间");
  if (!Number.isFinite(settings.maxQuoteAgeMs) || settings.maxQuoteAgeMs < 500 || settings.maxQuoteAgeMs > 10_000) throw new Error("行情有效期不正确");
}

function checkMarket(market: TestMarket, settings: TestSettings, now: number, opening: boolean): void {
  validateSettings(settings);
  if (!settings.symbols.includes(market.symbol)) throw new Error("行情品种不在已确认的候选市场中");
  if (!Number.isSafeInteger(market.productId) || market.productId <= 0) throw new Error("市场编号不正确");
  if (!Number.isFinite(market.observedAt) || market.observedAt > now + 1_000 || now - market.observedAt > settings.maxQuoteAgeMs) throw new Error("行情已经过期，暂不下单");
  if (opening && !market.isOpen) throw new Error("市场处于休市或限制开仓状态");
  if (opening && (!Number.isFinite(market.maxLeverage) || settings.leverage > market.maxLeverage)) throw new Error("所选杠杆超过该市场上限");
  const bid = BigInt(market.bidX18), ask = BigInt(market.askX18), oracle = BigInt(market.oracleX18);
  if (bid <= 0n || ask <= bid || oracle <= 0n || BigInt(market.sizeIncrementX18) <= 0n || BigInt(market.priceIncrementX18) <= 0n || BigInt(market.minNotionalX18) <= 0n) throw new Error("盘口、预言机或交易精度数据不完整");
  if (opening && (ask - bid) * 20_000n > (ask + bid) * BigInt(settings.maxSpreadBps)) throw new Error("盘口点差超过开仓限制");
  // Prevent trading on an obviously detached or invalid book, independent of the loss-stop setting.
  if (bid * 100n < oracle * 98n || ask * 100n > oracle * 102n) throw new Error("盘口偏离预言机超过 2%，停止自动下单");
}

export function planOpening(market: TestMarket, settings: TestSettings, side: "buy" | "sell", now = Date.now()) {
  checkMarket(market, settings, now, true);
  const target = BigInt(settings.targetNotionalX18), minimum = BigInt(market.minNotionalX18);
  if (target < minimum) throw new Error(`目标 ${human(target.toString())}U 小于该品种单笔最低 ${human(minimum.toString())}U`);
  const tick = BigInt(market.priceIncrementX18), step = BigInt(market.sizeIncrementX18);
  const price = side === "buy" ? BigInt(market.bidX18) / tick * tick : ceil(BigInt(market.askX18), tick);
  const amount = ceil((target * X18 + price - 1n) / price, step);
  const notional = amount * price / X18;
  if (notional > 150n * X18) throw new Error("按数量精度取整后超过 150U 单笔限制，请选择其他市场");
  const requiredMargin = ceil((notional + BigInt(settings.leverage) - 1n) / BigInt(settings.leverage), MICRO);
  const margin = requiredMargin > BigInt(settings.marginX18) ? requiredMargin : BigInt(settings.marginX18);
  const positiveTaker = BigInt(market.takerFeeRateX18) > 0n ? BigInt(market.takerFeeRateX18) : 0n;
  const feeAllowance = ceil(notional * positiveTaker * 2n / X18, MICRO);
  return { amountX18: amount.toString(), priceX18: price.toString(), notionalX18: notional.toString(), marginX18: margin.toString(), minimumBalanceX18: (margin + feeAllowance).toString() };
}

export function planClose(market: TestMarket, settings: TestSettings, position: TestPosition, now = Date.now()) {
  checkMarket(market, settings, now, false);
  if (position.productId !== market.productId) throw new Error("平仓市场与实际仓位不一致");
  const signed = BigInt(position.amountX18), amount = signed < 0n ? -signed : signed;
  if (amount <= 0n) throw new Error("没有可平仓数量");
  const tick = BigInt(market.priceIncrementX18), bps = BigInt(settings.maxSlippageBps);
  // Round toward the book, so a coarse tick never widens the promised protection.
  const price = signed > 0n
    ? ceil((BigInt(market.bidX18) * (10_000n - bps) + 9_999n) / 10_000n, tick)
    : BigInt(market.askX18) * (10_000n + bps) / 10_000n / tick * tick;
  if (price <= 0n) throw new Error("平仓保护价不正确");
  // Do not bump small residual positions up to the venue opening minimum.
  return { amountX18: amount.toString(), priceX18: price.toString() };
}

export function assertCleanSnapshot(snapshot: AccountSnapshot): void {
  if (!Number.isFinite(snapshot.observedAt) || !/^0x[\da-fA-F]{64}$/.test(snapshot.parentSender)) throw new Error("账户状态不完整");
  if (snapshot.hasOtherCollateral || snapshot.hasCrossPosition || snapshot.positions.some(p => BigInt(p.amountX18) !== 0n) || snapshot.openOrders.length) throw new Error("账户已有仓位、挂单或其他抵押资产，不能混入本次测试");
  if (BigInt(snapshot.quoteBalanceX18) < 0n) throw new Error("账户存在 USDT0 借款，不能开始测试");
}

export function createTradeTestRun(wallets: TestWallet[], settings: TestSettings, mode: TradeTestRun["mode"], chainId: number, batchKey: string, now = Date.now()): TradeTestRun {
  validateSettings(settings);
  if (!batchKey.trim() || batchKey.length > 100) throw new Error("请填写批次名称（最多 100 字符）");
  if (wallets.length !== 10 || new Set(wallets.map(w => w.address.toLowerCase())).size !== 10 || new Set(wallets.map(w => w.id)).size !== 10 || wallets.some(w => !/^0x[\da-fA-F]{40}$/.test(w.address))) throw new Error("首批必须是 10 个不同的钱包地址");
  if (![57073, 763373].includes(chainId)) throw new Error("不支持的网络");
  return { id: crypto.randomUUID(), batchKey: batchKey.trim(), chainId, createdAt: now, updatedAt: now, revision: 0, mode, settings: structuredClone(settings), wallets: wallets.map((wallet, i) => ({ wallet, side: i % 2 ? "sell" : "buy", status: "pending", orders: [], reports: [] })), status: "ready", stopRequested: false, classification: "internal-test" };
}

/** Export is an explicit allowlist: no signatures, replayable payloads, or private key material. */
export function tradeTestReport(run: TradeTestRun) {
  const safe = (value: string | undefined) => value === undefined ? undefined : safeTradeMessage(value);
  return { id: run.id, batchKey: run.batchKey, mode: run.mode, chainId: run.chainId, classification: run.classification, settings: run.settings, status: run.status, message: safe(run.message), createdAt: run.createdAt, updatedAt: run.updatedAt, ...progressReport(run),
    funding: run.funding ? { status: run.funding.status, message: safe(run.funding.message), treasury: run.funding.treasury, limits: run.funding.limits,
      rows: run.funding.rows.map(row => ({ wallet: row.wallet, depositAddress: row.depositAddress, requiredX18: row.requiredX18, targetX18: row.targetX18, previewBalanceX18: row.previewBalanceX18, baselineX18: row.baselineX18, maxDepositUnits: row.maxDepositUnits, amountUnits: row.amountUnits,
        status: row.status, message: safe(row.message), transactionHash: row.transaction?.hash, receiptHash: row.receipt?.hash, blockNumber: row.receipt?.blockNumber, actualFeeWei: row.actualFeeWei, baselineSubmissionIndex: row.baselineSubmissionIndex, creditedSubmissionIndex: row.creditedSubmissionIndex, createdAt: row.createdAt, broadcastStartedAt: row.broadcastStartedAt, confirmedAt: row.confirmedAt, creditedAt: row.creditedAt, creditedEventAt: row.creditedEventAt })) } : undefined,
    wallets: run.wallets.map(w => ({ wallet: w.wallet, side: w.side, status: w.status, symbol: w.market?.symbol, startedAt: w.startedAt, finishedAt: w.finishedAt, message: safe(w.message), equityBeforeX18: w.before?.equityX18, equityAfterX18: w.after?.equityX18,
      netCostX18: w.before && w.after ? (BigInt(w.before.equityX18) - BigInt(w.after.equityX18)).toString() : undefined,
      reports: w.reports,
      orders: w.orders.map(o => ({ digest: o.prepared.digest, sender: o.prepared.sender, side: o.prepared.side, amountX18: o.prepared.amountX18, priceX18: o.prepared.priceX18, marginX18: o.prepared.marginX18, reduceOnly: o.prepared.reduceOnly, preparedAt: o.preparedAt, broadcastStartedAt: o.broadcastStartedAt, acknowledgedAt: o.acknowledgedAt, error: safe(o.error) })) })) };
}
