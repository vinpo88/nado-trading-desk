"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cohortWallets, isUnlocked } from "../lib/custody";
import { useNetwork } from "./NetworkProvider";
import { ChineseButton as Button } from "./ChineseButton";
import { createBrowserTradeTestAdapter } from "../lib/tradeTest/browserAdapter";
import { TradeTestEngine } from "../lib/tradeTest/engine";
import { IndexedDbTradeTestStore } from "../lib/tradeTest/store";
import { createFundingState, fundingTotals, TradeFundingController, type TestFundingState } from "../lib/tradeTest/funding";
import { createBrowserFundingAdapter } from "../lib/tradeTest/fundingAdapter";
import { formatTokenUnits } from "../lib/funds/planner";
import type { FundsWalletBalance } from "../lib/funds/types";
import { formatUnits } from "viem";
import { assertCleanSnapshot, createTradeTestRun, DEFAULT_TEST_SETTINGS, human, planOpening, requiredTestBalance, tradeTestReport } from "../lib/tradeTest/planner";
import type { TestSettings, TestWallet, TradeTestRun } from "../lib/tradeTest/types";
import { safeTradeMessage } from "../lib/tradeTest/progress";

const STATUS: Record<TradeTestRun["status"], string> = { ready: "待启动", running: "正在执行", paused: "已暂停", attention: "需要处理", completed: "本批结束" };
const WALLET_STATUS = { pending: "待执行", opening: "挂单与成交核对", closing: "撤单与平仓", completed: "已核实平仓", unfilled: "未成交", attention: "需要处理" };
const errorText = safeTradeMessage;
type PreviewRow = { wallet: TestWallet; symbol?: string; side: "buy" | "sell"; notional?: string; margin?: string; balance?: string; required?: string; error?: string };
type Preview = { rows: PreviewRow[]; settings: TestSettings; chainId: number; at: number; funding?: TestFundingState; treasuryBalance?: FundsWalletBalance; fundingError?: string };
const time = (value?: number) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
const sum = (values: string[]) => values.reduce((a, b) => a + BigInt(b), 0n).toString();
const FUNDING_STATUS = { pending: "待核对", intent: "付款意图已保存", authorized: "授权已保存", prepared: "交易已保存", broadcast: "等待链上确认", confirmed: "等待 Nado 到账", credited: "已核实到账", skipped: "余额充足，跳过", attention: "需要核对" };
const fundingUntouched = (funding?: TestFundingState) => !funding || funding.rows.every(row => !row.authorization && !row.transaction && !row.createdAt && !row.receipt);
const eth = (wei: string) => formatUnits(BigInt(wei), 18);
const deficit = (required: string, balance: string) => (BigInt(required) > BigInt(balance) ? BigInt(required) - BigInt(balance) : 0n).toString();
const PHASE: Record<string, string> = { preflight: "启动检查", funding_check: "充值前核对", funding: "发送充值 / 链上确认", credit: "Nado 到账核验", opening: "挂单开仓", closing: "撤单 / 平仓", reporting: "核对成交与费用", completed: "本批结束" };
type VisibleProgress = { phase: string; message: string; at: number; walletId?: string; current?: number; total?: number };
type VisibleEvent = VisibleProgress & { id: string; kind: "progress" | "transition" | "error"; txHash?: string; orderDigest?: string };
type VisibleRun = TradeTestRun & { progress?: VisibleProgress; events?: VisibleEvent[] };
const short = (value: string) => `${value.slice(0, 10)}…${value.slice(-6)}`;
const stageFor = (phase: string) => phase === "completed" ? 4 : ["opening", "closing", "reporting", "trading"].includes(phase) ? 3 : phase === "credit" ? 2 : ["funding", "funding_check"].includes(phase) ? 1 : 0;
const transactionLink = (hash: string, label = "查看链上交易") => /^0x[0-9a-f]{64}$/i.test(hash) ? <a className="underline break-all" href={`https://explorer.inkonchain.com/tx/${hash}`} target="_blank" rel="noreferrer">{label} {short(hash)}</a> : null;

function runProgress(run: VisibleRun, busy: boolean): VisibleProgress {
  if (run.status === "completed") return { phase: "completed", message: run.message ?? "本批结束，请核对实际成交报告", at: run.updatedAt };
  if (run.progress) return run.progress;
  const fundingRow = run.funding?.rows.find(row => !["credited", "skipped"].includes(row.status) && (row.transaction || row.createdAt)) ?? run.funding?.rows.find(row => !["credited", "skipped"].includes(row.status));
  const trading = run.wallets.find(row => ["opening", "closing", "attention"].includes(row.status));
  if (trading) return { phase: trading.status === "opening" ? "opening" : "closing", walletId: trading.wallet.id, message: trading.message ?? WALLET_STATUS[trading.status], at: run.updatedAt };
  if (fundingRow && run.status !== "ready") return { phase: fundingRow.receipt ? "credit" : "funding", walletId: fundingRow.wallet.id, message: run.funding?.message ?? fundingRow.message ?? FUNDING_STATUS[fundingRow.status], at: run.updatedAt };
  return { phase: "preflight", message: busy ? "启动请求已收到，正在读取本批账户与市场，请保持页面打开" : run.status === "ready" ? "计划已保存，尚未开始充值或下单" : run.message ?? "等待核对原批次记录", at: run.updatedAt };
}

