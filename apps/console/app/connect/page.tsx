"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Input, LinkButton } from "@cloudflare/kumo";
import { LockIcon, WalletIcon } from "@phosphor-icons/react";
import { ChineseButton as Button } from "../components/ChineseButton";
import { useVault } from "../components/AppGate";
import { cohortWallets } from "../lib/custody";
import { bulk } from "../lib/bulk";
import type { BridgeSnapshot, NadoBridge } from "../lib/walletConnectBridge";

const PROJECT_KEY = "nado-walletconnect-project-id";
const statuses: Record<BridgeSnapshot["status"], string> = {
  idle: "尚未连接", connecting: "正在等待官网连接请求", proposal: "请确认网站连接",
  connected: "钱包已连接，等待官网请求", preparing: "正在核对交易与手续费",
  request: "有请求等待你确认", executing: "正在处理已确认的请求",
  disconnected: "已断开连接", error: "连接未完成",
};
const methodLabels: Record<string, string> = {
  personal_sign: "登录消息签名", eth_signTypedData_v4: "结构化操作签名",
  eth_sendTransaction: "发送链上交易", wallet_switchEthereumChain: "确认 Ink 网络",
  eth_accounts: "读取当前地址", eth_requestAccounts: "读取当前地址",
  eth_chainId: "读取当前网络", net_version: "读取网络编号",
};

