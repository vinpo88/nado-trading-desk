"use client";

import { useRef, useState } from "react";
import { Banner, Button, Input, LayerCard, Text, cn } from "@cloudflare/kumo";
import { CheckCircleIcon, StopIcon, XCircleIcon } from "@phosphor-icons/react";
import type { WalletVM } from "@farm/ui";
import { LIVE_COHORT } from "../lib/live";
import { fundCohortLive, DEFAULT_REFUEL_ETH, DEFAULT_MINT_USDT0, DEFAULT_DEPOSIT_USDT0, TREASURY_WALLET_ID } from "../lib/liveContext";
import type { FundProgress } from "../lib/liveContext";
import { ConfirmDialog } from "./ConfirmDialog";
import { zhError, zhLabel } from "../lib/zh";

type LogLine = { ok: boolean; text: string };

/** Bulk cohort funding (TESTNET on-ramp) — the operator path that productizes fund-cohort.mjs. Targets
 *  the LIVE wallets still `unfunded` (and never the treasury) and runs gas → mint → deposit per wallet,
 *  all signed IN-TAB. Idempotent skips (gas floor + USDT0 balance) mean a re-run only does missing steps,
 *  but depositCollateral is NOT idempotent so only `unfunded` wallets are targeted. Abortable (Stop). */
export function FundingPanel({ wallets, onFunded }: { wallets: WalletVM[]; onFunded?: (walletIds: string[]) => void }) {
  // Wallets already funded THIS session are excluded immediately — depositCollateral is not idempotent and
  // the readiness gate lags on-chain confirmation (the sequencer indexes collateral after the tx mines),
  // so without this a re-run during that window would re-target + double-deposit a just-funded wallet.
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const targets = wallets.filter((w) => w.cohorts.includes(LIVE_COHORT) && w.readiness === "unfunded" && w.id !== TREASURY_WALLET_ID && !doneIds.has(w.id));
  const [gasEach, setGasEach] = useState(DEFAULT_REFUEL_ETH);
  const [mintEach, setMintEach] = useState(DEFAULT_MINT_USDT0);
  const [depositEach, setDepositEach] = useState(DEFAULT_DEPOSIT_USDT0);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const append = (ok: boolean, text: string) => setLog((l) => [{ ok, text }, ...l].slice(0, 12));

  const run = async () => {
    const ids = targets.map((t) => t.id);
    if (ids.length === 0) return;
    setBusy(true); setSummary(null); setLog([]);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fundCohortLive(ids, {
        gasEach, mintEach, depositEach, signal: ac.signal,
        onProgress: (p: FundProgress) => {
          append(p.status === "ok", `${p.walletId} · ${zhLabel(p.phase)}${p.error ? ` — ${zhError(p.error)}` : ""}${p.tx ? ` · ${p.tx.slice(0, 10)}…` : ""}`);
          // Drop a fully-funded wallet from future targets at once (don't wait for the readiness reconcile),
          // so an immediate re-run can't double-deposit it. A FAILED wallet stays targetable for a retry.
          if (p.phase === "done" && p.status === "ok") setDoneIds((s) => new Set(s).add(p.walletId));
        },
      });
      setSummary(`已完成：入金成功 ${res.funded} 个，失败 ${res.failed} 个，跳过 ${res.skipped} 个`);
      onFunded?.(ids); // repaint the attempted wallets + treasury (native/collateral/readiness)
    } catch (e) {
      setSummary(`✗ ${zhError(e)}`); // the "✗ " prefix is part of the cap-reject e2e contract
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <>
      {/* shrink-0: the layered LayerCard is overflow-hidden, so as a flex item in the fixed-height
          sidebar it would otherwise shrink to 0 min-height and clip its own controls (unclickable)
          instead of letting the sidebar scroll. */}
      <LayerCard className="shrink-0">
        <LayerCard.Secondary>批量入金（测试网）</LayerCard.Secondary>
        <LayerCard.Primary className="flex flex-col gap-3">
          <Text variant="secondary" size="xs">
            {targets.length} 个未入金的在线钱包，由资金钱包（{TREASURY_WALLET_ID}）依次补充手续费、领取测试币并充值。
          </Text>
          <div className="flex flex-col gap-2">
            <Input size="sm" label="手续费 ETH" value={gasEach} onChange={(e) => setGasEach(e.target.value)} />
            <Input size="sm" label="领取测试币 USDT0" value={mintEach} onChange={(e) => setMintEach(e.target.value)} />
            <Input size="sm" label="充值 USDT0" value={depositEach} onChange={(e) => setDepositEach(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={busy || targets.length === 0} onClick={() => setConfirm(true)}>
              为 {targets.length} 个钱包入金
            </Button>
            {busy && <Button variant="secondary-destructive" icon={StopIcon} onClick={() => abortRef.current?.abort()}>停止</Button>}
          </div>
          {summary && (summary.startsWith("✗")
            ? <Banner variant="error" size="sm" icon={<XCircleIcon weight="fill" />} description={summary} />
            : <span className="text-kumo-success">{summary}</span>)}
          {log.length > 0 && (
            <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
              {log.map((l, i) => (
                <li key={i} className={cn("flex items-start gap-1.5", l.ok ? "text-kumo-success" : "text-kumo-danger")}>
                  {l.ok ? <CheckCircleIcon className="mt-0.5 shrink-0" /> : <XCircleIcon className="mt-0.5 shrink-0" />}
                  <Text variant="mono" as="span">{l.text}</Text>
                </li>
              ))}
            </ul>
          )}
          <Text variant="secondary" size="xs">
            测试网批量入金：为余额不足的钱包补充手续费和 USDT0，再授权并充值，全部在此标签页签名。重复充值会再次扣款，因此会跳过已入金的钱包。
          </Text>
        </LayerCard.Primary>
      </LayerCard>

      <ConfirmDialog
        open={confirm}
        title="批量入金（测试网链上交易）"
        body={<>从资金钱包（<strong className="font-medium text-kumo-default">{TREASURY_WALLET_ID}</strong>）为 <strong className="font-medium text-kumo-default">{targets.length}</strong> 个未入金钱包操作：每个钱包在余额不足时补充 <strong className="font-medium text-kumo-default">{gasEach} ETH</strong>、领取 <strong className="font-medium text-kumo-default">{mintEach} USDT0</strong>，然后充值 <strong className="font-medium text-kumo-default">{depositEach} USDT0</strong>。这是实际测试网交易，在此标签页签名。</>}
        danger={<>将操作 {targets.length} 个钱包的实际测试网资金。密钥保留在浏览器内。</>}
        onConfirm={() => { setConfirm(false); void run(); }}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}
