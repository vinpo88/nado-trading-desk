"use client";

import { useEffect, useState } from "react";
import { Badge, Banner, ButtonGroup, Empty, Grid, Input, InputArea, LayerCard, LinkButton, Text } from "@cloudflare/kumo";
import { DownloadSimpleIcon, KeyIcon, LockIcon, PencilSimpleIcon, PlusIcon, TrashIcon, UsersThreeIcon, WalletIcon, WarningCircleIcon } from "@phosphor-icons/react";
import {
  listAccounts, createHdAccount, createPkAccount, deriveMore, importKeys, renameAccount, dropAccount, accountAddresses,
} from "../lib/custody";
import type { AccountVM, AccountKind } from "../lib/custody";
import { QrKeyScanner } from "../components/QrKeyScanner";
import { useVault } from "../components/AppGate";
import { VaultBackupPanel } from "../components/VaultBackupPanel";
import { ChineseButton as Button } from "../components/ChineseButton";

const splitKeys = (s: string): string[] => s.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean);

/** The dedicated Accounts page, in Kumo's page pattern: a Breadcrumbs header bar (client-routed via
 *  LinkProvider, so the vault stays unlocked), a heading, ONE create form (no wizard) in a LayerCard,
 *  and one LayerCard per account (header strip = identity + actions; body = derive / import). It is NOT
 *  an account→wallet cascade — the home page filters accounts and shows their wallets. Behind the gate. */
export default function AccountsPage() {
  const { relock } = useVault();
  const [accounts, setAccounts] = useState<AccountVM[]>([]);
  const [backupBusy, setBackupBusy] = useState(false);
  // session is populated by the gate before this renders; refresh on mount (and after every op).
  useEffect(() => { setAccounts(listAccounts()); }, []);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-4 border-b border-kumo-line bg-kumo-base px-4 py-3">
        <nav aria-label="页面导航" className="flex items-center gap-2 text-sm">
          <LinkButton href="/" variant="ghost" size="sm" icon={WalletIcon}>钱包</LinkButton>
          <span aria-hidden="true">/</span>
          <span aria-current="page">账户</span>
          <LinkButton href="/connect" variant="secondary" size="sm">连接 Nado 官网</LinkButton>
        </nav>
        <Button icon={LockIcon} disabled={backupBusy} onClick={relock}>锁定保险库</Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
          <div className="flex flex-col gap-1">
            <Text variant="heading" size="lg" as="h1">账户</Text>
            <Text variant="secondary">此保险库中有 {accounts.length} 个账户</Text>
          </div>

          <VaultBackupPanel mode="manage" onBusyChange={setBackupBusy} />

          <fieldset disabled={backupBusy} className="contents">
          <CreateAccountForm onCreated={setAccounts} />

          <div className="flex flex-col gap-3">
            <Text variant="heading" as="h2">我的账户</Text>
            {accounts.length === 0 ? (
              <LayerCard className="p-0">
                <Empty
                  size="sm"
                  icon={<UsersThreeIcon size={32} className="text-kumo-inactive" />}
                  title="暂无账户"
                  description="请在上方创建助记词账户（HD）或私钥账户（PK）。"
                />
              </LayerCard>
            ) : (
              accounts.map((a) => <AccountBlock key={a.slug} account={a} onChange={setAccounts} />)
            )}
          </div>
          </fieldset>
        </div>
      </div>
    </div>
  );
}