function visibleHistory(run: VisibleRun): VisibleEvent[] {
  if (run.events?.length) return run.events.slice(-300).reverse();
  const events: VisibleEvent[] = [{ id: "created", at: run.createdAt, phase: "preflight", message: "计划已保存", kind: "transition" }];
  for (const row of run.funding?.rows ?? []) {
    if (row.broadcastStartedAt) events.push({ id: `funding:${row.wallet.id}`, at: row.broadcastStartedAt, phase: "funding", walletId: row.wallet.id, message: "已开始提交原充值交易，到账情况以核验结果为准", txHash: row.transaction?.hash, kind: "transition" });
    if (row.confirmedAt) events.push({ id: `confirmed:${row.wallet.id}`, at: row.confirmedAt, phase: "credit", walletId: row.wallet.id, message: "Ink 回执已核实，等待 Nado 入账", txHash: row.receipt?.hash, kind: "transition" });
    if (row.creditedAt) events.push({ id: `credited:${row.wallet.id}`, at: row.creditedAt, phase: "credit", walletId: row.wallet.id, message: "Nado 到账已核实", kind: "transition" });
  }
  for (const row of run.wallets) for (const [i, order] of row.orders.entries()) events.push({ id: `order:${row.wallet.id}:${i}`, at: order.acknowledgedAt ?? order.broadcastStartedAt ?? order.preparedAt, phase: order.prepared.reduceOnly ? "closing" : "opening", walletId: row.wallet.id, message: order.acknowledgedAt ? "订单提交已获响应，实际成交需另行核对" : order.broadcastStartedAt ? "订单已开始提交，正在核对受理情况" : "订单已保存，尚无发送记录", orderDigest: order.prepared.digest, kind: "transition" });
  if (["paused", "attention"].includes(run.status)) events.push({ id: "paused", at: run.updatedAt, phase: runProgress(run, false).phase, message: run.message ?? run.funding?.message ?? "原批次已暂停", kind: "error" });
  return events.sort((a, b) => b.at - a.at).slice(0, 300);
}

