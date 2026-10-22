import { INK_CHAIN_ID, USDT0_ADDRESS, type FundsLimits, type FundsPlan, type FundsWallet, type TradingCompletion, type FundsRun } from "./types";

export const DEFAULT_FUNDS_LIMITS: FundsLimits = {
  maxFeePerLegWei: "1000000000000",
  maxTotalFeeWei: "10000000000000",
  authorizationTtlSeconds: 900,
};

/** Exact six-decimal token amount. One base unit is 0.000001 USDT0. */
export function parseTokenUnits(amount: string): string {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(amount.trim())) throw new Error("金额必须是最多六位小数的正数");
  const [whole, fraction = ""] = amount.trim().split(".");
  const value = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (value <= 0n) throw new Error("转账金额必须大于零");
  return value.toString();
}

export function formatTokenUnits(units: string): string {
  const value = BigInt(units);
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${value / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

function uniqueWallets(wallets: FundsWallet[]): void {
  const ids = new Set<string>();
  const addresses = new Set<string>();
  for (const wallet of wallets) {
    if (!wallet.id || !/^0x[\da-fA-F]{40}$/.test(wallet.address)) throw new Error("钱包编号或完整地址无效");
    if (ids.has(wallet.id) || addresses.has(wallet.address.toLowerCase())) throw new Error("钱包列表不能重复");
    ids.add(wallet.id); addresses.add(wallet.address.toLowerCase());
  }
}

export function validatePlan(plan: FundsPlan): void {
  if (plan.chainId !== INK_CHAIN_ID || plan.token.toLowerCase() !== USDT0_ADDRESS.toLowerCase()) throw new Error("仅支持 Ink 主网的 USDT0");
  if (!plan.id || !plan.dedupeKey || !plan.legs.length) throw new Error("计划缺少唯一编号或转账步骤");
  uniqueWallets([plan.treasury]);
  const ids = new Set<string>();
  const knownWallets = new Map<string, string>();
  const knownAddresses = new Map<string, string>();
  for (const leg of plan.legs) {
    uniqueWallets([leg.from, leg.to]);
    if (ids.has(leg.id)) throw new Error("步骤编号重复");
    ids.add(leg.id);
    for (const wallet of [leg.from, leg.to, plan.treasury]) {
      const address = wallet.address.toLowerCase();
      if (knownWallets.has(wallet.id) && knownWallets.get(wallet.id) !== address) throw new Error("同一钱包编号对应不同地址");
      if (knownAddresses.has(address) && knownAddresses.get(address) !== wallet.id) throw new Error("同一地址对应不同钱包编号");
      knownWallets.set(wallet.id, address); knownAddresses.set(address, wallet.id);
    }
    if (leg.amount.kind === "fixed" && (!/^\d+$/.test(leg.amount.units) || BigInt(leg.amount.units) <= 0n)) throw new Error("金额必须大于零");
  }
  for (const fee of [plan.limits.maxFeePerLegWei, plan.limits.maxTotalFeeWei]) {
    if (!/^\d+$/.test(fee) || BigInt(fee) <= 0n) throw new Error("手续费预算必须大于零");
  }
  if (!Number.isInteger(plan.limits.authorizationTtlSeconds) || plan.limits.authorizationTtlSeconds < 60 || plan.limits.authorizationTtlSeconds > 3600) throw new Error("授权有效期必须为 60 至 3600 秒");
  if (plan.kind === "batch-handoff") {
    const completion = plan.completion;
    const sources = plan.legs.map(leg => leg.from.id).sort();
    uniqueWallets(plan.legs.map(leg => leg.from));
    uniqueWallets(plan.legs.map(leg => leg.to));
    const sourceAddresses = new Set(plan.legs.map(leg => leg.from.address.toLowerCase()));
    if (plan.legs.some(leg => sourceAddresses.has(leg.to.address.toLowerCase()))) throw new Error("批次交接的接收钱包不能与本批发送钱包重叠");
    if (!completion?.eventId || !completion.batchId || !Number.isFinite(Date.parse(completion.completedAt))) throw new Error("缺少交易批次完成事件，不能交接资金");
    if (JSON.stringify([...completion.sourceWalletIds].sort()) !== JSON.stringify(sources)) throw new Error("完成事件的钱包范围与本批资金来源不一致");
  }
}

function basePlan(treasury: FundsWallet, limits: FundsLimits, dedupeKey: string): Omit<FundsPlan, "kind" | "legs"> {
  return { id: crypto.randomUUID(), dedupeKey, chainId: INK_CHAIN_ID, token: USDT0_ADDRESS, treasury, limits: { ...limits }, createdAt: new Date().toISOString() };
}

export function buildTestCycle(input: { wallets: [FundsWallet, FundsWallet, FundsWallet]; amount?: string; limits?: FundsLimits; dedupeKey?: string }): FundsPlan {
  uniqueWallets(input.wallets);
  const units = parseTokenUnits(input.amount ?? "1");
  const plan: FundsPlan = {
    ...basePlan(input.wallets[0], input.limits ?? DEFAULT_FUNDS_LIMITS, input.dedupeKey ?? `test-cycle:${crypto.randomUUID()}`), kind: "test-cycle",
    legs: input.wallets.map((from, i) => ({ id: `leg-${i + 1}`, from, to: input.wallets[(i + 1) % 3]!, amount: { kind: "fixed", units }, status: "pending" })),
  };
  validatePlan(plan); return plan;
}

export function buildBatchHandoff(input: { treasury: FundsWallet; sources: FundsWallet[]; targets: FundsWallet[]; amount: string | "all"; completion: TradingCompletion; limits?: FundsLimits; dedupeKey?: string }): FundsPlan {
  if (!input.sources.length || input.sources.length !== input.targets.length) throw new Error("来源与目标钱包数量必须相等且不为空");
  const plan: FundsPlan = {
    ...basePlan(input.treasury, input.limits ?? DEFAULT_FUNDS_LIMITS, input.dedupeKey ?? `batch-handoff:${input.completion.eventId}`),
    kind: "batch-handoff", completion: structuredClone(input.completion),
    legs: input.sources.map((from, i) => ({ id: `leg-${i + 1}`, from, to: input.targets[i]!, amount: input.amount === "all" ? { kind: "all" } : { kind: "fixed", units: parseTokenUnits(input.amount) }, status: "pending" })),
  };
  validatePlan(plan); return plan;
}

/** Safe for downloads and logs. Never exports executable authorization or transaction bytes. */
export function exportRunReport(run: FundsRun): object {
  const report = structuredClone(run);
  for (const leg of report.plan.legs) {
    if (leg.authorization) delete leg.authorization.signature;
    if (leg.transaction) leg.transaction.rawTransaction = "0x";
  }
  return report;
}