/** ONE form, all fields visible (no wizard): pick HD or PK, then fill the kind's fields. */
function CreateAccountForm({ onCreated }: { onCreated: (accounts: AccountVM[]) => void }) {
  const [kind, setKind] = useState<AccountKind>("HD");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [count, setCount] = useState(1);
  const [privKeys, setPrivKeys] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const canSubmit = !busy && name.trim().length > 0 && password.length > 0
    && (kind === "HD" ? count >= 1 : splitKeys(privKeys).length > 0);

  const submit = async () => {
    setBusy(true); setMsg(null);
    try {
      const accounts = kind === "HD"
        ? await createHdAccount(name.trim(), password, mnemonic.trim() || undefined, count)
        : await createPkAccount(name.trim(), password, splitKeys(privKeys));
      onCreated(accounts);
      setMsg(`✓ 已创建${kind === "HD" ? "助记词" : "私钥"}账户“${name.trim()}”`);
      setName(""); setPassword(""); setMnemonic(""); setPrivKeys(""); setCount(1);
    } catch { setMsg("✗ 创建账户失败，请检查保险库密码、账户名称和导入内容。"); }
    finally { setBusy(false); }
  };

  return (
    <LayerCard>
      <LayerCard.Secondary>创建账户</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-4">
        {/* kind toggle — the app-wide single-select idiom (selected = network brand) */}
        <ButtonGroup aria-label="账户类型">
          {(["HD", "PK"] as const).map((k) => (
            <Button key={k} size="sm" variant={kind === k ? "primary" : "secondary"} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {k === "HD" ? "HD（派生钱包）" : "PK（导入私钥）"}
            </Button>
          ))}
        </ButtonGroup>

        <Grid variant="2up" gap="sm">
          <Input label="账户名称" placeholder="例如：批量钱包" passwordManagerIgnore value={name} onChange={(e) => setName(e.target.value)} />
          <Input type="password" label="保险库密码" placeholder="输入保险库密码" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Grid>

        {kind === "HD" ? (
          <div className="flex flex-col gap-3">
            <InputArea
              label="助记词"
              description="选填，留空将在此浏览器标签页中生成新助记词。"
              placeholder="按顺序输入助记词，以空格分隔；留空则自动生成"
              rows={2}
              spellCheck={false}
              autoComplete="off"
              value={mnemonic}
              onChange={(e) => setMnemonic(e.target.value)}
            />
            <Input
              type="number"
              min={1}
              label="派生钱包数量"
              className="w-40"
              value={count}
              onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <InputArea
              label="私钥"
              description="每行输入一个以 0x 开头的 EVM 私钥，每个私钥对应一个钱包。"
              placeholder="0x…，每行一个私钥"
              rows={3}
              spellCheck={false}
              autoComplete="off"
              value={privKeys}
              onChange={(e) => setPrivKeys(e.target.value)}
            />
            <QrKeyScanner onKey={(k) => setPrivKeys((p) => (p.trim() ? `${p.trim()}\n` : "") + k)} />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" loading={busy} disabled={!canSubmit} onClick={submit}>创建账户</Button>
          {msg && (msg.startsWith("✗")
            ? <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} description={msg} />
            : <span className="text-kumo-success">{msg}</span>)}
        </div>
        <Text variant="secondary" size="xs">
          密钥在此浏览器中生成、导入和签名，加密保存在本地，始终不会发送至服务器。保险库密码用于加密新账户。
        </Text>
      </LayerCard.Primary>
    </LayerCard>
  );
}

/** One account: a LayerCard whose header strip holds identity + manage actions (export, rename, drop)
 *  and whose body holds the kind-specific management (derive more / import keys). */
function AccountBlock({ account, onChange }: { account: AccountVM; onChange: (accounts: AccountVM[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [deriveN, setDeriveN] = useState(1);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(account.name);
  const [importing, setImporting] = useState(false);
  const [keys, setKeys] = useState("");
  const [confirmDrop, setConfirmDrop] = useState(false);

  const run = async (fn: () => Promise<AccountVM[]>, after?: () => void) => {
    setBusy(true); setMsg(null);
    try { onChange(await fn()); after?.(); }
    catch { setMsg("✗ 操作失败，请检查输入后重试。"); }
    finally { setBusy(false); }
  };

  // Download a .txt of THIS account's wallet addresses — one per line, no index, addresses only.
  const exportAddresses = () => {
    const text = accountAddresses(account.slug).join("\n");
    const blob = new Blob([text ? `${text}\n` : ""], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${account.name.replace(/[^a-zA-Z0-9._-]+/g, "-") || account.slug}-addresses.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <LayerCard data-testid="account-block">
      <LayerCard.Secondary className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {renaming ? (
            <>
              {/* The ONLY textbox in the block while renaming (the e2e addresses it that way). */}
              <Input size="sm" aria-label="账户名称" className="w-48" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} />
              <Button size="sm" variant="primary" loading={busy} disabled={busy || !newName.trim()} onClick={() => run(() => renameAccount(account.slug, newName), () => setRenaming(false))}>保存</Button>
              <Button size="sm" variant="ghost" onClick={() => { setRenaming(false); setNewName(account.name); }}>取消</Button>
            </>
          ) : (
            <>
              <Text bold as="span">{account.name}</Text>
              <Badge variant="secondary">{account.kind === "HD" ? "助记词账户（HD）" : "私钥账户（PK）"}</Badge>
              <Text variant="secondary" size="xs" as="span">{account.walletCount} 个钱包</Text>
            </>
          )}
        </div>
        {!renaming && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon={DownloadSimpleIcon} disabled={busy || account.walletCount === 0} onClick={exportAddresses}>导出地址</Button>
            <Button size="sm" icon={PencilSimpleIcon} disabled={busy} onClick={() => setRenaming(true)}>重命名</Button>
            {confirmDrop ? (
              <>
                <Button size="sm" variant="destructive" loading={busy} onClick={() => run(() => dropAccount(account.slug))}>确认删除</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDrop(false)}>取消</Button>
              </>
            ) : (
              <Button size="sm" variant="secondary-destructive" icon={TrashIcon} disabled={busy} onClick={() => setConfirmDrop(true)}>删除</Button>
            )}
          </div>
        )}
      </LayerCard.Secondary>

      <LayerCard.Primary className="flex flex-col gap-2">
        {account.kind === "HD" ? (
          <div className="flex items-center gap-2">
            <Input type="number" min={1} size="sm" aria-label="追加钱包数量" className="w-20" value={deriveN} onChange={(e) => setDeriveN(Math.max(1, Number(e.target.value) || 1))} />
            <Button size="sm" icon={PlusIcon} loading={busy} onClick={() => run(() => deriveMore(account.slug, deriveN))}>追加派生钱包</Button>
          </div>
        ) : importing ? (
          <div className="flex flex-col gap-2">
            <InputArea size="sm" aria-label="待导入的私钥" placeholder="0x…，每行一个私钥" rows={2} spellCheck={false} autoComplete="off" value={keys} onChange={(e) => setKeys(e.target.value)} />
            <QrKeyScanner onKey={(k) => setKeys((p) => (p.trim() ? `${p.trim()}\n` : "") + k)} />
            <div className="flex gap-2">
              <Button size="sm" variant="primary" disabled={busy || splitKeys(keys).length === 0} onClick={() => run(() => importKeys(account.slug, splitKeys(keys)), () => { setImporting(false); setKeys(""); })}>导入</Button>
              <Button size="sm" variant="ghost" onClick={() => { setImporting(false); setKeys(""); }}>取消</Button>
            </div>
          </div>
        ) : (
          <div><Button size="sm" icon={KeyIcon} disabled={busy} onClick={() => setImporting(true)}>导入私钥</Button></div>
        )}
        {msg && <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} description={msg} />}
      </LayerCard.Primary>
    </LayerCard>
  );
}