function RunOverview({ run, busy }: { run: VisibleRun; busy: boolean }) {
  const progress = runProgress(run, busy), rows = run.funding?.rows ?? [];
  const sent = rows.filter(row => row.broadcastStartedAt || row.receipt).length;
  const confirmed = rows.filter(row => row.receipt?.status === "success").length;
  const credited = rows.filter(row => row.status === "credited").length;
  const skipped = rows.filter(row => row.status === "skipped").length;
  const doneWallets = run.wallets.filter(row => ["completed", "unfilled"].includes(row.status)).length;
  const orders = run.wallets.flatMap(row => row.orders), current = stageFor(progress.phase);
  const paused = ["paused", "attention"].includes(run.status);
  const allCredited = rows.length > 0 && credited + skipped === rows.length;
  const phaseDone = [sent > 0 || allCredited || orders.length > 0, rows.length > 0 && rows.every(row => row.receipt?.status === "success" || row.status === "skipped"), allCredited, orders.length > 0 && doneWallets === run.wallets.length, run.status === "completed"];
  const wallet = run.wallets.find(row => row.wallet.id === progress.walletId)?.wallet;
  const reason = run.message ?? run.funding?.message ?? progress.message;
  return <div className="rounded-xl border border-kumo-line bg-kumo-control/30 p-4 space-y-4" data-testid="execution-overview" aria-live="polite">
    <div className="flex flex-wrap justify-between gap-3"><div><h3 className="text-lg font-semibold">实时执行进度</h3><p className="text-sm text-kumo-subtle">{run.batchKey} · {busy ? "本页正在执行" : STATUS[run.status]}</p></div><div className="text-xs text-kumo-subtle">最近记录：{time(progress.at)}<div>页面每 1.5 秒读取本地进度</div></div></div>
    <ol className="grid gap-2 sm:grid-cols-5" aria-label="执行阶段">
      {["启动检查", "充值", "到账核验", "交易", "结束"].map((label, index) => {
        const applicable = !!run.funding || ![1, 2].includes(index);
        const active = applicable && index === current && run.status !== "completed";
        return <li key={label} aria-current={active ? "step" : undefined} className={`rounded-lg border p-3 text-sm ${active ? "border-violet-500 bg-violet-500/10" : "border-kumo-line"}`}><div className="font-semibold">{index + 1}. {label}</div><div className="mt-1 text-xs text-kumo-subtle">{!applicable ? "该旧计划不含自动充值" : active ? paused ? "暂停于此" : run.status === "ready" && !busy ? "等待启动" : "当前阶段" : phaseDone[index] ? "已核实" : "尚未完成"}</div></li>;
      })}
    </ol>
    <div className="grid gap-2 text-sm sm:grid-cols-4"><div>已开始发送充值<strong className="block text-xl">{sent} / {rows.length || "—"}</strong></div><div><div>链上已确认 <strong>{confirmed} 笔</strong></div><div>Nado 已到账 <strong>{credited} 户</strong></div><span className="text-xs text-kumo-subtle">另有 {skipped} 户余额充足，无需充值</span></div><div>交易已结束<strong className="block text-xl">{doneWallets} / {run.wallets.length}</strong><span className="text-xs text-kumo-subtle">含本轮未成交 / 未启动即结束的账户</span></div><div>已保存订单<strong className="block text-xl">{orders.length} 笔</strong><span className="text-xs text-kumo-subtle">订单数不等于成交笔数</span></div></div>
    <div className="rounded-lg border border-kumo-line p-3 text-sm"><strong>{wallet?.label ? `${wallet.label} · ` : ""}{PHASE[progress.phase] ?? progress.phase}{progress.current !== undefined && progress.total ? `（${progress.current} / ${progress.total}）` : ""}</strong><p className="mt-1 break-words">{safeTradeMessage(progress.message)}</p></div>
    {paused && <div role="alert" className="rounded-lg border border-amber-500 bg-amber-500/10 p-3 text-sm"><strong>执行已暂停，不会继续新充值或开仓</strong><p className="mt-1 break-words">{safeTradeMessage(reason)}</p>{/block.*(?:not.*found|could not be found)/i.test(reason) && <p className="mt-2">节点暂时读不到该区块，不等于转账失败。已有交易必须先按原哈希核验。</p>}<p className="mt-2">点击「恢复核对并继续」核查原批次，不要重新建批或再次手动充值。界面只显示已保存记录，未核实到账不会计为成功。</p></div>}
    {run.status === "running" && !busy && <p className="rounded border border-amber-500 p-3 text-sm">本页没有执行中的任务。记录可能来自中断前或另一个窗口；确认原窗口已停止后，使用「恢复核对并继续」。恢复会先取得执行锁并核查原记录。</p>}
    {busy && <p className="text-sm text-kumo-subtle">正在执行，请保持页面打开。读余额、等待确认或等待成交时也会记录进度；停止会阻止新增付款与开仓，已经发出的操作仍需核验。</p>}
  </div>;
}

function OrderDetails({ run }: { run: TradeTestRun }) {
  return <details className="rounded-lg border border-kumo-line p-3" open data-testid="order-details"><summary className="cursor-pointer font-semibold">开仓 / 平仓订单明细</summary>
    {!run.wallets.some(row => row.orders.length) ? <p className="mt-3 text-sm text-kumo-subtle">尚未保存或发送交易订单；充值未全部核实到账前不会开仓。</p> : <div className="overflow-x-auto mt-3"><table className="w-full min-w-[900px] text-left text-xs"><thead><tr><th>账户 / 市场</th><th>用途 / 方向</th><th>委托数量 / 限价</th><th>提交状态</th><th>实际成交额 / 费用 U</th><th>时间 / 订单编号</th></tr></thead><tbody>{run.wallets.flatMap(row => row.orders.map(order => {
      const report = row.reports.find(item => item.digest.toLowerCase() === order.prepared.digest.toLowerCase());
      const known = report?.indexed || report?.notBroadcast;
      const status = report?.notBroadcast ? "未发送" : report?.indexed ? BigInt(report.volumeX18) > 0n ? "已有归档成交" : "归档无成交" : order.acknowledgedAt ? "提交已响应，待成交核验" : order.broadcastStartedAt ? "已开始提交，待核对受理" : "已保存，尚无发送记录";
      return <tr className="border-t border-kumo-line" key={order.prepared.digest}><td className="py-3 pr-2">{row.wallet.label}<div>{row.market?.symbol ?? `市场 ${order.prepared.productId}`}</div></td><td>{order.prepared.reduceOnly ? "只减仓平仓" : "开仓"}<div>{order.prepared.side === "buy" ? "买入" : "卖出"}</div></td><td>{human((BigInt(order.prepared.amountX18) < 0n ? -BigInt(order.prepared.amountX18) : BigInt(order.prepared.amountX18)).toString())}<div>限价 {human(order.prepared.priceX18)}</div></td><td className="max-w-56">{status}{order.error && <div className="mt-1">{safeTradeMessage(order.error)}</div>}</td><td>{known ? `${human(report?.volumeX18)} / ${human(report?.feeX18)}` : "待归档，尚不能计数"}</td><td className="max-w-56">{time(order.acknowledgedAt ?? order.broadcastStartedAt ?? order.preparedAt)}<details><summary className="cursor-pointer">订单编号 {short(order.prepared.digest)}</summary><code className="break-all">{order.prepared.digest}</code></details></td></tr>;
    }))}</tbody></table></div>}
    <p className="mt-2 text-xs text-kumo-subtle">委托数量不是成交数量；提交响应也不等于成交。实际成交额和费用只取归档记录，订单编号不作为链上转账哈希。</p>
  </details>;
}

