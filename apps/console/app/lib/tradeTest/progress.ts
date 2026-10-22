import type { TradeTestEvent, TradeTestProgress, TradeTestRun } from "./types";

export const MAX_TRADE_EVENTS = 300;
type Update = TradeTestProgress & { kind?: TradeTestEvent["kind"]; txHash?: string; orderDigest?: string };

/** RPC errors can embed signed calldata; keep useful reasons, never replayable bytes. */
export function safeTradeMessage(value: unknown): string {
  const source = value instanceof Error ? ("shortMessage" in value && typeof value.shortMessage === "string" ? value.shortMessage : value.message)
    : typeof value === "string" ? value : "操作未完成，请保留原记录等待核对";
  return source.replace(/0x[\da-fA-F]{129,}/g, "[已隐藏签名或交易数据]")
    .replace(/(["']?(?:signature|rawTransaction|privateKey|mnemonic|password)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[已隐藏]")
    .slice(0, 800);
}

/** Called inside the SAME durable journal update as the state it describes. */
export function recordTradeProgress(run: TradeTestRun, update: Update): void {
  const progress: TradeTestProgress = { phase: update.phase, message: safeTradeMessage(update.message), at: update.at,
    walletId: update.walletId, current: update.current, total: update.total };
  run.progress = progress;
  const kind = update.kind ?? "progress";
  const events = run.events ?? [], last = events.at(-1);
  // Polling refreshes the heartbeat, without burying meaningful transitions.
  if (last && last.phase === progress.phase && last.message === progress.message && last.walletId === progress.walletId
    && last.current === progress.current && last.total === progress.total && last.kind === kind
    && last.txHash === update.txHash && last.orderDigest === update.orderDigest) return;
  const entry: TradeTestEvent = { ...progress, id: `${run.revision + 1}:${update.at}:${events.length}`, kind,
    txHash: update.txHash, orderDigest: update.orderDigest };
  run.events = [...events, entry].slice(-MAX_TRADE_EVENTS);
}

/** Explicit allowlist also protects exports of older/imported records. */
export function progressReport(run: TradeTestRun) {
  const pick = (p: TradeTestProgress): TradeTestProgress => ({ phase: p.phase, message: safeTradeMessage(p.message), at: p.at,
    walletId: p.walletId, current: p.current, total: p.total });
  return { progress: run.progress ? pick(run.progress) : undefined,
    events: run.events?.slice(-MAX_TRADE_EVENTS).map(event => ({ ...pick(event), id: event.id, kind: event.kind,
      txHash: event.txHash, orderDigest: event.orderDigest })) };
}
