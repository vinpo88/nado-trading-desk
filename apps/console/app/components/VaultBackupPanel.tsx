"use client";

import { useRef, useState } from "react";
import { Button, Input, LayerCard, Text } from "@cloudflare/kumo";
import { backupErrorMessage, exportVaultBackup, restoreVaultBackup, verifyVaultBackup } from "../lib/vaultBackup";
import type { BackupReport } from "../lib/vaultBackup";

const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
type BackupAction = "export" | "verify" | "restore";

function downloadBackup(json: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  try {
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    // Give the browser time to start saving before releasing the in-memory file.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function verifiedMessage(report: BackupReport): string {
  const counts = `${report.accountCount} 个账户、${report.walletCount} 个钱包，${report.signaturesVerified} 个签名验证通过。`;
  const hd = typeof report.hdWalletsVerified === "number" ? `已核验 ${report.hdWalletsVerified} 个助记词派生钱包（HD）。` : "";
  return `验证通过：${counts}全部钱包地址已与当前保险库逐一核对，一致。${hd}`;
}

/** Files and passwords are handled only in this browser; file contents are read on demand. */
export function VaultBackupPanel({ mode, onRestored, onBusyChange }: {
  mode: "manage" | "restore";
  onRestored?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [password, setPassword] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [report, setReport] = useState<BackupReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const restoring = mode === "restore";

  const clearFeedback = () => {
    setMessage(null);
    setReport(null);
    setError(null);
    setProgress("");
  };

  const run = async (action: BackupAction) => {
    if (busy || password.length === 0 || (action !== "export" && !file)) return;
    setBusy(true);
    onBusyChange?.(true);
    clearFeedback();
    setProgress("正在处理加密备份，请保持页面打开。");
    let restored = false;
    try {
      if (action === "export") {
        const backup = await exportVaultBackup(password, setProgress);
        downloadBackup(backup.json, backup.filename);
        setMessage("备份已生成并通过临时恢复检查，请保存文件后再选取文件验证。");
      } else {
        // File content stays in this operation's scope and is never put in React state.
        const json = await file!.text();
        if (action === "verify") {
          const result = await verifyVaultBackup(json, password, setProgress);
          if (!result.matchesCurrentVault) throw new Error("Backup does not match the current vault");
          setReport(result);
          setMessage(verifiedMessage(result));
        } else {
          const result = await restoreVaultBackup(json, password, setProgress);
          setReport(result);
          setMessage(`恢复完成：${result.accountCount} 个账户、${result.walletCount} 个钱包，${result.signaturesVerified} 个签名验证通过。`);
          restored = true;
        }
      }
      setPassword("");
    } catch (error) {
      // Never render arbitrary file content, passwords or underlying crypto errors.
      setError(backupErrorMessage(error) ?? (action === "export"
        ? "备份未完成，请检查保险库密码后重试。"
        : action === "verify"
          ? "验证未通过。请确认文件完整，并输入备份时的原保险库密码。"
          : "恢复未完成。请确认文件和原保险库密码正确，且此浏览器尚无保险库。"));
    } finally {
      setBusy(false);
      setProgress("");
      onBusyChange?.(false);
    }
    if (restored) onRestored?.();
  };

  return (
    <LayerCard data-testid="vault-backup-panel" aria-busy={busy}>
      <LayerCard.Secondary>{restoring ? "从加密备份恢复" : "备份与恢复验证"}</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-4">
        <Text variant="secondary">
          备份采用保险库原生加密格式，包含全部账户。恢复时需要备份时的原保险库密码，地址 TXT 不能替代备份。
        </Text>
        {restoring && <Text variant="secondary">仅用于此浏览器尚无保险库的情况，不合并或覆盖现有保险库。</Text>}
        <Input
          type="password"
          label={restoring ? "原保险库密码" : "当前保险库密码"}
          autoComplete="current-password"
          minLength={1}
          disabled={busy}
          value={password}
          onChange={(event) => { setPassword(event.target.value); clearFeedback(); }}
        />
        {!restoring && (
          <div>
            <Button disabled={busy || password.length === 0} onClick={() => void run("export")}>
              下载加密备份
            </Button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Button disabled={busy} onClick={() => fileInput.current?.click()}>选择加密备份文件</Button>
          <span className="min-w-0 break-all text-kumo-subtle">{file?.name ?? "未选择文件"}</span>
          <input
            ref={fileInput}
            data-testid="vault-backup-file"
            type="file"
            aria-label="加密备份文件"
            hidden
            accept=".json,application/json"
            disabled={busy}
            onChange={(event) => {
              clearFeedback();
              const selected = event.target.files?.[0] ?? null;
              if (selected && (!selected.name.toLowerCase().endsWith(".json") || selected.size === 0 || selected.size > MAX_BACKUP_BYTES)) {
                setFile(null);
                event.target.value = "";
                setError("请选择非空且不超过 64 MB 的 JSON 备份文件。");
                return;
              }
              setFile(selected);
            }}
          />
        </div>
        <div>
          <Button
            variant="primary"
            disabled={busy || password.length === 0 || !file}
            onClick={() => void run(restoring ? "restore" : "verify")}
          >
            {restoring ? "恢复到此浏览器" : "验证备份文件"}
          </Button>
        </div>
        <Text variant="secondary" size="xs">文件和密码仅在此浏览器中处理，不上传服务器。</Text>
        {busy && <p role="status" aria-live="polite" data-testid="vault-backup-progress" className="text-sm text-kumo-subtle">{progress || "正在处理，请稍候。"}</p>}
        {message && (
          <p
            role="status"
            aria-live="polite"
            data-testid="vault-backup-status"
            data-accounts={report?.accountCount}
            data-wallets={report?.walletCount}
            data-verified-signatures={report?.signaturesVerified}
            data-verified-hd-wallets={report?.hdWalletsVerified}
            className={report ? "text-sm text-kumo-success" : "text-sm"}
          >{message}</p>
        )}
        {error && <p role="alert" data-testid="vault-backup-error" className="text-sm text-kumo-danger">{error}</p>}
      </LayerCard.Primary>
    </LayerCard>
  );
}
