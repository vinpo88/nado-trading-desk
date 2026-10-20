"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, ButtonGroup, Checkbox, Input, InputGroup, LayerCard, Meter, Select } from "@cloudflare/kumo";
import { ArrowClockwiseIcon, PlayIcon, ProhibitIcon, TimerIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { WalletVM } from "@farm/ui";
import { renderActionForm } from "@farm/ui";
import { parseCron } from "@farm/core";
import type { ParamValue, Market, ScheduleSpec } from "@farm/adapter-api";
import { NADO_MANIFEST } from "@farm/adapter-nado";
import { MARKETS } from "../lib/runtime";
import { isLiveWallet } from "../lib/live";
import { bulk } from "../lib/bulk";
import type { BulkParams } from "../lib/bulk";
import { ConfirmDialog } from "./ConfirmDialog";
import { DynamicForm } from "./DynamicForm";
import { useNetwork } from "./NetworkProvider";
import { zhError, zhLabel } from "../lib/zh";

type Stats = Record<"pending" | "running" | "done" | "failed", number>;
const ZERO: Stats = { pending: 0, running: 0, done: 0, failed: 0 };

/** A numeric field with an optional jitter range: a Kumo Checkbox toggles min–max, and the one or two
 *  values are Kumo Inputs with their own accessible names (Kumo has no range input). */
function JitterField({ label, value, setValue, jitter, setJitter, max, setMax }: {
  label: string; value: string; setValue: (v: string) => void;
  jitter: boolean; setJitter: (b: boolean) => void; max: string; setMax: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}{jitter ? "（最小值至最大值）" : ""}</span>
        <Checkbox label="随机范围" checked={jitter} onCheckedChange={(c) => setJitter(c === true)} />
      </div>
      {/* min-w-0 + flex-1: a bare input element keeps its intrinsic size=20 width as its flex minimum, so the
          min–max pair would overrun the 260px sidebar instead of splitting it. */}
      <div className="flex gap-2">
        <Input size="sm" className="min-w-0 flex-1" aria-label={jitter ? `${label}最小值` : label} value={value} onChange={(e) => setValue(e.target.value)} />
        {jitter && <Input size="sm" className="min-w-0 flex-1" aria-label={`${label}最大值`} value={max} onChange={(e) => setMax(e.target.value)} />}
      </div>
    </div>
  );
}

