import type { ContainerEntry, Workspace } from "wative-core";
import {
  accountAddresses, exportEncryptedVault, isUnlocked, listAccounts, restoreEncryptedVault,
} from "./custody";

export interface BackupReport {
  accountCount: number;
  walletCount: number;
  signaturesVerified: number;
  hdWalletsVerified: number;
  matchesCurrentVault: boolean;
}

type Progress = (message: string) => void;
interface ManifestAccount { slug: string; name: string; kind: "HD" | "PK"; addresses: string[] }
interface EncodedEntry { key: string; data: string }
interface BackupPayload {
  format: "nado-trading-desk-vault";
  version: 1;
  wativeVersion: "2.6.0";
  createdAt: string;
  manifest: ManifestAccount[];
  entries: EncodedEntry[];
}
interface BackupEnvelope { payload: BackupPayload; checksum: string }

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ACCOUNTS = 10_000;
const MAX_WALLETS = 1_000_000;
const ROOT_KEYS = ["config", "network", "asset", "log"];
const SLUG = /^[a-z0-9][a-z0-9._-]{0,255}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const FORMAT_ERROR = "备份文件格式无效、已损坏或版本不受支持。";
const VERIFY_ERROR = "备份核验失败。请检查密码和备份文件；当前保险库未被修改。";
const CURRENT_ERROR = "备份与当前保险库不完全一致，可能缺少账户或新派生的钱包。请重新导出完整备份。";
const RESTORE_ERROR = "恢复未完成。请保留备份文件，刷新页面后检查保险库状态。";

