"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, ButtonGroup, Input, LayerCard, Text } from "@cloudflare/kumo";
import { formatEther, formatUnits, parseEther } from "viem";
import { ChineseButton as Button } from "./ChineseButton";
import { useNetwork } from "./NetworkProvider";
import { cohortWallets, isUnlocked } from "../lib/custody";
import { FundsEngine } from "../lib/funds/engine";
import { IndexedDbFundsStore } from "../lib/funds/store";
import { buildTestCycle } from "../lib/funds/planner";
import { createInkFundsAdapter, simulateInkSponsoredTransfer } from "../lib/funds/inkAdapter";
import type { FundsAdapter, FundsLeg, FundsLimits, FundsPlan, FundsRun, FundsWallet, FundsWalletBalance } from "../lib/funds/types";

type BatchDraft = { kind: "batch-handoff"; treasury: FundsWallet; legs: FundsLeg[]; limits: FundsLimits };
type Preview = { plan: FundsPlan | BatchDraft; balances: Record<string, FundsWalletBalance>; checkedAt: string; referenceFeeWei?: string; estimateError?: string };
const LEG_STATUS: Record<FundsLeg["status"], string> = {
  pending: "待转账", authorized: "已签署授权", prepared: "已保存待发送交易", broadcast: "已发送，待确认",
  confirmed: "已核实到账", "needs-attention": "需要检查",
};
const RUN_STATUS: Record<FundsRun["status"], string> = {
  ready: "预检完成，待启动", running: "正在交接", paused: "已暂停", completed: "交接完成", "needs-attention": "需要检查",
};
const eth = (value?: string) => value === undefined ? "—" : formatEther(BigInt(value));
const units = (value?: string) => value === undefined ? "—" : formatUnits(BigInt(value), 6);
const time = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
const address = (wallet: FundsWallet) => <span className="break-all font-mono text-xs">{wallet.address}</span>;
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请重试检查。";

function wallet(number: number): FundsWallet {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("钱包编号从 1 开始，请填写整数。");
  const found = cohortWallets().find((item) => item.walletId === `live:${number - 1}`);
  if (!found) throw new Error(`当前保险库中没有 ${number} 号钱包，请核对账户。`);
  return { id: found.walletId, address: found.address, label: `${number} 号钱包` };
}

/** Explicitly omit reusable authorizations and signed raw transactions from downloaded reports. */
function report(run: FundsRun) {
  return {
    id: run.plan.id, batchId: run.plan.completion?.batchId, kind: run.plan.kind,
    chainId: run.plan.chainId, token: run.plan.token, treasury: run.plan.treasury,
    createdAt: run.plan.createdAt, updatedAt: run.updatedAt, status: run.status,
    limits: run.plan.limits, completion: run.plan.completion, message: run.message,
    transfers: run.plan.legs.map((leg) => ({
      id: leg.id, source: leg.from, target: leg.to, status: leg.status,
      amountUnits: leg.authorization?.value ?? (leg.amount.kind === "fixed" ? leg.amount.units : undefined),
      sourceEthBeforeWei: leg.sourceEthBeforeWei, targetEthBeforeWei: leg.targetEthBeforeWei,
      sourceEthAfterWei: leg.sourceEthAfterWei, targetEthAfterWei: leg.targetEthAfterWei,
      targetTokenBeforeUnits: leg.targetTokenBeforeUnits, targetTokenAfterUnits: leg.targetTokenAfterUnits,
      transactionHash: leg.transaction?.hash, submittedAt: leg.submittedAt, confirmedAt: leg.confirmedAt,
      blockTimestampMs: leg.receipt?.blockTimestampMs, gasUsed: leg.receipt?.gasUsed,
      l1FeeWei: leg.receipt?.l1FeeWei, actualFeeWei: leg.actualFeeWei, error: leg.error,
      externalTransactionHash: leg.externalReceipt?.hash,
    })),
  };
}

