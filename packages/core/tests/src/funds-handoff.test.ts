import { describe, expect, it, vi } from "vitest";
import { queueHandoffAfterTrading, type HandoffPolicy, type SettledTradingBatch } from "../../../../apps/console/app/lib/funds/handoff";
import type { FundsRun, FundsWallet } from "../../../../apps/console/app/lib/funds/types";

const wallet = (id: number): FundsWallet => ({ id: `live:${id}`, address: `0x${String(id + 1).padStart(40, "0")}` });
const policy: HandoffPolicy = { route: "direct-pairs", treasury: wallet(0), sources: [wallet(0), wallet(1)], targets: [wallet(2), wallet(3)], amount: "all" };
const event: SettledTradingBatch = {
  eventId: "strategy-round-42:settled", batchId: "round-42", completedAt: "2026-10-22T08:00:00Z", phase: "settled",
  wallets: [0, 1].map(id => ({ walletId: `live:${id}`, tradingFinished: true, openOrders: 0, openPositions: 0, fundsLocation: "onchain-wallet" })),
};
const queue = () => ({ create: vi.fn(async plan => ({ version: 1, revision: 0, plan, status: "ready", updatedAt: plan.createdAt, stopRequested: false }) as FundsRun) });

describe("funds handoff settlement boundary", () => {
  it("queues a reviewable plan with a stable completion key, never starts execution", async () => {
    const q = queue();
    const run = await queueHandoffAfterTrading(event, policy, q);
    expect(q.create).toHaveBeenCalledOnce();
    expect(run.status).toBe("ready");
    expect(run.plan.dedupeKey).toBe("batch-handoff:strategy-round-42:settled");
    expect(run.plan.legs.map(l => [l.from.id, l.to.id, l.amount.kind])).toEqual([["live:0", "live:2", "all"], ["live:1", "live:3", "all"]]);
  });

  it.each([
    { ...event, phase: "orders-accepted" },
    { ...event, wallets: [{ ...event.wallets[0], openOrders: 1 }, event.wallets[1]] },
    { ...event, wallets: [{ ...event.wallets[0], openPositions: 1 }, event.wallets[1]] },
    { ...event, wallets: [{ ...event.wallets[0], fundsLocation: "nado" }, event.wallets[1]] },
    { ...event, wallets: [event.wallets[0], event.wallets[0]] },
    { ...event, wallets: [{ ...event.wallets[0], walletId: "live:999" }, event.wallets[1]] },
  ])("rejects incomplete or mismatched business completion %#", async bad => {
    const q = queue();
    await expect(queueHandoffAfterTrading(bad as SettledTradingBatch, policy, q)).rejects.toThrow();
    expect(q.create).not.toHaveBeenCalled();
  });
});