class BackupError extends Error {}
/** Only our fixed, nonsecret messages may be rendered by the UI. */
export function backupErrorMessage(error: unknown): string | undefined {
  return error instanceof BackupError ? error.message : undefined;
}
function requireCondition(condition: unknown, message = FORMAT_ERROR): asserts condition {
  if (!condition) throw new BackupError(message);
}
function safeError(error: unknown, fallback: string): Error {
  return error instanceof BackupError ? error : new BackupError(fallback);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function emit(onProgress: Progress | undefined, message: string): void {
  // A UI callback must not interrupt cleanup or change the verification result.
  try { onProgress?.(message); } catch { /* progress is advisory */ }
}
async function yieldToBrowser(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
function requirePassword(password: string): void {
  requireCondition(typeof password === "string" && password.length > 0 && password.length <= 4096,
    "请输入保险库密码以重新验证备份。");
}
function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
function decodeBytes(encoded: string): Uint8Array {
  requireCondition(encoded.length > 0 && encoded.length % 4 === 0
    && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded));
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  requireCondition(encodeBytes(bytes) === encoded);
  // Only the SDK's encrypted V2/V3 containers are accepted, never plaintext records.
  requireCondition(bytes.length >= 32 && (bytes[0] === 2 || bytes[0] === 3));
  return bytes;
}
async function checksum(payload: BackupPayload): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  requireCondition(bytes.byteLength <= MAX_FILE_BYTES);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function validateManifest(value: unknown): asserts value is ManifestAccount[] {
  requireCondition(Array.isArray(value) && value.length > 0 && value.length <= MAX_ACCOUNTS);
  const slugs = new Set<string>();
  let total = 0;
  for (const account of value) {
    requireCondition(object(account) && exactKeys(account, ["slug", "name", "kind", "addresses"]));
    requireCondition(typeof account.slug === "string" && SLUG.test(account.slug) && !slugs.has(account.slug));
    slugs.add(account.slug);
    requireCondition(typeof account.name === "string" && account.name.length <= 4096);
    requireCondition(account.kind === "HD" || account.kind === "PK");
    requireCondition(Array.isArray(account.addresses));
    total += account.addresses.length;
    requireCondition(total <= MAX_WALLETS);
    for (const address of account.addresses) requireCondition(typeof address === "string" && ADDRESS.test(address));
  }
  requireCondition(total > 0, "保险库没有可备份的 EVM 钱包。");
}
function currentManifest(): ManifestAccount[] {
  requireCondition(isUnlocked(), "请先解锁当前保险库。");
  const manifest: ManifestAccount[] = listAccounts().map((account) => ({
    slug: account.slug, name: account.name, kind: account.kind,
    addresses: accountAddresses(account.slug).map((address) => address.toLowerCase()),
  }));
  validateManifest(manifest);
  return manifest;
}
function sameManifest(left: ManifestAccount[], right: ManifestAccount[]): boolean {
  return left.length === right.length && left.every((account, index) => {
    const other = right[index];
    return other !== undefined && account.slug === other.slug && account.name === other.name
      && account.kind === other.kind && account.addresses.length === other.addresses.length
      && account.addresses.every((address, walletIndex) => address === other.addresses[walletIndex]);
  });
}
async function requireCurrentAccountRecords(expected: readonly ContainerEntry[]): Promise<void> {
  // Another tab can mutate IndexedDB without refreshing this tab's session view.
  // Re-read persisted account ciphertext; roots such as logs may change without
  // changing wallets, so they are deliberately excluded from this freshness test.
  const fresh = (await exportEncryptedVault()).filter((entry) => entry.key.startsWith("accounts/"));
  const snapshot = expected.filter((entry) => entry.key.startsWith("accounts/"));
  const byKey = new Map(fresh.map((entry) => [entry.key, entry.data]));
  const message = "保险库的账户数据已变化，可能在其他标签页中新增或修改了钱包。请重新导出完整备份。";
  requireCondition(fresh.length === snapshot.length && byKey.size === snapshot.length, message);
  for (const entry of snapshot) {
    const current = byKey.get(entry.key);
    requireCondition(current !== undefined && current.length === entry.data.length
      && current.every((byte, index) => byte === entry.data[index]), message);
  }
  // These buffers belong to the SDK; never wipe or mutate them.
}
function decodeEntries(payload: BackupPayload): ContainerEntry[] {
  const expected = new Set([...ROOT_KEYS, ...payload.manifest.map((account) => `accounts/${account.slug}.db`)]);
  requireCondition(Array.isArray(payload.entries) && payload.entries.length === expected.size);
  const entries: ContainerEntry[] = [];
  try {
    for (const entry of payload.entries) {
      requireCondition(object(entry) && exactKeys(entry, ["key", "data"]));
      // Membership rejects duplicates, unknown record types, absolute paths and traversal.
      requireCondition(typeof entry.key === "string" && expected.delete(entry.key));
      requireCondition(typeof entry.data === "string" && entry.data.length <= MAX_FILE_BYTES);
      entries.push({ key: entry.key, data: decodeBytes(entry.data) });
    }
    requireCondition(expected.size === 0);
    return entries;
  } catch (error) {
    for (const entry of entries) entry.data.fill(0);
    throw error;
  }
}
async function parseBackup(json: string): Promise<{ envelope: BackupEnvelope; entries: ContainerEntry[] }> {
  requireCondition(typeof json === "string" && json.length <= MAX_FILE_BYTES
    && new TextEncoder().encode(json).byteLength <= MAX_FILE_BYTES);
  const value: unknown = JSON.parse(json);
  requireCondition(object(value) && exactKeys(value, ["payload", "checksum"]));
  const payload = value.payload;
  requireCondition(object(payload) && exactKeys(payload, ["format", "version", "wativeVersion", "createdAt", "manifest", "entries"]));
  requireCondition(payload.format === "nado-trading-desk-vault" && payload.version === 1 && payload.wativeVersion === "2.6.0");
  requireCondition(typeof payload.createdAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.createdAt)
    && Number.isFinite(Date.parse(payload.createdAt)) && new Date(payload.createdAt).toISOString() === payload.createdAt);
  validateManifest(payload.manifest);
  requireCondition(typeof value.checksum === "string" && /^[0-9a-f]{64}$/.test(value.checksum));
  const envelope = value as unknown as BackupEnvelope;
  // This unkeyed checksum detects accidental corruption. Authentication is provided
  // by the SDK's encrypted records, then proven for every wallet below.
  requireCondition(await checksum(envelope.payload) === envelope.checksum);
  return { envelope, entries: decodeEntries(envelope.payload) };
}