function EventTimeline({ run }: { run: VisibleRun }) {
  const events = visibleHistory(run);
  return <details className="rounded-lg border border-kumo-line p-3" open data-testid="execution-timeline"><summary className="cursor-pointer font-semibold">执行时间线 · 最近 {events.length} 条</summary>
    {!run.events?.length && <p className="mt-2 text-xs text-kumo-subtle">旧批次根据已保存的充值和订单记录还原；升级前未记录的检查过程无法补造。</p>}
    <ol className="mt-3 max-h-96 overflow-y-auto divide-y divide-kumo-line">{events.map(event => <li className="py-3 text-sm" key={event.id}><div className="flex flex-wrap gap-x-3 gap-y-1"><time className="text-xs text-kumo-subtle">{time(event.at)}</time><strong>{event.kind === "error" ? "暂停 / 异常 · " : ""}{run.wallets.find(row => row.wallet.id === event.walletId)?.wallet.label} {PHASE[event.phase] ?? event.phase}</strong></div><p className="mt-1 break-words">{safeTradeMessage(event.message)}</p>{event.txHash && <div className="mt-1 text-xs">{transactionLink(event.txHash)}</div>}{event.orderDigest && <div className="mt-1 text-xs break-all">订单编号：{event.orderDigest}</div>}</li>)}</ol>
    <p className="mt-2 text-xs text-kumo-subtle">最多保留最近 300 条进度记录；这里不展示签名、私钥或可重放的交易请求。</p>
  </details>;
}

function FundingSummary({ funding, balance, onCopy, saved = false }: { funding: TestFundingState; balance?: FundsWalletBalance; onCopy: () => void; saved?: boolean }) {
  const totals = fundingTotals(funding, balance ?? { tokenUnits: "0", ethWei: "0" });
  return <div className="rounded-lg border border-kumo-line p-4 space-y-3" data-testid={saved ? "saved-funding" : "preview-funding"}>
    <h3 className="font-semibold">1 号资金库 · Ink 链上普通钱包</h3>
    <div className="flex flex-wrap items-center gap-2"><code className="break-all text-sm">{funding.treasury.address}</code><Button onClick={onCopy}>复制资金库地址</Button></div>
    <div className="grid gap-3 text-sm sm:grid-cols-3">
      <div>本批计划充值：<strong>{formatTokenUnits(totals.plannedUnits)} USDT0</strong></div>
      {balance && <><div>资金库链上余额：<strong>{formatTokenUnits(balance.tokenUnits)} USDT0</strong></div><div>还需转入资金库：<strong>{formatTokenUnits(totals.shortfallUnits)} USDT0</strong></div><div>资金库 Ink ETH：<strong>{eth(balance.ethWei)}</strong></div><div>还需准备 Ink ETH：<strong>{eth(totals.ethShortfallWei)}</strong></div></>}
      <div>剩余充值 Gas 费用上限：<strong>{eth(totals.requiredEthWei)} ETH</strong></div>
      {saved && <div>已核实充值 Gas：<strong>{eth(totals.actualFeeWei)} ETH</strong></div>}
      {saved && <div>已确认付款本金：<strong>{formatTokenUnits(sum(funding.rows.filter(row => row.receipt?.status === "success").map(row => row.amountUnits ?? "0")))} USDT0</strong></div>}
    </div>
    <p className="text-xs text-kumo-subtle">只向这个普通钱包准备 Ink USDT0 和 Ink ETH；BSC USDT 需要先跨链。资金库直接充值到各户 Nado 专属地址，其他九个钱包不用为充值准备 ETH。Gas 上限是预算，实际费用以回执为准。</p>
    <p className="text-xs text-kumo-subtle">充值目标按 0.1U 向上取整；有差额时按专属地址单笔至少 5U 处理。小差额可能充值 5U，多出的余额仍是本金，不是手续费。保存不会转账，启动后才逐笔补款。</p>
    {funding.status === "paused" && funding.message && <p role="status" className="text-sm">{safeTradeMessage(funding.message)}</p>}
    <div className="overflow-x-auto"><table className="w-full min-w-[1080px] text-left text-xs"><thead><tr><th>账户</th><th>充值前 Nado 余额 U</th><th>预检差额 U</th><th>准备余额目标 U</th><th>{saved ? "本轮充值 U" : "计划充值上限 U"}</th><th>入账状态 / 专属充值地址</th>{saved && <><th>实际 Gas / 交易</th><th>入账时间 / 核验用时</th></>}</tr></thead><tbody>
      {funding.rows.map(row => <tr className="border-t border-kumo-line" key={row.wallet.id}>
        <td className="py-3 pr-2">{row.wallet.label}</td><td>{human(row.baselineX18 ?? row.previewBalanceX18)}<div className="text-kumo-subtle">{row.baselineX18 !== undefined ? "付款前核对值" : "预检时读取值"}</div></td><td>{human(deficit(row.requiredX18, row.previewBalanceX18))}</td><td>{human(row.targetX18)}</td><td>{saved && row.status === "skipped" ? "0" : formatTokenUnits(row.amountUnits ?? row.maxDepositUnits)}{saved && <div className="text-kumo-subtle">{row.status === "skipped" ? "无需付款" : row.receipt?.status === "success" ? "已确认付款" : row.broadcastStartedAt ? "已开始发送" : row.transaction ? "仅保存交易" : "计划上限"}</div>}</td>
        <td className="max-w-60 py-2">{saved ? FUNDING_STATUS[row.status] : BigInt(row.maxDepositUnits) > 0n ? "启动后自动补足" : "无需充值"}<details><summary className="cursor-pointer">核对专属充值地址</summary><code className="break-all">{row.depositAddress}</code></details>{row.message && <div>{safeTradeMessage(row.message)}</div>}</td>
        {saved && <><td>{row.actualFeeWei !== undefined ? `${eth(row.actualFeeWei)} ETH` : row.status === "skipped" ? "无需付款" : "待回执"}{row.transaction && <div>{transactionLink(row.transaction.hash)}</div>}</td><td>{(() => { const eventAt = row.creditedEventAt; return <>{eventAt ? <div>Nado 入账：{time(eventAt)}{row.receipt && eventAt >= row.receipt.blockTimestampMs && <div>链上确认至入账：{((eventAt - row.receipt.blockTimestampMs) / 1000).toFixed(1)} 秒</div>}</div> : <div>{row.status === "skipped" ? "无需充值" : "入账时间待核验"}</div>}{row.creditedAt && <div>本地核实：{time(row.creditedAt)}</div>}{row.broadcastStartedAt && row.creditedAt && <div>核验用时：{((row.creditedAt - row.broadcastStartedAt) / 1000).toFixed(1)} 秒（含暂停）</div>}</>; })()}</td></>}
      </tr>)}
    </tbody></table></div>
    {saved && <p className="text-xs text-kumo-subtle">刷新或中断后选择原批次恢复，程序先核对原交易；等待 Nado 到账时不会再次充值。已保存金额是本批补款上限，行情变化后不足会暂停。</p>}
  </div>;
}