export function BulkPanel({ wallets, liveMarkets }: { wallets: WalletVM[]; liveMarkets?: Market[] }) {
  const { net } = useNetwork(); // live network name for the confirm copy (no hardcoded "testnet")
  const list = wallets ?? [];
  // When every target is the LIVE wallet, drive the market picker from the live
  // market map (all products from getSymbols) instead of the static manifest enum.
  const allLive = list.length > 0 && list.every(isLiveWallet) && (liveMarkets?.length ?? 0) > 0;
  // The market/side/kind controls are generated from the Nado manifest's typed
  // settings schema (renderActionForm) — no hardcoded protocol knowledge here.
  const model = useMemo(() => renderActionForm("placeOrder", NADO_MANIFEST.settings, NADO_MANIFEST.capabilities), []);
  const enumModel = useMemo(
    () => ({ fields: model.fields.filter((f) => f.schema.kind === "enum" && !(allLive && f.schema.id === "market")) }),
    [model, allLive],
  );
  const [values, setValues] = useState<Record<string, ParamValue>>(() =>
    Object.fromEntries(model.fields.map((f) => [f.schema.id, (f.value ?? "") as ParamValue])));
  const setVal = (id: string, v: ParamValue) => setValues((s) => ({ ...s, [id]: v }));
  const defaultLiveMarket = allLive ? (liveMarkets!.find((m) => m.id.endsWith("BTC-PERP")) ?? liveMarkets![0]!).id : undefined;
  const market = allLive ? String(values.market ?? defaultLiveMarket) : String(values.market ?? MARKETS[0]!.id);
  const side = String(values.side ?? "buy") as "buy" | "sell";
  const kind = String(values.kind ?? "limit") as "limit" | "market";

  const [size, setSize] = useState("0.1");
  const [sizeJitter, setSizeJitter] = useState(true);
  const [sizeMax, setSizeMax] = useState("0.5");
  const [price, setPrice] = useState("63120");
  const [priceJitter, setPriceJitter] = useState(true);
  const [priceMax, setPriceMax] = useState("63500");
  const [chaos, setChaos] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [stats, setStats] = useState<Stats>(ZERO);
  const [active, setActive] = useState(false);
  const [halted, setHalted] = useState(false);
  const [schedMode, setSchedMode] = useState<"once" | "interval" | "cron">("once");
  const [everyMin, setEveryMin] = useState("15");
  const [cronExpr, setCronExpr] = useState("*/15 * * * *");
  const [maxRuns, setMaxRuns] = useState("20"); // hard cap so a recurring schedule can't fire forever
  const [schedRunning, setSchedRunning] = useState(false);
  const [schedErr, setSchedErr] = useState<string | null>(null);
  const cronValid = useMemo(() => {
    if (schedMode !== "cron") return true;
    try { parseCron(cronExpr); return true; } catch { return false; }
  }, [schedMode, cronExpr]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // On mount, re-derive the schedule indicator from the singleton engine (a schedule may already be
  // running if this panel remounted), then resume polling; clean up the poll timer on unmount.
  useEffect(() => {
    if (bulk.scheduleActive) { setActive(true); setSchedRunning(true); poll(); }
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const poll = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(async () => {
      const s = (await bulk.stats()) as Stats;
      setStats(s);
      setHalted(bulk.halted);
      setSchedErr(bulk.scheduleError);
      setSchedRunning(bulk.scheduleActive); // follow the engine: a dead/capped/killed schedule clears the UI
      // Keep polling while a recurring schedule is active (it goes idle between fires); only a
      // one-shot run ends when the queue drains.
      if (!bulk.scheduleActive && bulk.running === 0 && s.pending === 0) {
        if (timer.current) clearInterval(timer.current);
        setActive(false);
      }
    }, 300);
  };

  const run = async () => {
    if (list.length === 0) return;
    setConfirmOpen(false);
    bulk.faultRate = chaos ? 0.08 : 0;
    bulk.register(list);
    const params: BulkParams = {
      market, side, kind,
      size: sizeJitter ? { min: Number(size), max: Number(sizeMax) } : Number(size),
      price: priceJitter ? { min: Number(price), max: Number(priceMax) } : Number(price),
    };
    const targets = list.map((w) => ({ walletId: w.id, tags: w.cohorts }));
    setActive(true);
    setHalted(false);
    setSchedErr(null);
    poll();
    if (schedMode === "once") {
      await bulk.launch(params, targets);
    } else {
      const schedule: ScheduleSpec = schedMode === "interval"
        ? { mode: "interval", everyMs: Math.max(1, Number(everyMin) || 1) * 60_000 }
        : { mode: "cron", expr: cronExpr };
      await bulk.launchScheduled(params, targets, schedule, Math.max(1, Number(maxRuns) || 1));
      setSchedRunning(bulk.scheduleActive); // false if it failed to start / completed synchronously
    }
  };

  const stopSchedule = () => { bulk.stopSchedule(); setSchedRunning(false); };

  const retry = async () => {
    setActive(true);
    setHalted(false);
    poll();
    await bulk.retryFailed();
  };

  const total = stats.pending + stats.running + stats.done + stats.failed;
  const pct = total ? Math.round(((stats.done + stats.failed) / total) * 100) : 0;
  const liveCount = list.filter(isLiveWallet).length; // real sequencer orders in this target
  const everyN = Math.max(1, Number(everyMin) || 1);
  const runsCap = Math.max(1, Number(maxRuns) || 1);
  const em = (v: React.ReactNode) => <strong className="font-medium text-kumo-default">{v}</strong>;

  return (
    <>
      {/* shrink-0: an overflow-hidden flex item in the fixed-height sidebar would otherwise shrink and
          clip its own controls instead of letting the sidebar scroll. */}
      <LayerCard className="shrink-0">
        <LayerCard.Secondary>批量操作</LayerCard.Secondary>
        <LayerCard.Primary className="flex flex-col gap-3">
          {allLive && (
            <Select
              size="sm"
              label={`交易市场（在线 · ${liveMarkets!.length}）`}
              hideLabel={false}
              value={market}
              onValueChange={(v) => { if (v) setVal("market", String(v)); }}
            >
              {liveMarkets!.map((m) => (
                <Select.Option key={m.id} value={m.id}>{m.id.split(":").pop()}（{zhLabel(m.product)}）</Select.Option>
              ))}
            </Select>
          )}

          <DynamicForm model={enumModel} values={values} onChange={setVal} />

          <JitterField label="数量" value={size} setValue={setSize} jitter={sizeJitter} setJitter={setSizeJitter} max={sizeMax} setMax={setSizeMax} />
          {kind === "limit" && <JitterField label="价格" value={price} setValue={setPrice} jitter={priceJitter} setJitter={setPriceJitter} max={priceMax} setMax={setPriceMax} />}

          <Checkbox label="模拟约 8% 失败（用于测试重试）" checked={chaos} onCheckedChange={(c) => setChaos(c === true)} />

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">执行计划</span>
            <ButtonGroup aria-label="执行计划">
              {(["once", "interval", "cron"] as const).map((m) => (
                <Button
                  key={m}
                  size="xs"
                  variant={schedMode === m ? "primary" : "secondary"}
                  aria-pressed={schedMode === m}
                  disabled={schedRunning || active}
                  onClick={() => setSchedMode(m)}
                >
                  {m === "once" ? "单次" : m === "interval" ? "固定间隔" : "定时表达式"}
                </Button>
              ))}
            </ButtonGroup>
            {schedMode === "interval" && (
              <InputGroup size="sm" label="执行间隔" disabled={schedRunning}>
                <InputGroup.Input aria-label="间隔（分钟）" value={everyMin} onChange={(e) => setEveryMin(e.target.value)} />
                <InputGroup.Suffix>分钟</InputGroup.Suffix>
              </InputGroup>
            )}
            {schedMode === "cron" && (
              <Input
                size="sm"
                aria-label="定时表达式"
                placeholder="*/15 * * * *"
                className="font-mono"
                value={cronExpr}
                onChange={(e) => setCronExpr(e.target.value)}
                disabled={schedRunning}
                error={cronValid ? undefined : "✗ 表达式无效"}
              />
            )}
            {schedMode !== "once" && (
              <InputGroup size="sm" label="达到次数后停止" disabled={schedRunning}>
                <InputGroup.Input aria-label="最多执行次数" value={maxRuns} onChange={(e) => setMaxRuns(e.target.value)} />
                <InputGroup.Suffix>次</InputGroup.Suffix>
              </InputGroup>
            )}
          </div>

          <Button
            variant="primary"
            onClick={() => setConfirmOpen(true)}
            disabled={active || schedRunning || list.length === 0 || (schedMode === "cron" && !cronValid)}
          >
            {schedMode === "once" ? `在 ${list.length} 个钱包上执行` : `启动 ${list.length} 个钱包的定时任务`}
          </Button>

          {/* A running schedule is a NETWORK-ACCENT state (brand-tinted tokens), not Kumo's info blue. */}
          {schedRunning && (
            <div className="flex items-center justify-between gap-2 rounded-md bg-kumo-brand/10 px-3 py-2 ring ring-kumo-brand/40">
              <span className="flex items-center gap-1.5">
                <TimerIcon className="shrink-0 text-kumo-brand" />
                定时任务执行中 · {schedMode === "interval" ? `每 ${everyN} 分钟` : `表达式 ${cronExpr}`} · 执行 {runsCap} 次后停止
              </span>
              <Button size="sm" onClick={stopSchedule}>停止定时任务</Button>
            </div>
          )}
          {schedErr && <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} description={`定时任务错误：${zhError(schedErr)}`} />}

          {(active || total > 0) && (
            <div className="flex flex-col gap-2">
              <Meter label="执行进度" value={pct} customValue={`${stats.done + stats.failed} / ${total}`} showValue />
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums">
                <span><span className="text-kumo-subtle">已完成</span> <strong className="font-medium text-kumo-success">{stats.done}</strong></span>
                <span><span className="text-kumo-subtle">执行中</span> <strong className="font-medium">{stats.running}</strong></span>
                <span><span className="text-kumo-subtle">等待中</span> <strong className="font-medium text-kumo-subtle">{stats.pending}</strong></span>
                {stats.failed > 0 && <span><span className="text-kumo-subtle">失败</span> <strong className="font-medium text-kumo-danger">{stats.failed}</strong></span>}
              </div>
              <div className="flex flex-wrap gap-2">
                {!halted ? (
                  <Button variant="destructive" icon={ProhibitIcon} onClick={() => { bulk.halt(); setHalted(true); }} disabled={!active}>紧急停止</Button>
                ) : (
                  <Button icon={PlayIcon} onClick={() => { bulk.resume(); setHalted(false); setActive(true); poll(); }}>继续执行</Button>
                )}
                {!active && stats.failed > 0 && <Button icon={ArrowClockwiseIcon} onClick={retry}>重试 {stats.failed} 个失败任务</Button>}
              </div>
            </div>
          )}
        </LayerCard.Primary>
      </LayerCard>

      <ConfirmDialog
        open={confirmOpen}
        title="执行批量操作"
        body={<>
          在 {em(list.length)} 个钱包的 {market.split(":").pop()} 市场上提交 {em(list.length)} 笔{zhLabel(side)}{zhLabel(kind)}订单。
          {schedMode !== "once" && liveCount === 0 && (
            <> 按{em("周期计划")}执行（{schedMode === "interval" ? `每 ${everyN} 分钟` : `表达式 ${cronExpr}`}），最多 {runsCap} 次，也可点击{em("停止定时任务")}提前结束。</>
          )}
        </>}
        danger={liveCount > 0 ? (
          <>
            本次包含 {em(liveCount)} 个{net.isTestnet ? "测试网" : "主网"}在线钱包，将签名并提交 {liveCount} 笔实际挂单
            {schedMode !== "once"
              ? <>，{em("每次")}按{schedMode === "interval" ? `${everyN} 分钟间隔` : "定时表达式"}执行，最多重复 {em(runsCap)} 次（可停止定时任务提前结束）。</>
              : <>，价格和数量将按市场规则处理。</>}
          </>
        ) : undefined}
        onConfirm={run}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