function download(run: FundsRun, kind: "json" | "csv") {
  const clean = report(run);
  const quote = (value: unknown) => {
    const text = String(value ?? "");
    return `"${(/^[=+@-]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
  };
  const rows = clean.transfers.map((leg) => [
    clean.id, clean.batchId, leg.id, leg.source.label, leg.source.address, leg.target.label, leg.target.address,
    units(leg.amountUnits), LEG_STATUS[leg.status], leg.transactionHash, leg.submittedAt, leg.confirmedAt,
    leg.submittedAt && leg.confirmedAt ? (Date.parse(leg.confirmedAt) - Date.parse(leg.submittedAt)) / 1000 : "",
    leg.gasUsed, eth(leg.actualFeeWei), eth(leg.l1FeeWei), eth(leg.sourceEthBeforeWei), eth(leg.targetEthBeforeWei), eth(leg.sourceEthAfterWei), eth(leg.targetEthAfterWei), leg.error,
  ]);
  const content = kind === "json" ? JSON.stringify(clean, null, 2) : "\uFEFF" + [
    ["任务编号", "交易批次", "转账编号", "来源钱包", "来源地址", "目标钱包", "目标地址", "金额USDT0", "状态", "交易哈希", "发送时间", "核实到账时间", "等待秒数", "Gas用量", "总手续费ETH", "其中L1费用ETH", "发送前来源ETH", "发送前目标ETH", "确认后来源ETH", "确认后目标ETH", "说明"],
    ...rows,
  ].map((row) => row.map(quote).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([content], { type: kind === "json" ? "application/json" : "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = `nado-funds-${run.plan.id}.${kind}`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function FundsPanel() {
  const { chainId } = useNetwork();
  const [mode, setMode] = useState<"test-cycle" | "batch-handoff">("test-cycle");
  const [sourceStart, setSourceStart] = useState("1");
  const [targetStart, setTargetStart] = useState("11");
  const [count, setCount] = useState("10");
  const [perFee, setPerFee] = useState("0.000002");
  const [totalFee, setTotalFee] = useState("0.00002");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [runs, setRuns] = useState<FundsRun[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [confirmedPreview, setConfirmedPreview] = useState(false);
  const runtime = useRef<{ engine: FundsEngine; store: IndexedDbFundsStore; adapter: FundsAdapter } | null>(null);
  const ownRun = useRef<string | null>(null);
  const actionActive = useRef(false);
  const mounted = useRef(true);
  const mainnet = chainId === 57073;

  const refresh = useCallback(async () => {
    const next = await runtime.current?.store.list();
    if (next && mounted.current) setRuns(next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }, []);

  useEffect(() => {
    mounted.current = true;
    const store = new IndexedDbFundsStore();
    const adapter = createInkFundsAdapter();
    const engine = new FundsEngine({ store, adapter, onChange: () => { void refresh(); } });
    runtime.current = { store, adapter, engine };
    // Opening a page only loads the journal. It never signs, sends or resumes a transfer.
    void engine.recoverInterrupted().then(refresh).catch((error) => { if (mounted.current) setMessage(errorText(error)); });
    const poll = setInterval(() => { void refresh().catch(() => {}); }, 2000);
    return () => {
      mounted.current = false;
      clearInterval(poll);
      if (ownRun.current) void engine.pause(ownRun.current).catch(() => {});
    };
  }, [refresh]);

  useEffect(() => {
    if (ownRun.current) void runtime.current?.engine.pause(ownRun.current).catch(() => {});
    setPreview(null); setConfirmedPreview(false);
  }, [chainId]);

  const resetPreview = () => { setPreview(null); setConfirmedPreview(false); setMessage(""); };
  const change = (setter: (value: string) => void) => (event: React.ChangeEvent<HTMLInputElement>) => { setter(event.target.value); resetPreview(); };
  const selected = runs.find((run) => run.plan.id === selectedId) ?? runs[0];

  const preflight = async () => {
    if (actionActive.current) return;
    actionActive.current = true;
    setBusy(true); resetPreview();
    try {
      if (!mainnet || !isUnlocked()) throw new Error("请先切换到 Ink 主网并解锁本地保险库。");
      const api = runtime.current;
      if (!api) throw new Error("页面尚未准备好，请稍后重试。");
      const limits = { maxFeePerLegWei: parseEther(perFee).toString(), maxTotalFeeWei: parseEther(totalFee).toString(), authorizationTtlSeconds: 600 };
      if (BigInt(limits.maxFeePerLegWei) <= 0n || BigInt(limits.maxTotalFeeWei) <= 0n) throw new Error("手续费上限必须大于 0。");
      let plan: FundsPlan | BatchDraft;
      if (mode === "test-cycle") {
        const unfinished = (await api.store.list()).find((run) => run.plan.kind === "test-cycle" && run.status !== "completed");
        if (unfinished) {
          setSelectedId(unfinished.plan.id);
          throw new Error("已有未完成的循环测试，请在下方核对原交易并恢复原任务；不要另建一笔转账。");
        }
        plan = buildTestCycle({ wallets: [wallet(1), wallet(2), wallet(3)], amount: "1", limits });
      } else {
        const size = Number(count), source = Number(sourceStart), target = Number(targetStart);
        if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw new Error("每次交接支持 1 至 100 个钱包。");
        const sources = Array.from({ length: size }, (_, index) => wallet(source + index));
        const targets = Array.from({ length: size }, (_, index) => wallet(target + index));
        const sourceAddresses = new Set(sources.map((item) => item.address.toLowerCase()));
        if (targets.some((item) => sourceAddresses.has(item.address.toLowerCase()))) throw new Error("来源钱包与下一批目标钱包不能重叠，请调整范围。");
        // A planning draft deliberately has no completion event or executable plan identifier.
        plan = { kind: "batch-handoff", treasury: wallet(1), limits,
          legs: sources.map((from, index) => ({ id: `preview-${index + 1}`, from, to: targets[index]!, amount: { kind: "all" }, status: "pending" })),
        };
      }
      if (await api.adapter.getChainId() !== 57073) throw new Error("当前连接不是 Ink 主网，已停止。");
      const unique = new Map([plan.treasury, ...plan.legs.flatMap((leg) => [leg.from, leg.to])].map((item) => [item.id, item]));
      const balances: Record<string, FundsWalletBalance> = {};
      for (const item of unique.values()) {
        await api.adapter.assertIdentity(item);
        balances[item.id] = await api.adapter.readWallet(item);
      }
      if ("id" in plan) {
        await api.adapter.assertTradingReady(plan);
        if (BigInt(balances[plan.treasury.id]!.ethWei) < BigInt(limits.maxTotalFeeWei)) throw new Error("资金库 ETH 少于本批手续费预算，请降低预算或补充资金。");
        if (BigInt(balances["live:0"]!.tokenUnits) < 1_000_000n) throw new Error("1 号钱包链上余额不足 1 USDT0。");
        if (["live:1", "live:2"].some((id) => BigInt(balances[id]!.ethWei) !== 0n)) throw new Error("这次验证要求 2、3 号钱包初始 ETH 为 0；当前不满足，请先核对钱包。");
      }
      let referenceFeeWei: string | undefined, estimateError: string | undefined;
      try { referenceFeeWei = (await simulateInkSponsoredTransfer()).estimatedFeeWei; }
      catch { estimateError = "参考费用暂时无法查询，实际发送前仍会重新估算并执行预算限制。"; }
      setPreview({ plan, balances, checkedAt: new Date().toISOString(), referenceFeeWei, estimateError });
      setMessage(plan.kind === "test-cycle" ? "只读预检完成，尚未签名或发送。请核对地址及预算，然后显式启动。" : "规划预览已生成，尚未检查交易完成条件。批次执行待交易策略确定后接入。");
    } catch (error) { setMessage(errorText(error)); }
    finally { actionActive.current = false; if (mounted.current) setBusy(false); }
  };

  const execute = async (existing?: FundsRun) => {
    if (!runtime.current || actionActive.current || !mainnet || !isUnlocked()) return;
    actionActive.current = true;
    const api = runtime.current;
    setBusy(true); setMessage("");
    let id: string | undefined;
    try {
      if (!existing && (!preview || !confirmedPreview)) throw new Error("请先预检并核对转账明细。");
      if (existing?.plan.kind === "batch-handoff" || (!existing && (!preview || !("id" in preview.plan)))) throw new Error("批次执行待交易策略确定后接入；当前仅可执行 1 USDT0 循环测试。");
      if (!existing) {
        const unfinished = (await api.store.list()).find((run) => run.plan.kind === "test-cycle" && run.status !== "completed");
        if (unfinished) { setSelectedId(unfinished.plan.id); throw new Error("已有未完成的循环测试，请恢复原任务，不能重复启动新任务。"); }
      }
      const saved = existing ?? await api.engine.create(preview!.plan as FundsPlan);
      id = saved.plan.id;
      // Navigating away while IndexedDB is saving must not start signing afterward.
      if (!mounted.current) { await api.engine.pause(id); return; }
      ownRun.current = id; setRunningId(id); setSelectedId(id); setPreview(null); setConfirmedPreview(false);
      await refresh();
      if (!mounted.current) { await api.engine.pause(id); return; }
      const result = await api.engine.run(id);
      if (mounted.current) setMessage(result.message ?? RUN_STATUS[result.status]);
    } catch (error) { if (mounted.current) setMessage(errorText(error)); }
    finally {
      ownRun.current = null;
      actionActive.current = false;
      if (mounted.current) { setBusy(false); setRunningId(null); await refresh(); }
    }
  };

  const pause = async () => {
    if (!runningId) return;
    try {
      await runtime.current?.engine.pause(runningId);
      setMessage("已请求暂停。已经发送的交易仍会在链上处理；恢复时会先查询原交易，不会重新转一笔。");
      await refresh();
    } catch (error) { setMessage(errorText(error)); }
  };

  return (
    <div className="flex flex-col gap-5" data-testid="funds-panel">
      {!mainnet && <p role="status" className="rounded-lg border border-kumo-line bg-kumo-base p-4">资金交接只用于 Ink 主网。请在上方切换主网，再解锁保险库；切换不会转账。</p>}
      <LayerCard>
        <LayerCard.Secondary>准备交接</LayerCard.Secondary>
        <LayerCard.Primary className="flex flex-col gap-4">
          <ButtonGroup aria-label="交接方式">
            <Button size="sm" variant={mode === "test-cycle" ? "primary" : "secondary"} disabled={busy} onClick={() => { setMode("test-cycle"); resetPreview(); }}>先测试 1 USDT0</Button>
            <Button size="sm" variant={mode === "batch-handoff" ? "primary" : "secondary"} disabled={busy} onClick={() => { setMode("batch-handoff"); resetPreview(); }}>交易结束后交给下一批</Button>
          </ButtonGroup>
          {mode === "test-cycle" ? (
            <div className="flex flex-col gap-2">
              <p className="font-medium">1 号 → 2 号 → 3 号 → 1 号，每笔 1 USDT0</p>
              <Text variant="secondary">同一笔 1 USDT0 依次流转，手续费由 1 号钱包另外支付。钱包互转支持 1 USDT0；不会把这笔钱存入 Nado。预检要求 2、3 号钱包的 ETH 为 0。</Text>
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Input label="来源起始钱包号" type="number" min={1} value={sourceStart} disabled={busy} onChange={change(setSourceStart)} />
                <Input label="目标起始钱包号" type="number" min={1} value={targetStart} disabled={busy} onChange={change(setTargetStart)} />
                <Input label="每批钱包数" type="number" min={1} max={100} value={count} disabled={busy} onChange={change(setCount)} />
              </div>
              <Text variant="secondary">按顺序一对一交接，例如 1 → 11、2 → 12，直到 10 → 20。每个来源钱包转出当时全部链上 USDT0；同一交易批次只能登记一次。</Text>
              <Text variant="secondary" size="xs">直接交接 N 对钱包需要 N 笔转账；先汇总到资金库再分发通常需要约 2N 笔，适合重新分配金额。本页先保留直接交接框架，钱包数量及长期调度策略稍后确定。</Text>
              <p className="rounded-md border border-kumo-line p-3 text-sm">批次执行待交易策略确定后接入。这里仅预览钱包分配，不会登记交易完成或发送资金。接入后需等待真实批次完成事件、无仓位挂单及提现到账；订单提交成功不算完成。</p>
            </>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="每笔手续费上限（ETH）" inputMode="decimal" value={perFee} disabled={busy} onChange={change(setPerFee)} />
            <Input label="整批手续费上限（ETH）" inputMode="decimal" value={totalFee} disabled={busy} onChange={change(setTotalFee)} />
          </div>
          <Text variant="secondary" size="xs">这是发送前核验的费用预算，不是固定报价。预计费用超过预算则暂停；L1 费用有预留空间，最终以链上记录为准。授权短时有效，只允许本次金额和收款人。</Text>
          <div><Button variant="primary" loading={busy && !runningId} disabled={busy || !mainnet} onClick={() => void preflight()}>{mode === "test-cycle" ? "预检并查看完整地址" : "预览交接规划"}</Button></div>
        </LayerCard.Primary>
      </LayerCard>

      {preview && <LayerCard>
        <LayerCard.Secondary>{preview.plan.kind === "test-cycle" ? "核对后启动" : "交接规划（仅预览）"} · {time(preview.checkedAt)}</LayerCard.Secondary>
        <LayerCard.Primary className="flex flex-col gap-4">
          <p>手续费资金库：<strong>1 号钱包</strong> · {address(preview.plan.treasury)}</p>
          <p>资金库当前 ETH：<strong>{eth(preview.balances[preview.plan.treasury.id]?.ethWei)}</strong>；本批上限：{eth(preview.plan.limits.maxTotalFeeWei)} ETH。</p>
          {preview.referenceFeeWei ? <p className="text-sm">当前授权转账的参考费用：每笔约 {eth(preview.referenceFeeWei)} ETH，{preview.plan.legs.length} 笔约 {eth((BigInt(preview.referenceFeeWei) * BigInt(preview.plan.legs.length)).toString())} ETH。参考值来自虚拟余额的只读模拟，实际发送前按钱包状态重新估算。</p> : <p className="text-sm text-kumo-subtle">{preview.estimateError}</p>}
          <div className="overflow-x-auto"><table className="w-full min-w-[660px] text-left text-sm"><thead><tr className="border-b border-kumo-line"><th className="p-2">来源钱包 / 完整地址</th><th className="p-2">目标钱包 / 完整地址</th><th className="p-2">金额 USDT0</th><th className="p-2">来源 / 目标 ETH</th></tr></thead><tbody>{preview.plan.legs.map((leg) => <tr key={leg.id} className="border-b border-kumo-line"><td className="p-2"><p>{leg.from.label}</p>{address(leg.from)}</td><td className="p-2"><p>{leg.to.label}</p>{address(leg.to)}</td><td className="p-2">{leg.amount.kind === "fixed" ? units(leg.amount.units) : `全部（当前 ${units(preview.balances[leg.from.id]?.tokenUnits)}）`}</td><td className="p-2 font-mono text-xs">{eth(preview.balances[leg.from.id]?.ethWei)}<br />{eth(preview.balances[leg.to.id]?.ethWei)}</td></tr>)}</tbody></table></div>
          {preview.plan.kind === "test-cycle" ? <><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmedPreview} onChange={(event) => setConfirmedPreview(event.target.checked)} /><span>已核对上述完整地址、转账金额和手续费上限，使用本地保险库签名执行这一次交接。</span></label><div><Button variant="primary" disabled={!confirmedPreview || busy || !mainnet} onClick={() => void execute()}>启动 1 USDT0 循环测试</Button></div></> : <p className="text-sm text-kumo-subtle">规划尚不可执行；钱包数量和交易策略确定后，再连接批次完成信号。</p>}
        </LayerCard.Primary>
      </LayerCard>}

      {message && <p role="status" className="rounded-lg border border-kumo-line bg-kumo-base p-3 text-sm">{message}</p>}

      <LayerCard>
        <LayerCard.Secondary>交接记录与中断恢复</LayerCard.Secondary>
        <LayerCard.Primary className="flex flex-col gap-4">
          <Text variant="secondary">记录保存在当前浏览器。关闭页面后不会自动继续；重新打开后先核对原交易，再手动恢复。请保留浏览器数据。</Text>
          {runs.length === 0 ? <p className="text-sm text-kumo-subtle">尚未启动交接。完成预检不会产生链上转账记录。</p> : <>
            <label className="flex flex-col gap-1 text-sm">选择任务<select className="rounded-md border border-kumo-line bg-kumo-base p-2" value={selected?.plan.id ?? ""} disabled={Boolean(runningId)} onChange={(event) => setSelectedId(event.target.value)}>{runs.map((run) => <option key={run.plan.id} value={run.plan.id}>{run.plan.kind === "test-cycle" ? "1 USDT0 循环测试" : run.plan.completion?.batchId} · {time(run.plan.createdAt)} · {RUN_STATUS[run.status]}</option>)}</select></label>
            {selected && <>
              <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><Badge>{RUN_STATUS[selected.status]}</Badge><span className="text-sm">{selected.plan.legs.filter((leg) => leg.status === "confirmed").length} / {selected.plan.legs.length} 笔已核实到账</span></div><div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => download(selected, "csv")}>导出 CSV</Button><Button size="sm" onClick={() => download(selected, "json")}>导出 JSON</Button>{runningId === selected.plan.id ? <Button size="sm" variant="secondary-destructive" onClick={() => void pause()}>请求暂停</Button> : selected.status !== "completed" && selected.plan.kind === "test-cycle" && <Button size="sm" variant="primary" disabled={busy || !mainnet} onClick={() => void execute(selected)}>核对原交易并恢复</Button>}</div></div>
              <p className="text-sm">已确认手续费合计：<strong>{eth(selected.plan.legs.reduce((sum, leg) => sum + BigInt(leg.actualFeeWei ?? "0"), 0n).toString())} ETH</strong>（包含已记录的 L1 费用）。</p>
              {selected.message && <p className="text-sm text-kumo-subtle">{selected.message}</p>}
              <div className="flex flex-col gap-3">{selected.plan.legs.map((leg, index) => <LegDetail key={leg.id} leg={leg} index={index} />)}</div>
            </>}
          </>}
        </LayerCard.Primary>
      </LayerCard>
    </div>
  );
}

function LegDetail({ leg, index }: { leg: FundsLeg; index: number }) {
  const seconds = leg.submittedAt && leg.confirmedAt ? Math.max(0, (Date.parse(leg.confirmedAt) - Date.parse(leg.submittedAt)) / 1000) : null;
  return <div className="rounded-lg border border-kumo-line p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{index + 1}. {leg.from.label} → {leg.to.label} · {leg.authorization ? units(leg.authorization.value) : leg.amount.kind === "fixed" ? units(leg.amount.units) : "全部链上余额"} USDT0</p><Badge>{LEG_STATUS[leg.status]}</Badge></div>
    <div className="mt-2 grid gap-2 sm:grid-cols-2"><p>来源：{address(leg.from)}</p><p>目标：{address(leg.to)}</p><p>发送前来源 ETH：{eth(leg.sourceEthBeforeWei)}</p><p>发送前目标 ETH：{eth(leg.targetEthBeforeWei)}</p><p>确认后来源 ETH：{eth(leg.sourceEthAfterWei)}</p><p>确认后目标 ETH：{eth(leg.targetEthAfterWei)}</p><p>发送：{time(leg.submittedAt)}</p><p>核实到账：{time(leg.confirmedAt)}{seconds !== null && `（${seconds.toFixed(2)} 秒）`}</p><p>实际总费用：{eth(leg.actualFeeWei)} ETH</p><p>其中 L1：{eth(leg.receipt?.l1FeeWei)} ETH</p>{leg.receipt && <p>链上确认时间：{new Date(leg.receipt.blockTimestampMs).toLocaleString("zh-CN", { hour12: false })}</p>}</div>
    {leg.transaction && <a className="mt-2 block break-all font-mono text-xs text-kumo-link underline" href={`https://explorer.inkonchain.com/tx/${leg.transaction.hash}`} target="_blank" rel="noreferrer">查看交易：{leg.transaction.hash}</a>}
    {leg.externalReceipt && <a className="mt-2 block break-all font-mono text-xs text-kumo-link underline" href={`https://explorer.inkonchain.com/tx/${leg.externalReceipt.hash}`} target="_blank" rel="noreferrer">待核对的另一笔代付交易：{leg.externalReceipt.hash}</a>}
    {leg.error && <p role="status" className="mt-2 text-kumo-danger">{leg.error}</p>}
  </div>;
}
