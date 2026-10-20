"use client";

import { useState } from "react";
import { Banner, Button, Input, InputArea, LayerCard, LinkButton, Text } from "@cloudflare/kumo";
import { KeyIcon, LockIcon, XCircleIcon } from "@phosphor-icons/react";
import { generateCohort, importCohort, importCohortByPrivateKeys, cohortWallets, isUnlocked, lockCohort } from "../lib/custody";
import type { CohortWallet } from "../lib/custody";
import { verifyInTabSigning } from "../lib/liveClient";
import type { InTabProduct } from "../lib/liveClient";
import { resetLiveContexts } from "../lib/liveContext";
import { zhError } from "../lib/zh";
import { ChineseButton } from "./ChineseButton";

/** Custody graduation UI (Stage 2b): generate/import/unlock an IN-TAB cohort (keys live in
 *  this browser), after which the live fleet, order signing, FUNDING, and reads ALL run in
 *  the tab — orders/withdraw via the keyless relay, deposit broadcast straight to the Ink
 *  RPC by a keyless ChainClient. The server holds no key. "Import funded (dev)" pulls the
 *  disposable testnet seed so the in-tab cohort is the already-funded one for verification. */
export function CustodyPanel({ cohortSize, product, onCohortChange, isTestnet }: { cohortSize?: number; product?: InTabProduct; onCohortChange?: () => void; isTestnet?: boolean }) {
  const [password, setPassword] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [privKeys, setPrivKeys] = useState("");
  const [wallets, setWallets] = useState<CohortWallet[]>(cohortWallets());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const n = Math.max(1, cohortSize ?? 3);
  const unlocked = wallets.length > 0 && isUnlocked();

  const run = async (fn: () => Promise<CohortWallet[]>, label: string) => {
    setBusy(true); setMsg(null);
    try {
      const ws = await fn();
      resetLiveContexts();
      setWallets(ws); setMsg(`✓ ${label}：当前标签页共 ${ws.length} 个钱包`);
      onCohortChange?.();
    } catch (e) { setMsg(`✗ ${zhError(e)}`); }
    finally { setBusy(false); }
  };

  // DEV: fetch the funded disposable seed over localhost and import it (the mnemonic is
  // consumed straight into custody — never rendered, never stored in component state).
  const importFundedDev = () => run(async () => {
    const r = await fetch("/api/nado/dev-seed", { cache: "no-store" }).then((x) => x.json()) as { mnemonic?: string; error?: string };
    if (r.error || !r.mnemonic) throw new Error(r.error ?? "no seed returned");
    return importCohort(r.mnemonic, n, password);
  }, "已导入已入金的测试钱包（开发用）");

  const verify = async () => {
    if (!product) { setMsg("✗ 暂无可用于签名验证的在线交易市场"); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await verifyInTabSigning(wallets[0]?.walletId ?? "live:0", product);
      setMsg(r.match ? `✓ 浏览器内签名与地址恢复验证通过（${r.address.slice(0, 10)}…）` : "✗ 签名恢复地址不一致");
    } catch (e) { setMsg(`✗ ${zhError(e)}`); }
    finally { setBusy(false); }
  };

  // A Kumo LayerCard: the Secondary header keeps the literal "In-browser custody · <state>" run (the
  // e2e helpers wait on it). Feedback stays INLINE (a portaled Toast would leave the <aside> the specs
  // scope to). Passwords use Input type="password" — Kumo's SensitiveInput reveals while typing and
  // always offers a clipboard Copy, which this keys-off-the-clipboard custody model must not.
  // shrink-0: an overflow-hidden flex item in the fixed-height sidebar would otherwise shrink and clip
  // its own controls (unclickable) instead of letting the sidebar scroll.
  return (
    <LayerCard className="shrink-0">
      <LayerCard.Secondary>浏览器内密钥保管 · {unlocked ? "已解锁" : "已锁定"}</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-3">
        {!unlocked ? (
          <>
            <Input type="password" size="sm" aria-label="保险库密码" placeholder="输入保险库密码" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <InputArea size="sm" aria-label="助记词（可选）" placeholder="可选：输入助记词以导入；留空则在浏览器内新建钱包" rows={2} spellCheck={false} autoComplete="off" value={mnemonic} onChange={(e) => setMnemonic(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" size="sm" disabled={busy || !password} onClick={() => (mnemonic.trim() ? run(() => importCohort(mnemonic, n, password), "已导入") : run(() => generateCohort(n, password), "已生成"))}>
                {mnemonic.trim() ? "导入并解锁" : `在浏览器内生成 ${n} 个钱包`}
              </Button>
            </div>
            <InputArea size="sm" aria-label="私钥" placeholder="或粘贴私钥：每行一个以 0x 开头的 EVM 私钥（创建 PK 钱包）" rows={2} spellCheck={false} autoComplete="off" value={privKeys} onChange={(e) => setPrivKeys(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={KeyIcon} disabled={busy || !password || !privKeys.trim()} onClick={() => run(() => importCohortByPrivateKeys(privKeys.split(/[\s,]+/), password), "已导入私钥")}>导入私钥</Button>
              {/* The dev seed is the funded disposable TESTNET cohort — meaningless on mainnet (its
                  route 403s there), so hide the button off testnet. */}
              {isTestnet && <Button size="sm" variant="ghost" disabled={busy || !password} onClick={importFundedDev}>导入已入金的测试钱包（开发用）</Button>}
            </div>
          </>
        ) : (
          <>
            <ul className="flex flex-col gap-0.5">
              {wallets.slice(0, 5).map((w) => (
                <li key={w.walletId}><Text variant="mono-secondary" as="span">{w.walletId} · {w.address.slice(0, 10)}…{w.address.slice(-6)}</Text></li>
              ))}
            </ul>
            {wallets.length > 5 && <Text variant="secondary" size="xs">另有 {wallets.length - 5} 个钱包，可在账户页管理或钱包列表查看。</Text>}
            <LinkButton size="sm" href="/accounts">管理账户</LinkButton>
            <div className="flex flex-wrap gap-2">
              <ChineseButton size="sm" loading={busy} onClick={verify}>验证浏览器内签名</ChineseButton>
              <Button size="sm" icon={LockIcon} disabled={busy} onClick={() => { lockCohort(); resetLiveContexts(); setWallets([]); setMsg("已锁定"); onCohortChange?.(); }}>锁定</Button>
            </div>
          </>
        )}
        {msg && (msg.startsWith("✗")
          ? <Banner variant="error" size="sm" icon={<XCircleIcon weight="fill" />} description={msg} />
          : <span className={msg.startsWith("✓") ? "text-kumo-success" : "text-kumo-subtle"}>{msg}</span>)}
        <Text variant="secondary" size="xs">
          密钥在此浏览器内生成、导入和签名，加密保存在本地。订单、充值和提现均由浏览器签名；服务器只转发请求，不持有密钥。
        </Text>
      </LayerCard.Primary>
    </LayerCard>
  );
}