async function verifyIsolated(
  entries: readonly ContainerEntry[], manifest: ManifestAccount[], password: string, onProgress?: Progress,
): Promise<BackupReport> {
  emit(onProgress, "正在内存中解密备份并核对账户……");
  await yieldToBrowser();
  const [wative, viem, accounts] = await Promise.all([
    import("wative-core"), import("viem"), import("viem/accounts"),
  ]);
  // No IndexedDB, filesystem or network provider is used for verification. Each
  // instance owns copied ciphertext and a unique SDK container lock namespace.
  class MemoryProvider extends wative.ContainerProvider {
    private readonly records = new Map<string, Uint8Array>();
    private readonly directories = new Set<string>([""]);
    constructor() { super(`memory://nado-backup-${crypto.randomUUID()}`); }
    protected _exist(path: string): boolean {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      return this.records.has(path) || this.directories.has(path)
        || Array.from(this.records.keys()).some((key) => key.startsWith(prefix));
    }
    protected _read(path: string): Uint8Array {
      const bytes = this.records.get(path);
      if (!bytes) throw Object.assign(new Error("Missing memory record"), { code: "RECORD_NOT_FOUND" });
      return bytes.slice();
    }
    protected _write(path: string, bytes: Uint8Array): void {
      this.records.get(path)?.fill(0);
      this.records.set(path, bytes.slice());
    }
    protected _remove(path: string): void { this.records.get(path)?.fill(0); this.records.delete(path); }
    protected _ensureDir(path: string): void { this.directories.add(path); }
    protected _listItems(path: string): string[] {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      return Array.from(new Set(Array.from(this.records.keys())
        .filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length).split("/")[0]!)
        .filter(Boolean)));
    }
    dispose(): void {
      for (const bytes of this.records.values()) bytes.fill(0);
      this.records.clear(); this.directories.clear();
    }
  }
  const memory = new MemoryProvider();
  let workspace: Workspace | undefined;
  try {
    await memory.importContainer(entries);
    workspace = await wative.Workspace.open(memory, password, false);
    requireCondition(!workspace.locked && workspace.damagedAccountSlugs.length === 0, VERIFY_ERROR);
    requireCondition(workspace.accounts.length === manifest.length, VERIFY_ERROR);
    const restored: ManifestAccount[] = [];
    for (const account of workspace.accounts) {
      await account.tryUnlock(password);
      requireCondition(!account.locked, VERIFY_ERROR);
      restored.push({
        slug: account.slug, name: account.displayName, kind: account.organizationType,
        addresses: Array.from(account.wallets).filter((wallet) => wallet.evm !== null)
          .map((wallet) => wallet.evm!.publicKey.toLowerCase()),
      });
    }
    requireCondition(sameManifest(manifest, restored), VERIFY_ERROR);
    const walletCount = manifest.reduce((total, account) => total + account.addresses.length, 0);
    let signaturesVerified = 0;
    let hdWalletsVerified = 0;
    const nonce = viem.toHex(crypto.getRandomValues(new Uint8Array(32)));
    for (const account of workspace.accounts) {
      // One BIP39 seed calculation per account; do not repeat its KDF for 10,000 children.
      // The mnemonic and key material never leave this isolated verification scope.
      const base = account.organizationType === "HD"
        ? accounts.mnemonicToAccount(account.dumpMnemonic(), { path: "m/44'/60'/0'/0" }).getHdKey()
        : undefined;
      try {
        for (const wallet of account.wallets) {
          const evm = wallet.evm;
          if (!evm) continue;
          const address = evm.publicKey.toLowerCase();
          if (base) {
            requireCondition(Number.isSafeInteger(wallet.id) && wallet.id >= 0 && wallet.id < 0x80000000, VERIFY_ERROR);
            const child = base.deriveChild(wallet.id);
            try {
              requireCondition(child.privateKey !== null, VERIFY_ERROR);
              const derived = accounts.privateKeyToAddress(viem.toHex(child.privateKey));
              requireCondition(derived.toLowerCase() === address, VERIFY_ERROR);
              hdWalletsVerified++;
            } finally { child.wipePrivateData(); }
          }
          // A random, domain-separated local challenge: never a transaction or an approval.
          const hash = viem.keccak256(viem.toHex(`nado-trading-desk:local-backup-verification:v1\n${nonce}\n${account.slug}\n${wallet.id}`));
          const signature = evm.signDigest(hash).signature as `0x${string}`;
          const recovered = await viem.recoverAddress({ hash, signature });
          requireCondition(recovered.toLowerCase() === address, VERIFY_ERROR);
          signaturesVerified++;
          if (signaturesVerified % 50 === 0 || signaturesVerified === walletCount) {
            emit(onProgress, `正在核验钱包 ${signaturesVerified} / ${walletCount}（助记词派生已核对 ${hdWalletsVerified}）`);
            await yieldToBrowser();
          }
        }
      } finally { base?.wipePrivateData(); }
    }
    requireCondition(signaturesVerified === walletCount, VERIFY_ERROR);
    return { accountCount: manifest.length, walletCount, signaturesVerified, hdWalletsVerified, matchesCurrentVault: false };
  } finally {
    try { if (workspace) await workspace.close(); else await memory.close(); }
    finally { memory.dispose(); }
  }
}