export function TradeTestPanel() {
  const { chainId } = useNetwork();
  const store = useRef<IndexedDbTradeTestStore | null>(null);
  store.current ??= new IndexedDbTradeTestStore();
  const engine = useRef<TradeTestEngine | null>(null);
  const executionSection = useRef<HTMLElement | null>(null);
  const [stockFallback, setStockFallback] = useState(false);
  const [batchName, setBatchName] = useState(() => `外汇首批-${new Date().toISOString().slice(0, 16).replaceAll(":", "")}`);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [runs, setRuns] = useState<TradeTestRun[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkProgress, setCheckProgress] = useState("");
  const [error, setError] = useState("");
  const selected = runs.find(r => r.id === selectedId);
  const refresh = useCallback(async () => {
    try { setRuns((await store.current!.list()).sort((a, b) => b.createdAt - a.createdAt)); } catch (e) { setError(errorText(e)); }
  }, []);
  useEffect(() => { void refresh(); const interval = setInterval(() => { void refresh(); }, 1500); return () => clearInterval(interval); }, [refresh]);
  useEffect(() => { if (!selectedId && runs.length) setSelectedId(runs[0]!.id); }, [runs, selectedId]);
  useEffect(() => { setPreview(null); }, [chainId, stockFallback]);
  useEffect(() => {
    if (!busy) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent); return () => window.removeEventListener("beforeunload", prevent);
  }, [busy]);

  async function inspect() {
    setError(""); setChecking(true); setCheckProgress("准备读取账户"); setPreview(null);
    try {
      if (!isUnlocked()) throw new Error("请先解锁保险库");
      const wallets = cohortWallets().slice(0, 10).map((w, i): TestWallet => ({ id: w.walletId, address: w.address, label: `${i + 1} 号钱包` }));
      if (wallets.length !== 10) throw new Error("当前保险库不足 10 个钱包，请先在账户管理中准备好钱包");
      const adapter = createBrowserTradeTestAdapter();
      const settings = structuredClone(DEFAULT_TEST_SETTINGS);
      if (stockFallback) settings.symbols.push("SPY-PERP");
      const rows: PreviewRow[] = [];
      for (const [i, wallet] of wallets.entries()) {
        setCheckProgress(`正在核对 ${i + 1} / 10 号钱包`);
        const row: PreviewRow = { wallet, side: i % 2 ? "sell" : "buy" };
        try {
          await adapter.assertIdentity(wallet, chainId);
          const snapshot = await adapter.snapshot(wallet); row.balance = snapshot.quoteBalanceX18;
          assertCleanSnapshot(snapshot);
          let reason = "没有满足当前条件的候选市场";
          for (const symbol of settings.symbols) {
            try {
              const market = await adapter.market(symbol), p = planOpening(market, settings, row.side);
              row.symbol = symbol; row.notional = p.notionalX18; row.margin = p.marginX18; row.required = requiredTestBalance(snapshot, p.minimumBalanceX18).toString();
              reason = ""; break;
            } catch (e) { reason = `${symbol}：${errorText(e)}`; }
          }
          if (reason) row.error = reason;
          if (!row.error && chainId !== 57073 && row.required && BigInt(snapshot.quoteBalanceX18) < BigInt(row.required)) row.error = `Nado 账户余额不足，含手续费预留至少需 ${human(row.required)}U；自动充值仅支持 Ink 主网`;
        } catch (e) { row.error = errorText(e); }
        rows.push(row);
      }
      const result: Preview = { rows, settings, chainId, at: Date.now() };
      if (chainId === 57073 && rows.every(row => !row.error && row.required && row.balance !== undefined)) {
        try {
          const fundingAdapter = createBrowserFundingAdapter(adapter);
          const deposits = [];
          for (const [i, row] of rows.entries()) {
            setCheckProgress(`正在核对 ${i + 1} / 10 号专属充值地址`);
            deposits.push({ wallet: row.wallet, requiredX18: row.required!, balanceX18: row.balance!, depositAddress: await fundingAdapter.getDepositAddress(row.wallet) });
          }
          setCheckProgress("正在读取 1 号资金库链上余额");
          result.funding = createFundingState(wallets[0]!, deposits);
          result.treasuryBalance = await fundingAdapter.readTreasury(wallets[0]!);
        } catch (e) { result.fundingError = errorText(e); }
      }
      result.at = Date.now(); setPreview(result);
    } catch (e) { setError(errorText(e)); } finally { setChecking(false); setCheckProgress(""); }
  }

  async function save() {
    setError("");
    try {
      if (!preview || preview.chainId !== chainId || preview.rows.some(r => r.error) || preview.fundingError || (chainId === 57073 && !preview.funding)) throw new Error("请先完成全部钱包、专属充值地址和资金库的只读预检");
      const run = createTradeTestRun(preview.rows.map(r => r.wallet), preview.settings, "live", chainId, batchName);
      if (preview.funding) run.funding = structuredClone(preview.funding);
      await store.current!.create(run); setSelectedId(run.id); await refresh(); scrollToExecution();
    } catch (e) { setError(errorText(e)); }
  }

  async function start() {
    if (!selected || busy) return;
    setError(""); setBusy(true); scrollToExecution();
    try {
      if (selected.chainId !== chainId) throw new Error("请切换到该批次保存时使用的网络");
      engine.current = makeEngine();
      await engine.current.run(selected.id);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); await refresh(); }
  }

  async function stop() {
    if (!selected) return;
    setError("");
    try {
      if (selected.chainId !== chainId) throw new Error("请切换到该批次保存时使用的网络");
      const e = busy && engine.current ? engine.current : makeEngine();
      await e.stop(selected.id);
      if (!busy) {
        setBusy(true); engine.current = e;
        try { await e.run(selected.id, { cleanupOnly: true }); } finally { setBusy(false); }
      }
      await refresh();
    } catch (e) { setError(errorText(e)); await refresh(); }
  }
  async function statistics() {
    if (!selected) return;
    setChecking(true); setError("");
    try { await new TradeTestEngine(store.current!, createBrowserTradeTestAdapter()).refreshReports(selected.id); await refresh(); } catch (e) { setError(errorText(e)); } finally { setChecking(false); }
  }
  function makeEngine() {
    const adapter = createBrowserTradeTestAdapter();
    return new TradeTestEngine(store.current!, adapter, { funding: new TradeFundingController(store.current!, createBrowserFundingAdapter(adapter)) });
  }
  async function abandonReady() {
    if (!selected) return;
    try {
      await store.current!.withLock(selected.chainId, async () => {
        await store.current!.update(selected.id, r => {
          if (r.status !== "ready" || r.wallets.some(w => w.orders.length) || !fundingUntouched(r.funding)) throw new Error("计划已有充值或订单记录，不能取消；请使用停止并收尾");
          r.status = "completed"; r.stopRequested = true; r.message = "未充值、未发送订单，已取消计划";
          for (const w of r.wallets) { w.status = "unfilled"; w.message = "未启动"; }
        });
      });
      await refresh();
    } catch (e) { setError(errorText(e)); }
  }
  function download() {
    if (!selected) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(tradeTestReport(selected), null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `nado-trade-test-${selected.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  async function copyTreasury(address: string) {
    try { await navigator.clipboard.writeText(address); } catch { setError("复制失败，请复制页面展示的完整资金库地址"); }
  }
  function scrollToExecution() {
    requestAnimationFrame(() => { executionSection.current?.scrollIntoView({ behavior: "smooth", block: "start" }); });
  }

  const fieldClass = "rounded border border-kumo-line bg-kumo-base px-3 py-2 text-sm";
  return <div className="flex flex-col gap-5">
    <section className="rounded-xl border border-kumo-line bg-kumo-base p-5 space-y-4">
      <h2 className="text-lg font-semibold">首批 10 个钱包 · 一次开仓与平仓</h2>
      <p className="text-sm text-kumo-subtle">依次完成 1 到 10 号钱包，买入、卖出方向交替。每个钱包只尝试一轮，不以重复开仓补足成交量。向公开盘口挂单，不指定本批钱包为交易对手。</p>
      <div className="grid gap-3 sm:grid-cols-4 text-sm">
        <div><div className="text-kumo-subtle">每次开仓目标</div><strong>约 100 USDT0</strong></div>
        <div><div className="text-kumo-subtle">名义初始杠杆</div><strong>20 倍 · 逐仓</strong></div>
        <div><div className="text-kumo-subtle">每账户开平累计预估</div><strong>约 200U</strong></div>
        <div><div className="text-kumo-subtle">累计损耗停机线</div><strong>不设置（按你的选择）</strong></div>
      </div>
      <p className="text-sm text-kumo-subtle">按市场数量精度取整后，保证金可能略高于 5U；预检显示准确值和费用余量。首选 EURUSD、GBPUSD、USDJPY；点差超过 0.10% 或不支持 20 倍时跳过该市场。</p>
      <p className="text-sm text-kumo-subtle">Ink 主网由 1 号资金库统一付本金和 Gas，按各户余额差额充值。确认全部 Nado 账户到账后才开始交易。</p>
      <label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={stockFallback} disabled={busy || checking} onChange={e => setStockFallback(e.target.checked)} />外汇均不满足开仓条件时，允许使用 SPY 股票指数永续备选（费率可能更高）</label>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">批次名称<input className={fieldClass} value={batchName} onChange={e => setBatchName(e.target.value)} maxLength={100} disabled={busy} /></label>
        <Button disabled={busy || checking} onClick={() => { void inspect(); }}>{checking ? "检查中…" : "只读检查前 10 个钱包"}</Button>
        {checkProgress && <span role="status" className="text-sm text-kumo-subtle">{checkProgress}</span>}
      </div>
      <p className="text-xs text-kumo-subtle">挂单最多等 60 秒，再撤单并处理实际成交仓位。平仓使用只减仓限价 IOC，价格保护 0.10%，最多 3 次尝试；退出受流动性和网络影响，不能保证在任何行情下立即平掉。刷新或关闭页面会中断执行，重新打开后须点击恢复。</p>
    </section>
    {error && <div role="alert" className="rounded border border-red-400 p-3 text-sm">{error}</div>}
    <section ref={executionSection} className="rounded-xl border border-kumo-line bg-kumo-base p-5 space-y-4 scroll-mt-4" data-testid="execution-section">
      <h2 className="text-lg font-semibold">批次记录与实际成交</h2>
      <label className="flex flex-col gap-1 text-sm">选择批次<select className={fieldClass} value={selectedId} disabled={busy} onChange={e => setSelectedId(e.target.value)}><option value="">请选择</option>{runs.map(r => <option key={r.id} value={r.id}>{r.batchKey} · {r.chainId} · {STATUS[r.status]}</option>)}</select></label>
      {selected && <>
        <RunOverview run={selected} busy={busy} />
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || checking || selected.status === "completed" || selected.chainId !== chainId} onClick={() => { void start(); }}>{busy ? "正在执行，请查看下方记录…" : selected.status === "ready" ? selected.funding ? "充值到账后开始交易" : "启动本批实际交易" : "恢复核对并继续"}</Button>
          <Button disabled={checking || selected.chainId !== chainId || selected.status === "completed" || selected.status === "ready"} onClick={() => { void stop(); }}>停止开新仓并收尾</Button>
          <Button disabled={busy || checking} onClick={() => { void statistics(); }}>补查实际成交与费用</Button>
          <Button onClick={download}>导出报告</Button>
          {selected.wallets.every(w => !w.orders.length) && selected.status === "ready" && fundingUntouched(selected.funding) && <Button disabled={busy} onClick={() => { void abandonReady(); }}>取消未启动计划</Button>}
        </div>
        <EventTimeline run={selected} />
        {selected.funding && <FundingSummary saved funding={selected.funding} onCopy={() => { void copyTreasury(selected.funding!.treasury.address); }} />}
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <span>已确认成交量：{human(sum(selected.wallets.flatMap(w => w.reports.filter(r => r.indexed || r.notBroadcast).map(r => r.volumeX18))))} U</span>
          <span>已确认订单费用：{human(sum(selected.wallets.flatMap(w => w.reports.filter(r => r.indexed || r.notBroadcast).map(r => r.feeX18))))} U</span>
          <span>已核对账户权益净减少：{human(sum(selected.wallets.filter(w => w.before && w.after).map(w => (BigInt(w.before!.equityX18) - BigInt(w.after!.equityX18)).toString())))} U</span>
        </div>
        {selected.wallets.some(w => w.orders.length > w.reports.filter(r => r.indexed || r.notBroadcast).length) && <p className="text-xs text-kumo-subtle">以上为已核对部分，尚有订单待归档，不能作为本批最终总成本。</p>}
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>钱包</th><th>状态</th><th>实际成交量 U</th><th>已确认费用 U</th><th>权益净减少 U</th><th>用时 / 说明</th></tr></thead><tbody>
          {selected.wallets.map(w => {
            const indexed = w.reports.length === w.orders.length && w.reports.every(r => r.indexed || r.notBroadcast);
            return <tr className="border-t border-kumo-line" key={w.wallet.id}><td className="py-3">{w.wallet.label}<div className="text-xs">{w.market?.symbol}</div></td><td>{WALLET_STATUS[w.status]}</td><td>{w.orders.length && !indexed ? "待归档" : human(sum(w.reports.map(r => r.volumeX18)))}</td><td>{w.orders.length && !indexed ? "待归档" : human(sum(w.reports.map(r => r.feeX18)))}</td><td>{w.before && w.after ? human((BigInt(w.before.equityX18) - BigInt(w.after.equityX18)).toString()) : "—"}</td><td className="max-w-72 text-xs">{w.startedAt && w.finishedAt ? `${((w.finishedAt - w.startedAt) / 1000).toFixed(1)} 秒` : "—"}{w.message && <div>{safeTradeMessage(w.message)}</div>}</td></tr>;
          })}
        </tbody></table></div>
        <OrderDetails run={selected} />
        <p className="text-xs text-kumo-subtle">权益净减少包含交易盈亏、费用及可能的资金费用，负数表示净增加；不能再把手续费重复相加。成交量来自归档成交记录，不按请求金额计数。归档暂未返回时显示“待归档”；本地日志能证明从未发送的订单单独标为未发送，金额为零。</p>
      </>}
      {!runs.length && <p className="text-sm text-kumo-subtle">还没有测试批次。先检查账户资金，再保存计划。</p>}
    </section>
    {preview && <section className="rounded-xl border border-kumo-line bg-kumo-base p-5 space-y-3">
      <h2 className="font-semibold">预检结果 · {time(preview.at)}</h2>
      <div className="overflow-x-auto"><table data-testid="preflight-table" className="w-full min-w-[1040px] text-left text-sm"><thead><tr><th>钱包 / 完整地址</th><th>方向 / 市场</th><th>实际名义额</th><th>逐仓保证金</th><th>最低可用余额</th><th>Nado 余额</th><th>结果</th></tr></thead><tbody>
        {preview.rows.map(r => <tr className="border-t border-kumo-line" key={r.wallet.id}><td className="py-3 pr-3">{r.wallet.label}<div className="max-w-56 break-all text-xs font-mono">{r.wallet.address}</div></td><td>{r.side === "buy" ? "多" : "空"} / {r.symbol ?? "—"}</td><td>{human(r.notional)}</td><td>{human(r.margin)}</td><td>{human(r.required)}</td><td>{human(r.balance)}</td><td className="max-w-72">{r.error ?? (r.required && r.balance !== undefined && BigInt(r.balance) < BigInt(r.required) ? "需充值 · 由资金库自动补足" : "通过")}</td></tr>)}
      </tbody></table></div>
      {preview.fundingError && <p role="alert" className="text-sm">充值预检未完成：{preview.fundingError}</p>}
      {preview.funding && <FundingSummary funding={preview.funding} balance={preview.treasuryBalance} onCopy={() => { void copyTreasury(preview.funding!.treasury.address); }} />}
      <Button disabled={busy || checking || preview.rows.some(r => r.error) || !!preview.fundingError || (chainId === 57073 && !preview.funding)} onClick={() => { void save(); }}>保存本批计划</Button>
      <p className="text-xs text-kumo-subtle">最低可用余额包含保证金、比例手续费和保守的固定执行费预留；预留不是实际收费，不覆盖全部行情波动。资金库暂时不足也可保存，保存不转账、不下单；启动时重新核对余额。只充值这 10 个账户，不自动借款、提现或划转到下一批。</p>
    </section>}
    <p className="text-xs text-kumo-subtle">报告标为内部测试；平台后台对公开统计和积分的排除配置仍由 Nado 管理，本地标签不会改变平台奖励资格。资金交接将在交易、归档与结算核实后单独处理。</p>
  </div>;
}
