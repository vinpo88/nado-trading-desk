import { describe, expect, it } from "vitest";
import { parseUnits } from "viem";
import { assertCleanSnapshot, createTradeTestRun, DEFAULT_TEST_SETTINGS, planClose, planOpening, tradeTestReport } from "../../../../apps/console/app/lib/tradeTest/planner";
import { MemoryTradeTestStore } from "../../../../apps/console/app/lib/tradeTest/store";
import { createFundingState } from "../../../../apps/console/app/lib/tradeTest/funding";
import type { TestMarket, TestWallet } from "../../../../apps/console/app/lib/tradeTest/types";
const x = (value: string) => parseUnits(value, 18).toString();
const market: TestMarket = { symbol: "EURUSD-PERP", productId: 92, observedAt: 1000, isOpen: true, isolatedOnly: true, maxLeverage: 40, minNotionalX18: x("100"), sizeIncrementX18: x("1"), priceIncrementX18: x("0.00001"), bidX18: x("1.12555"), askX18: x("1.12583"), oracleX18: x("1.1257"), makerFeeRateX18: x("0.00002"), takerFeeRateX18: x("0.00007") };
const wallets = Array.from({ length: 10 }, (_, i): TestWallet => ({ id: `live:${i}`, label: `${i + 1} 号`, address: `0x${(i + 1).toString(16).padStart(40, "0")}` }));
describe("bounded trading pilot planning", () => {
  it("keeps funding destinations and write-ahead payment intents immutable and exports only safe evidence", async () => {
    const store = new MemoryTradeTestStore();
    const run = createTradeTestRun(wallets, DEFAULT_TEST_SETTINGS, "simulation", 57073, "funded");
    run.funding = createFundingState(wallets[0]!, wallets.map((wallet, i) => ({ wallet, requiredX18: x("7"), balanceX18: "0", depositAddress: `0x${(i + 100).toString(16).padStart(40, "0")}` })));
    await store.create(run);
    await expect(store.update(run.id, r => { r.funding!.rows[0]!.depositAddress = wallets[9]!.address; })).rejects.toThrow("不可修改");
    await expect(store.update(run.id, r => { r.funding = undefined; })).rejects.toThrow("不可修改");
    await store.update(run.id, r => {
      const row = r.funding!.rows[0]!;
      row.baselineX18 = "0"; row.baselineSubmissionIndex = "-1"; row.amountUnits = "7000000"; row.createdAt = 1;
      row.authorization = { from: wallets[0]!.address, to: row.depositAddress, value: "7000000", nonce: `0x${"12".repeat(32)}`, validAfter: "0", validBefore: "1800" };
    });
    await expect(store.update(run.id, r => { r.funding!.rows[0]!.baselineSubmissionIndex = "0"; })).rejects.toThrow("不可覆盖");
    await expect(store.update(run.id, r => { r.funding!.rows[0]!.amountUnits = "8000000"; })).rejects.toThrow("不可覆盖");
    await expect(store.update(run.id, r => { r.funding!.rows[0]!.authorization!.nonce = `0x${"34".repeat(32)}`; })).rejects.toThrow("不可替换");
    const saved = await store.update(run.id, r => {
      const row = r.funding!.rows[0]!;
      row.authorization!.signature = `0x${"ef".repeat(65)}`;
      row.transaction = { hash: `0x${"56".repeat(32)}`, rawTransaction: "0xdeadbeef", nonce: "3", feeCeilingWei: "10000" };
      row.actualFeeWei = "1000";
    });
    await expect(store.update(run.id, r => { r.funding!.rows[0]!.transaction!.nonce = "4"; })).rejects.toThrow("不可覆盖");
    const report = tradeTestReport(saved), serialized = JSON.stringify(report);
    expect(report.funding!.rows[0]!.transactionHash).toBe(`0x${"56".repeat(32)}`);
    expect(report.funding!.rows[0]!.actualFeeWei).toBe("1000");
    expect(serialized).not.toContain("signature"); expect(serialized).not.toContain("rawTransaction"); expect(serialized).not.toContain("0xdeadbeef");
    expect(serialized).not.toContain("ef".repeat(65));
  });

  it("rejects 50U rather than silently turning the requested test into a bigger order", () => {
    expect(() => planOpening(market, { ...DEFAULT_TEST_SETTINGS, targetNotionalX18: x("50") }, "buy", 1000)).toThrow("最低");
  });
  it("rounds quantity and margin upward without exceeding 20x and preserves sub-bp fees", () => {
    const p = planOpening(market, DEFAULT_TEST_SETTINGS, "buy", 1000);
    expect(p.amountX18).toBe(x("89"));
    expect(BigInt(p.notionalX18)).toBeGreaterThanOrEqual(BigInt(x("100")));
    expect(BigInt(p.marginX18) * 20n).toBeGreaterThanOrEqual(BigInt(p.notionalX18));
    expect(BigInt(p.minimumBalanceX18)).toBeGreaterThan(BigInt(p.marginX18));
    expect(BigInt(p.marginX18)).toBeGreaterThan(BigInt(x("5")));
  });
  it("refuses stale, closed, wide, detached and under-leveraged markets", () => {
    expect(() => planOpening(market, DEFAULT_TEST_SETTINGS, "buy", 10000)).toThrow("过期");
    expect(() => planOpening({ ...market, isOpen: false }, DEFAULT_TEST_SETTINGS, "buy", 1000)).toThrow("休市");
    expect(() => planOpening({ ...market, maxLeverage: 10 }, DEFAULT_TEST_SETTINGS, "buy", 1000)).toThrow("杠杆");
    expect(() => planOpening({ ...market, askX18: x("1.2") }, DEFAULT_TEST_SETTINGS, "buy", 1000)).toThrow("点差");
  });
  it("does not enlarge a small close to the opening minimum", () => {
    const p = planClose(market, DEFAULT_TEST_SETTINGS, { sender: "0x123", productId: 92, amountX18: x("2"), quoteX18: "0" }, 1000);
    expect(p.amountX18).toBe(x("2"));
    expect(BigInt(p.priceX18)).toBeLessThan(BigInt(market.bidX18));
  });
  it("never widens the 10bp close protection when rounding to a coarse tick", () => {
    const coarse = { ...market, bidX18: x("1.0001"), askX18: x("1.0002"), oracleX18: x("1.00015"), priceIncrementX18: x("0.0001") };
    const long = planClose(coarse, DEFAULT_TEST_SETTINGS, { sender: "0x123", productId: 92, amountX18: x("2"), quoteX18: "0" }, 1000);
    const short = planClose(coarse, DEFAULT_TEST_SETTINGS, { sender: "0x123", productId: 92, amountX18: x("-2"), quoteX18: "0" }, 1000);
    expect(BigInt(long.priceX18) * 10_000n).toBeGreaterThanOrEqual(BigInt(coarse.bidX18) * 9_990n);
    expect(BigInt(short.priceX18) * 10_000n).toBeLessThanOrEqual(BigInt(coarse.askX18) * 10_010n);
    expect(BigInt(long.priceX18) % BigInt(coarse.priceIncrementX18)).toBe(0n);
    expect(BigInt(short.priceX18) % BigInt(coarse.priceIncrementX18)).toBe(0n);
  });
  it("exports no replayable signed requests", () => {
    const run = createTradeTestRun(wallets, DEFAULT_TEST_SETTINGS, "simulation", 57073, "pilot");
    run.wallets[0]!.orders.push({ preparedAt: 1, prepared: { digest: "digest", sender: "sender", productId: 92, side: "buy", amountX18: "1", priceX18: "1", reduceOnly: false, expiresAt: 2000, payload: { signature: "do-not-export" } } });
    expect(JSON.stringify(tradeTestReport(run))).not.toContain("do-not-export");
    expect(JSON.stringify(tradeTestReport(run))).not.toContain("payload");
  });
  it("rejects overlapping active runs, repeated names, changed identities and concurrent workers", async () => {
    const store = new MemoryTradeTestStore();
    const run = createTradeTestRun(wallets, DEFAULT_TEST_SETTINGS, "simulation", 57073, "pilot");
    await store.create(run);
    await expect(store.create({ ...run, id: "other", batchKey: "new" })).rejects.toThrow("未结束");
    await expect(store.create({ ...run, id: "other" })).rejects.toThrow("已存在");
    await expect(store.update(run.id, r => { r.wallets[0]!.wallet.address = wallets[1]!.address; })).rejects.toThrow("不可修改");
    await store.withLock(57073, async () => { await expect(store.withLock(57073, async () => {})).rejects.toThrow("正在"); });
  });
  it("rejects pre-existing exposure", () => {
    expect(() => assertCleanSnapshot({ observedAt: 1, parentSender: `0x${"1".repeat(64)}`, quoteBalanceX18: x("10"), equityX18: x("10"), hasCrossPosition: true, hasOtherCollateral: false, positions: [], openOrders: [] })).toThrow("已有");
  });
});