export default function ConnectPage() {
  const { relock } = useVault();
  const wallets = useMemo(() => cohortWallets(), []);
  // The portable registration plan starts at wallet 10,000 and walks downward.
  const [number, setNumber] = useState(() => String(Math.min(10_000, wallets.length || 1)));
  const index = Number(number) - 1;
  const wallet = Number.isInteger(index) && index >= 0 ? wallets[index] : undefined;
  const [projectId, setProjectId] = useState(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "");
  const [uri, setUri] = useState("");
  const [state, setState] = useState<BridgeSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledgedRequestId, setAcknowledgedRequestId] = useState<number | null>(null);
  const [username, setUsername] = useState(() => `ybtl${number}`);
  const [authorizedUsername, setAuthorizedUsername] = useState<string | null>(null);
  const usernameIntent = useRef<string | null>(null);
  const previousUsernameAuthorization = useRef<string | null>(null);
  const bridge = useRef<NadoBridge | null>(null);
  const connectionAbort = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const active = Boolean(bridge.current) || busy;
  const validProjectId = /^[a-f0-9]{32}$/i.test(projectId.trim());
  const validUsername = /^[A-Za-z0-9_.]{3,20}$/.test(username);
  const working = busy || state?.status === "executing" || state?.status === "preparing";

  useEffect(() => {
    try { const saved = localStorage.getItem(PROJECT_KEY); if (saved) setProjectId(saved); } catch { /* optional setting */ }
    // This page owns one interactive wallet. Stop the separate bulk runner before connecting.
    bulk.halt();
    return () => {
      generation.current++;
      connectionAbort.current?.abort();
      const old = bridge.current;
      bridge.current = null;
      void old?.dispose();
    };
  }, []);

  useEffect(() => { setAcknowledgedRequestId(null); }, [state?.request]);

  useEffect(() => {
    usernameIntent.current = null;
    previousUsernameAuthorization.current = null;
    setAuthorizedUsername(null);
    setUsername(Number.isInteger(index) && index >= 0 ? `ybtl${index + 1}` : "");
  }, [index]);

  const changeUsernameAuthorization = (enabled: boolean) => {
    if (enabled && (!wallet || !validUsername || working || state?.status === "disconnected")) return;
    const next = enabled ? username : null;
    usernameIntent.current = next;
    setAuthorizedUsername(next);
    setError(null);
    try { bridge.current?.setUsernameAuthorization(next); }
    catch {
      usernameIntent.current = null;
      setAuthorizedUsername(null);
      setError("无法设置本次用户名签名授权，请检查连接状态后重试。");
    }
  };

  const connect = async () => {
    if (!wallet || !validProjectId || !uri.trim() || active) return;
    const attempt = ++generation.current;
    const controller = new AbortController();
    connectionAbort.current = controller;
    const pairingUri = uri.trim();
    setUri(""); setError(null); setBusy(true); setState(null);
    try {
      const { createNadoBridge } = await import("../lib/walletConnectBridge");
      if (attempt !== generation.current) return;
      const created = await createNadoBridge({
        projectId: projectId.trim(),
        signal: controller.signal,
        wallet: { walletId: wallet.walletId, address: wallet.address },
        onChange: (snapshot) => {
          if (attempt !== generation.current) return;
          // Initialization publishes null before the bridge can receive the user's intent.
          const consumed = previousUsernameAuthorization.current !== null && snapshot.usernameAuthorization === null;
          previousUsernameAuthorization.current = snapshot.usernameAuthorization;
          if (consumed || snapshot.status === "disconnected") {
            usernameIntent.current = null;
            setAuthorizedUsername(null);
          }
          setState(snapshot);
        },
      });
      if (attempt !== generation.current) { await created.dispose(); return; }
      bridge.current = created;
      created.setUsernameAuthorization(usernameIntent.current);
      try { localStorage.setItem(PROJECT_KEY, projectId.trim()); } catch { /* optional setting */ }
      await created.pair(pairingUri);
    } catch {
      if (attempt === generation.current) {
        usernameIntent.current = null;
        previousUsernameAuthorization.current = null;
        setAuthorizedUsername(null);
        setError("连接失败。请检查网络、Project ID，并从 Nado 重新复制连接码。");
      }
    } finally {
      if (attempt === generation.current) setBusy(false);
    }
  };

  const action = async (method: "approveProposal" | "rejectProposal" | "approveRequest" | "rejectRequest") => {
    const current = bridge.current;
    if (!current || working) return;
    const reviewedRequestId = state?.request?.id;
    if (method === "approveRequest" && reviewedRequestId === undefined) return;
    setError(null); setBusy(true); setAcknowledgedRequestId(null);
    const attempt = generation.current;
    try {
      if (method === "approveRequest") await current.approveRequest(reviewedRequestId!);
      else await current[method]();
    }
    catch { if (attempt === generation.current) setError("请求未完成，请查看连接状态，并在官网核对结果后再操作。"); }
    finally { if (attempt === generation.current) setBusy(false); }
  };

  const disconnect = async () => {
    generation.current++;
    usernameIntent.current = null;
    previousUsernameAuthorization.current = null;
    setAuthorizedUsername(null);
    connectionAbort.current?.abort();
    connectionAbort.current = null;
    const old = bridge.current;
    bridge.current = null;
    setBusy(true); setError(null); setState(null); setUri(""); setAcknowledgedRequestId(null);
    try { await old?.dispose(); }
    finally { setBusy(false); }
  };

  const request = state?.request;
  const exportWalletManifest = () => {
    const manifest = wallets.map((item, offset) => ({ walletNumber: offset + 1, address: item.address }));
    const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2) + "\n"], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "wallet-manifest.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const acknowledged = request !== null && request !== undefined && acknowledgedRequestId === request.id;
  const permission = request?.kind === "transaction" || request?.kind === "typedData";
  const panel = "rounded-xl border border-kumo-line bg-kumo-base p-5 space-y-4";
  return (
    <div className="min-h-dvh bg-kumo-elevated text-kumo-default">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-kumo-line bg-kumo-base px-4 py-3">
        <nav aria-label="页面导航" className="flex items-center gap-2 text-sm">
          <LinkButton href="/" variant="ghost" icon={WalletIcon}>钱包</LinkButton>
          <LinkButton href="/accounts" variant="ghost">账户与备份</LinkButton>
          <span aria-current="page">连接 Nado 官网</span>
        </nav>
        <Button icon={LockIcon} onClick={relock}>锁定保险库</Button>
      </header>
      <main className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">连接 Nado 官网</h1>
          <p className="text-sm text-kumo-subtle">使用保险库中的独立钱包登录官网，并在本页确认后续交易请求。每次连接只提供当前一个地址。</p>
          <Badge variant="secondary">Ink 主网 · 链编号 57073</Badge>
          <p className="text-sm text-kumo-subtle">此入口固定使用 Ink 主网，独立于钱包总览的测试网设置。保持本页打开；离开、刷新或锁定后需要重新连接。</p>
        </div>

        <section className={panel} aria-labelledby="choose-wallet">
          <h2 id="choose-wallet" className="text-lg font-semibold">1. 选择独立钱包</h2>
          <p>保险库共有 {wallets.length.toLocaleString("zh-CN")} 个钱包</p>
          <Button disabled={!wallets.length} onClick={exportWalletManifest}>导出编号与地址清单</Button>
          <p className="text-sm text-kumo-subtle">用于跨设备核对钱包编号与断点续跑，文件仅含编号和地址，不能用于恢复钱包。钱包恢复请使用“账户与备份”中的加密备份。</p>
          <div className="flex flex-wrap items-end gap-3">
            <Input label="钱包编号（从 1 开始）" type="number" min={1} max={Math.max(1, wallets.length)} value={number}
              onChange={(event) => setNumber(event.target.value)} disabled={active || !wallets.length} className="w-52" />
            <Button disabled={active || !wallet || index <= 0} onClick={() => setNumber(String(index))}>上一个钱包</Button>
            <Button disabled={active || !wallet || index >= wallets.length - 1} onClick={() => setNumber(String(index + 2))}>下一个钱包</Button>
          </div>
          {wallet ? <div className="space-y-2 text-sm">
            <p>所属账户：{wallet.accountName}</p>
            <p className="break-all rounded-lg bg-kumo-elevated p-3 font-mono" data-testid="connect-wallet-address">{wallet.address}</p>
          </div> : <p role="status">{wallets.length ? "请输入有效的钱包编号。" : "请先到“账户与备份”创建或恢复钱包。"}</p>}
          {active && <p className="text-sm text-kumo-subtle">当前连接已绑定此地址。更换钱包前，请先断开本页及 Nado 官网的连接。</p>}
          <div className="space-y-3 border-t border-kumo-line pt-4">
            <Input label="本次官网用户名" value={username} onChange={(event) => setUsername(event.target.value)}
              disabled={authorizedUsername !== null || !wallet || state?.status === "executing"} maxLength={20}
              autoComplete="off" spellCheck={false} placeholder="例如 ybtl1" />
            <p className="text-sm text-kumo-subtle">默认使用 ybtl 加钱包编号。若官网提示已占用，可关闭授权后填写备用名，并在官网输入相同用户名。</p>
            {!validUsername && <p role="status" className="text-sm">用户名须为 3–20 位英文字母、数字、下划线或英文句点。</p>}
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={authorizedUsername !== null}
                disabled={authorizedUsername === null && (!wallet || !validUsername || working || state?.status === "disconnected")}
                onChange={(event) => changeUsernameAuthorization(event.target.checked)} className="mt-1" />
              <span>自动确认一次此用户名签名</span>
            </label>
            {authorizedUsername !== null && <p role="status" className="text-sm" data-testid="connect-username-authorization">
              本次仅允许把当前钱包用户名设为 {authorizedUsername}，完成一次即关闭。取消勾选可撤销尚未使用的授权。
            </p>}
            <p className="text-sm text-kumo-subtle">此授权仅限当前连接的钱包和指定用户名，不会自动填写官网表单。交易及其他签名仍需手动确认；条款须在官网确认。断开连接、更换钱包或刷新后，需重新勾选。</p>
          </div>
        </section>

        <section className={panel} aria-labelledby="pairing">
          <h2 id="pairing" className="text-lg font-semibold">2. 从 Nado 发起连接</h2>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>打开 <a className="underline" href="https://app.nado.xyz/perpetuals?market=BTC" target="_blank" rel="noopener noreferrer">Nado 官网</a>，在官网退出上一个钱包连接，然后选择“Sign In（登录）”→“WalletConnect”。</li>
            <li>在二维码窗口复制连接码（以 wc: 开头），粘贴到下方。连接码只在本次配对时使用。</li>
            <li>确认本页的网站来源与完整钱包地址，批准连接；后续请求逐次确认，已明确开启的一次用户名签名授权除外。</li>
          </ol>
          <details>
            <summary className="cursor-pointer text-sm">WalletConnect 项目配置{validProjectId ? "（已填写）" : "（需要填写）"}</summary>
            <div className="mt-3 space-y-2">
              <Input label="Project ID" value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={active} autoComplete="off" spellCheck={false} />
              <p className="text-sm text-kumo-subtle">公开项目编号，用于连接中继。可在 <a href="https://dashboard.walletconnect.com" target="_blank" rel="noopener noreferrer" className="underline">WalletConnect 控制台</a>创建。这里不需要助记词或私钥。</p>
            </div>
          </details>
          {!validProjectId && <p role="status" className="text-sm">请填写自己的 32 位 Project ID 后连接。</p>}
          <Input label="WalletConnect 连接码" type="password" value={uri} onChange={(event) => setUri(event.target.value)}
            disabled={active} autoComplete="off" placeholder="粘贴以 wc: 开头的连接码" />
          <div className="flex flex-wrap gap-3">
            <Button variant="primary" loading={busy && !state?.request && !state?.proposal} disabled={!wallet || !validProjectId || !uri.trim() || active} onClick={() => void connect()}>接收官网连接请求</Button>
            <Button disabled={!active} onClick={() => void disconnect()}>断开连接</Button>
          </div>
          <p role="status" data-testid="connect-status">{state ? statuses[state.status] : "尚未连接"}</p>
          {(error || state?.error) && <p role="alert" className="break-words text-sm text-red-700">{error ?? state?.error}</p>}
          {state?.outcome && <div className="space-y-2 rounded-lg border border-kumo-line p-3 text-sm">
            <p>{state.outcome.title}</p>
            {state.outcome.transactionHash && <p className="break-all font-mono">交易哈希：{state.outcome.transactionHash}</p>}
            <p>{state.outcome.transactionHash
              ? "请先核对链上结果；交易已发送时不要重复提交。"
              : "请在官网核对用户名处理结果；签名完成不代表用户名已注册成功。"}</p>
          </div>}
        </section>

        {state?.proposal && <section className={panel} aria-labelledby="proposal-title">
          <h2 id="proposal-title" className="text-lg font-semibold">确认连接请求</h2>
          <p>已核验的网站来源：<strong>{state.proposal.url}</strong></p>
          <p className="break-all font-mono text-sm">钱包：{state.proposal.address}</p>
          <p>网络：Ink 主网（57073）</p>
          <p className="text-sm">网站可请求以下操作；除已明确开启的一次用户名签名授权外，每次签名与发送仍需你确认：</p>
          <ul className="list-disc pl-5 text-sm">{state.proposal.methods.map((method) => <li key={method}>{methodLabels[method] ?? method}</li>)}</ul>
          <div className="flex gap-3">
            <Button variant="primary" loading={busy} onClick={() => void action("approveProposal")}>同意连接此钱包</Button>
            <Button disabled={working} onClick={() => void action("rejectProposal")}>拒绝连接</Button>
          </div>
        </section>}

        {request && <section className={panel} aria-labelledby="request-title">
          <h2 id="request-title" className="text-lg font-semibold">{request.title}</h2>
          <p className="break-all font-mono text-sm">当前钱包：{state?.wallet.address}</p>
          <p>Ink 主网（57073） · 来源：https://app.nado.xyz</p>
          {request.caution && <p className="rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950">{request.caution}</p>}
          <div className="max-h-96 overflow-auto rounded-lg bg-kumo-elevated p-3 text-sm">
            {(Array.isArray(request.details) ? request.details : [request.details]).map((line, i) => <pre key={i} className="whitespace-pre-wrap break-all font-mono">{line}</pre>)}
          </div>
          {permission && <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={acknowledged} disabled={working} onChange={(event) => setAcknowledgedRequestId(event.target.checked ? request.id : null)} className="mt-1" />
            <span>我已核对钱包、接收方、金额和权限范围，确认执行本次请求。授权签名可能允许后续交易，无需每次再次弹窗。</span>
          </label>}
          <div className="flex gap-3">
            <Button variant="primary" loading={working} disabled={permission && !acknowledged} onClick={() => void action("approveRequest")}>
              {request.kind === "transaction" ? "确认签名并发送交易" : request.kind === "read" || request.kind === "switchChain" ? "确认本次请求" : "确认本次签名"}
            </Button>
            <Button disabled={working} onClick={() => void action("rejectRequest")}>拒绝本次请求</Button>
          </div>
        </section>}

        <section className={panel}>
          <h2 className="text-lg font-semibold">3. 在官网核对结果</h2>
          <p className="text-sm">官网显示的完整地址应与本页一致，网络应为 Ink。连接成功或签名成功，并不代表已充值、已开通交易，也不代表其余钱包已登录。</p>
          <p className="text-sm">“一键交易”通常会要求签署 LinkSigner 委托，属于持续交易权限。请核对被授权地址及官网说明；断开 WalletConnect 不会撤销已生效的链上额度或交易委托。</p>
          <p className="text-sm text-kumo-subtle">此页不会自动充值、下单或批量授权。官网发来的链上交易会先查询 Ink RPC 并模拟，显示费用后等待确认。单笔原生币金额上限 0.005 ETH，gas 预算上限 0.01 ETH（不含可能另收的 L1 数据费）；这些限额不限制代币额度授权或委托签名的权限。</p>
        </section>
      </main>
    </div>
  );
}
