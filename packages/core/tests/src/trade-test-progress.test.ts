import { expect, it } from "vitest";
import { MAX_TRADE_EVENTS, progressReport, recordTradeProgress, safeTradeMessage } from "../../../../apps/console/app/lib/tradeTest/progress";
import type { TradeTestRun } from "../../../../apps/console/app/lib/tradeTest/types";

it("coalesces repeated polls, bounds history, and allowlists progress exports", () => {
  const run = { revision: 0 } as TradeTestRun;
  recordTradeProgress(run, { phase: "credit", message: "waiting", at: 1, walletId: "one" });
  recordTradeProgress(run, { phase: "credit", message: "waiting", at: 2, walletId: "one" });
  expect(run.events).toHaveLength(1);
  expect(run.progress?.at).toBe(2);
  for (let i = 0; i < MAX_TRADE_EVENTS + 50; i++) {
    run.revision++;
    recordTradeProgress(run, { phase: "credit", message: `observed-${i}`, at: i + 3 });
  }
  expect(run.events).toHaveLength(MAX_TRADE_EVENTS);
  expect(new Set(run.events!.map(e => e.id)).size).toBe(MAX_TRADE_EVENTS);
  Object.assign(run.events![0]!, { payload: { signature: "PRIVATE_REPLAY_SENTINEL" } });
  Object.assign(run.progress!, { rawTransaction: "PRIVATE_REPLAY_SENTINEL" });
  expect(JSON.stringify(progressReport(run))).not.toContain("PRIVATE_REPLAY_SENTINEL");
});

it("supports legacy saved runs without creating a fictitious execution event", () => {
  expect(progressReport({ revision: 0 } as TradeTestRun)).toEqual({ progress: undefined, events: undefined });
});

it("redacts embedded signed bytes and credential fields in legacy RPC error text", () => {
  const signature = `0x${"ab".repeat(65)}`, key = `0x${"cd".repeat(32)}`;
  const raw = `Request failed: calldata ${signature} {"privateKey":"${key}", "password":"private sentinel", "mnemonic":"twelve secret words"}`;
  const safe = safeTradeMessage(raw);
  expect(safe).toContain("Request failed");
  for (const secret of [signature, key, "private sentinel", "twelve secret words"]) expect(safe).not.toContain(secret);
  const error = Object.assign(new Error(raw), { shortMessage: 'Block at number "59166064" could not be found.' });
  expect(safeTradeMessage(error)).toBe(error.shortMessage);
  expect(safeTradeMessage("x".repeat(5000))).toHaveLength(800);
});
