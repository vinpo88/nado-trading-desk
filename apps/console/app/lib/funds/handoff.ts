import { buildBatchHandoff } from "./planner";
import type { FundsLimits, FundsPlan, FundsRun, FundsWallet } from "./types";

/** A strategy's durable settlement event, NOT a place-order acknowledgement.
 * These flags describe the strategy's state. The adapter must independently
 * re-read positions, orders and on-chain funds before signing each new transfer.
 */
export interface SettledTradingBatch {
  eventId: string;
  batchId: string;
  completedAt: string;
  phase: "settled";
  wallets: Array<{
    walletId: string;
    tradingFinished: true;
    openOrders: 0;
    openPositions: 0;
    fundsLocation: "onchain-wallet";
  }>;
}

export interface HandoffPolicy {
  route: "direct-pairs";
  treasury: FundsWallet;
  sources: FundsWallet[];
  targets: FundsWallet[];
  amount: "all" | string;
  limits?: FundsLimits;
}

/** The future trading runner calls this after settlement. It only queues a
 * reviewable plan; it cannot sign or send funds. Current bulk order submission
 * intentionally does not call this because an accepted order is not settlement.
 */
export async function queueHandoffAfterTrading(
  event: SettledTradingBatch,
  policy: HandoffPolicy,
  queue: { create(plan: FundsPlan): Promise<FundsRun> },
): Promise<FundsRun> {
  if (policy.route !== "direct-pairs") throw new Error("该资金路线尚未启用，请先确定分配策略");
  if (event.phase !== "settled" || !event.eventId || !event.batchId || !Number.isFinite(Date.parse(event.completedAt))) {
    throw new Error("仅接受交易与结算均已完成的批次事件");
  }
  if (!event.wallets.length || event.wallets.some(w => w.tradingFinished !== true || w.openOrders !== 0 || w.openPositions !== 0 || w.fundsLocation !== "onchain-wallet")) {
    throw new Error("本批交易尚未结束，或资金尚未回到链上钱包");
  }
  const completedIds = event.wallets.map(w => w.walletId).sort();
  const sourceIds = policy.sources.map(w => w.id).sort();
  if (new Set(completedIds).size !== completedIds.length || JSON.stringify(completedIds) !== JSON.stringify(sourceIds)) {
    throw new Error("交易完成事件与资金来源钱包不一致");
  }
  const plan = buildBatchHandoff({
    treasury: policy.treasury,
    sources: policy.sources,
    targets: policy.targets,
    amount: policy.amount,
    limits: policy.limits,
    completion: {
      eventId: event.eventId, batchId: event.batchId, completedAt: event.completedAt,
      sourceWalletIds: completedIds,
    },
    dedupeKey: `batch-handoff:${event.eventId}`,
  });
  return queue.create(plan);
}
