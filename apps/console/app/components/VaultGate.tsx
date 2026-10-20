"use client";

import { useState } from "react";
import { Banner, Input, LayerCard, LayerDialog, Loader, Text } from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import { createVault, unlockVault, resetVault } from "../lib/custody";
import type { VaultStatus } from "../lib/custody";
import { VaultBackupPanel } from "./VaultBackupPanel";
import { ChineseButton as Button } from "./ChineseButton";

/** The app entry gate (Waffet-style, status-driven): render EXACTLY ONE of loading / onboarding
 *  (no vault → set a password) / unlock (locked vault → enter the password) — nothing else, no
 *  wallets, until the vault is open. Kumo: a centered LayerCard holding a real <form> (Enter submits;
 *  a disabled submit blocks implicit submission, so Enter can't fire half-filled onboarding), labelled
 *  password Inputs and a primary submit Button. Only the unlock variant shows the danger Banner whose
 *  action opens a Kumo LayerDialog.Alert to erase the vault (the only escape — no password recovery). */
export function VaultGate({ status, onReady }: { status: VaultStatus | "loading"; onReady: () => void }) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);

  const onboarding = status === "absent";

  const submit = async () => {
    if (busy || restoreBusy) return;
    setErr(null);
    if (pw.length < 8) { setErr("密码至少需要 8 个字符。"); return; }
    if (onboarding && pw !== confirm) { setErr("两次输入的密码不一致。"); return; }
    setBusy(true);
    try {
      if (onboarding) await createVault(pw); else await unlockVault(pw);
      onReady();
    } catch {
      setErr(onboarding ? "创建保险库失败，请重试。" : "密码错误，无法解锁保险库。");
      setBusy(false);
    }
  };

  return (
    <div className="flex h-dvh justify-center overflow-y-auto px-4">
      <div className="my-auto flex w-full max-w-xl flex-col gap-4 py-6">
      <LayerCard className="flex w-full flex-col gap-4 p-5">
        <Text variant="heading" as="h1">Nado 交易台{status === "loading" ? "" : onboarding ? " · 创建保险库" : " · 解锁"}</Text>
        {status === "loading" ? (
          <div className="flex justify-center py-6"><Loader aria-label="正在加载" /></div>
        ) : (
          <>
            <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
              <fieldset className="flex flex-col gap-3" disabled={busy || restoreBusy}>
              <Text variant="secondary">
                {onboarding
                  ? "设置密码以加密保存在此浏览器中的钱包保险库。密码不会离开此浏览器，遗失后无法找回，请妥善保存。"
                  : "输入保险库密码，解锁账户和钱包。"}
              </Text>
              <Input
                type="password"
                label="保险库密码"
                placeholder="输入保险库密码"
                autoComplete={onboarding ? "new-password" : "current-password"}
                autoFocus
                value={pw}
                onChange={(e) => setPw(e.target.value)}
              />
              {onboarding && (
                <Input
                  type="password"
                  label="确认保险库密码"
                  placeholder="再次输入保险库密码"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              )}
              {err && <Text variant="error">{err}</Text>}
              <Button type="submit" variant="primary" loading={busy} disabled={busy || !pw || (onboarding && !confirm)}>
                {onboarding ? "创建保险库" : "解锁"}
              </Button>
              </fieldset>
            </form>

            {!onboarding && (
              <Banner
                variant="error"
                size="sm"
                icon={<WarningIcon weight="fill" />}
                title="忘记密码？"
                description="密码无法找回。你可以清除此浏览器的保险库，然后使用备份和原密码恢复，或重新创建。"
                action={<Banner.Action onClick={() => setConfirmReset(true)}>重置保险库</Banner.Action>}
              />
            )}
          </>
        )}
      </LayerCard>
      {onboarding && (
        <fieldset disabled={busy} className="contents">
          <VaultBackupPanel mode="restore" onRestored={onReady} onBusyChange={setRestoreBusy} />
        </fieldset>
      )}
      </div>

      <LayerDialog.Alert open={confirmReset} onOpenChange={setConfirmReset}>
        <LayerDialog.Content size="sm">
          <LayerDialog.Title>清除此保险库？</LayerDialog.Title>
          <LayerDialog.Body>
            <Text variant="secondary">
              此操作会永久删除本地保险库及其中的钱包和密钥。只有持有加密备份及原密码、原始私钥或助记词，才能恢复对应钱包。请确认已保存可用备份。
            </Text>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel="取消">
            <LayerDialog.Actions.Primary
              variant="destructive"
              disabled={resetting}
              aria-busy={resetting || undefined}
              onClick={async () => { setResetting(true); await resetVault(); window.location.reload(); }}
            >
              <span className="inline-flex items-center gap-1.5">{resetting && <Loader size={14} aria-label="正在加载" />}清除并重新开始</span>
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </div>
  );
}