/** Export native encrypted records, and re-authenticate/verify a separate in-memory copy. */
export async function exportVaultBackup(password: string, onProgress?: Progress): Promise<{
  json: string; filename: string; report: BackupReport;
}> {
  let entries: readonly ContainerEntry[] = [];
  try {
    requirePassword(password);
    const manifest = currentManifest();
    emit(onProgress, "正在读取加密记录……");
    entries = (await exportEncryptedVault()).map((entry) => ({ key: entry.key, data: entry.data.slice() }));
    const payload: BackupPayload = {
      format: "nado-trading-desk-vault", version: 1, wativeVersion: "2.6.0",
      createdAt: new Date().toISOString(), manifest,
      entries: entries.map((entry) => ({ key: entry.key, data: encodeBytes(entry.data) })),
    };
    const envelope: BackupEnvelope = { payload, checksum: await checksum(payload) };
    const json = JSON.stringify(envelope);
    // Parse the exact download representation, not a separate object graph.
    const parsed = await parseBackup(json);
    let report: BackupReport;
    try { report = await verifyIsolated(parsed.entries, manifest, password, onProgress); }
    finally { for (const entry of parsed.entries) entry.data.fill(0); }
    requireCondition(sameManifest(manifest, currentManifest()), CURRENT_ERROR);
    await requireCurrentAccountRecords(entries);
    report.matchesCurrentVault = true;
    emit(onProgress, `备份已核验：${report.walletCount} 个钱包，${report.signaturesVerified} 次签名验证通过。`);
    return { json, filename: `nado-vault-${payload.createdAt.replace(/[:.]/g, "-")}.json`, report };
  } catch (error) { throw safeError(error, VERIFY_ERROR); }
  finally { for (const entry of entries) entry.data.fill(0); }
}

/** Verify a file against the currently unlocked vault, without writing to that vault. */
export async function verifyVaultBackup(json: string, password: string, onProgress?: Progress): Promise<BackupReport> {
  let entries: ContainerEntry[] = [];
  try {
    requirePassword(password);
    const current = currentManifest();
    const parsed = await parseBackup(json);
    entries = parsed.entries;
    requireCondition(sameManifest(current, parsed.envelope.payload.manifest), CURRENT_ERROR);
    const report = await verifyIsolated(entries, parsed.envelope.payload.manifest, password, onProgress);
    requireCondition(sameManifest(current, currentManifest()), CURRENT_ERROR);
    await requireCurrentAccountRecords(entries);
    report.matchesCurrentVault = true;
    emit(onProgress, `核验通过：${report.walletCount} 个钱包与当前保险库完全一致。`);
    return report;
  } catch (error) { throw safeError(error, VERIFY_ERROR); }
  finally { for (const entry of entries) entry.data.fill(0); }
}

/** Restore only after exhaustive isolated verification; custody enforces an empty destination. */
export async function restoreVaultBackup(json: string, password: string, onProgress?: Progress): Promise<BackupReport> {
  let entries: ContainerEntry[] = [];
  try {
    requirePassword(password);
    requireCondition(!isUnlocked(), "此浏览器已有保险库。请在没有保险库的新浏览器配置中恢复。");
    const parsed = await parseBackup(json);
    entries = parsed.entries;
    const report = await verifyIsolated(entries, parsed.envelope.payload.manifest, password, onProgress);
    requireCondition(!isUnlocked(), "此浏览器已有保险库，恢复已停止。");
    emit(onProgress, "核验通过，正在恢复加密保险库……");
    try { await restoreEncryptedVault(entries, password); }
    catch { throw new BackupError(RESTORE_ERROR); }
    requireCondition(sameManifest(parsed.envelope.payload.manifest, currentManifest()), RESTORE_ERROR);
    emit(onProgress, `恢复完成：${report.accountCount} 个账户、${report.walletCount} 个钱包。`);
    return report;
  } catch (error) { throw safeError(error, VERIFY_ERROR); }
  finally { for (const entry of entries) entry.data.fill(0); }
}
