// Encrypted backup/restore regression: every browser context has its own disposable IndexedDB.
// Never attaches to a user's browser, emits secrets, broadcasts transactions, or records traces.
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { generatePrivateKey } from "viem/accounts";
import { test, expect } from "@playwright/test";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";

test.use({ trace: "off", screenshot: "off", video: "off", serviceWorkers: "block" });

interface Guard { external: number; api: number; websocket: number; pageErrors: number }
interface VaultBrowser { context: BrowserContext; page: Page; guard: Guard }

async function isolatedBrowser(browser: Browser, baseURL: string | undefined): Promise<VaultBrowser> {
  const origin = new URL(baseURL ?? "http://127.0.0.1:18270").origin;
  const context = await browser.newContext({ baseURL: origin, acceptDownloads: true, serviceWorkers: "block" });
  const guard: Guard = { external: 0, api: 0, websocket: 0, pageErrors: 0 };
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { guard.external++; await route.abort(); return; }
    if (url.pathname === "/api/nado/state") {
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false}' });
      return;
    }
    if (url.pathname.startsWith("/api/")) { guard.api++; await route.abort(); return; }
    await route.continue();
  });
  await context.routeWebSocket(/.*/, (socket) => { guard.websocket++; socket.close(); });
  const page = await context.newPage();
  page.on("pageerror", () => guard.pageErrors++);
  return { context, page, guard };
}

async function fillSecret(input: Locator, value: string) {
  await input.fill(value).catch(() => { throw new Error("Unable to enter disposable vault secret"); });
}

async function createVault(page: Page, password: string) {
  await page.goto("/accounts");
  await fillSecret(page.getByPlaceholder("输入保险库密码", { exact: true }), password);
  await fillSecret(page.getByPlaceholder("再次输入保险库密码", { exact: true }), password);
  await page.getByRole("button", { name: "创建保险库", exact: true }).click();
  await expect(page.getByText("暂无账户", { exact: true })).toBeVisible({ timeout: 60_000 });
}

function accountBlock(page: Page, name: string) {
  return page.getByTestId("account-block").filter({ hasText: name });
}

async function createHd(page: Page, password: string, name: string, count: number) {
  await page.getByRole("button", { name: "HD（派生钱包）", exact: true }).click();
  await page.getByPlaceholder("例如：批量钱包").fill(name);
  await fillSecret(page.getByPlaceholder("输入保险库密码", { exact: true }), password);
  await page.getByLabel("派生钱包数量", { exact: true }).fill(String(count));
  await page.getByRole("button", { name: "创建账户", exact: true }).click();
  await expect(accountBlock(page, name).getByText(`${count} 个钱包`, { exact: true })).toBeVisible({ timeout: 180_000 });
}

async function derive(page: Page, name: string, additional: number, total: number) {
  const account = accountBlock(page, name);
  await account.getByLabel("追加钱包数量", { exact: true }).fill(String(additional));
  await account.getByRole("button", { name: "追加派生钱包", exact: true }).click();
  await expect(account.getByText(`${total} 个钱包`, { exact: true })).toBeVisible({ timeout: 180_000 });
}

async function createPk(page: Page, password: string, name: string, privateKey: string) {
  await page.getByRole("button", { name: "PK（导入私钥）", exact: true }).click();
  await page.getByPlaceholder("例如：批量钱包").fill(name);
  await fillSecret(page.getByPlaceholder("输入保险库密码", { exact: true }), password);
  await fillSecret(page.getByPlaceholder("0x…，每行一个私钥"), privateKey);
  await page.getByRole("button", { name: "创建账户", exact: true }).click();
  await expect(accountBlock(page, name).getByText("1 个钱包", { exact: true })).toBeVisible({ timeout: 60_000 });
}

async function downloadBytes(page: Page, trigger: Locator, error?: Locator): Promise<Buffer> {
  const pending = page.waitForEvent("download", { timeout: 180_000 });
  await trigger.click();
  const download = await (error ? Promise.race([
    pending,
    error.waitFor({ state: "visible", timeout: 180_000 }).then(() => {
      throw new Error("Encrypted backup export failed without producing a download");
    }),
  ]) : pending);
  try { return await readFile((await download.path())!); }
  finally { await download.delete(); }
}

async function addresses(page: Page, name: string, count: number): Promise<string[]> {
  const bytes = await downloadBytes(page, accountBlock(page, name).getByRole("button", { name: "导出地址", exact: true }));
  const result = bytes.toString("utf8").trim().split(/\r?\n/);
  expect(result).toHaveLength(count);
  expect(new Set(result.map((a) => a.toLowerCase())).size).toBe(count);
  expect(result.every((a) => /^0x[0-9a-fA-F]{40}$/.test(a))).toBe(true);
  return result;
}

async function exportBackup(page: Page, password: string): Promise<Buffer> {
  const panel = page.getByTestId("vault-backup-panel");
  await fillSecret(panel.getByLabel("当前保险库密码", { exact: true }), password);
  const backup = await downloadBytes(page, panel.getByRole("button", { name: "下载加密备份", exact: true }), panel.getByTestId("vault-backup-error"));
  expect(backup.length).toBeGreaterThan(100);
  // A boolean assertion avoids printing an accidentally unencrypted file in a failure report.
  expect(backup.toString("utf8").includes(password), "backup must not contain its password").toBe(false);
  return backup;
}

async function selectBackup(page: Page, bytes: Buffer, password: string, restore = false) {
  const panel = page.getByTestId("vault-backup-panel");
  await panel.getByTestId("vault-backup-file").setInputFiles({ name: "disposable-vault-backup.json", mimeType: "application/json", buffer: bytes });
  await fillSecret(panel.getByLabel(restore ? "原保险库密码" : "当前保险库密码", { exact: true }), password);
  return panel;
}

async function verifyBackup(page: Page, bytes: Buffer, password: string, accounts: number, wallets: number, hdWallets = wallets) {
  const panel = await selectBackup(page, bytes, password);
  await panel.getByRole("button", { name: "验证备份文件", exact: true }).click();
  const summary = panel.getByTestId("vault-backup-status");
  await expect(summary).toHaveAttribute("data-accounts", String(accounts), { timeout: 300_000 });
  await expect(summary).toHaveAttribute("data-wallets", String(wallets));
  await expect(summary).toHaveAttribute("data-verified-signatures", String(wallets));
  await expect(summary).toHaveAttribute("data-verified-hd-wallets", String(hdWallets));
  await expect(panel.getByTestId("vault-backup-error")).toHaveCount(0);
}

async function rejectBackup(page: Page, bytes: Buffer, password: string) {
  const panel = await selectBackup(page, bytes, password);
  await panel.getByRole("button", { name: "验证备份文件", exact: true }).click();
  await expect(panel.getByTestId("vault-backup-error")).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByTestId("vault-backup-status")).toHaveCount(0);
}

async function restoreBackup(page: Page, bytes: Buffer, password: string, name: string, count: number) {
  await page.goto("/accounts");
  await expect(page.getByRole("button", { name: "创建保险库", exact: true })).toBeVisible();
  const panel = await selectBackup(page, bytes, password, true);
  await panel.getByRole("button", { name: "恢复到此浏览器", exact: true }).click();
  await expect(accountBlock(page, name).getByText(`${count} 个钱包`, { exact: true })).toBeVisible({ timeout: 300_000 });
}

async function reloadUnlock(page: Page, password: string, name: string, count: number) {
  await page.reload();
  await expect(page.getByRole("button", { name: "解锁", exact: true })).toBeVisible();
  // A populated vault must not offer a destructive restore shortcut.
  await expect(page.getByRole("button", { name: "恢复到此浏览器", exact: true })).toHaveCount(0);
  await fillSecret(page.getByPlaceholder("输入保险库密码", { exact: true }), password);
  await page.getByRole("button", { name: "解锁", exact: true }).click();
  await expect(accountBlock(page, name).getByText(`${count} 个钱包`, { exact: true })).toBeVisible({ timeout: 120_000 });
}

function expectOffline(vaults: VaultBrowser[]) {
  for (const vault of vaults) expect(vault.guard).toEqual({ external: 0, api: 0, websocket: 0, pageErrors: 0 });
}

function corruptBackup(bytes: Buffer, mutation: "ciphertext" | "missing-account"): Buffer {
  const envelope = JSON.parse(bytes.toString("utf8")) as {
    payload: { entries: Array<{ key: string; data: string }>; [key: string]: unknown };
    checksum: string;
  };
  const index = envelope.payload.entries.findIndex((entry) => /^accounts\/[^/]+\.db$/.test(entry.key));
  expect(index >= 0, "backup has an encrypted account record").toBe(true);
  if (mutation === "missing-account") envelope.payload.entries.splice(index, 1);
  else {
    const entry = envelope.payload.entries[index]!;
    const data = Buffer.from(entry.data, "base64");
    const middle = Math.floor(data.length / 2);
    data[middle] = data[middle]! ^ 1;
    entry.data = data.toString("base64");
  }
  // Recompute the public checksum so rejection must reach record authentication/completeness.
  envelope.checksum = createHash("sha256").update(JSON.stringify(envelope.payload), "utf8").digest("hex");
  return Buffer.from(JSON.stringify(envelope));
}

test("encrypted vault backup restores HD and PK wallets without altering the original vault", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const vaults: VaultBrowser[] = [];
  const password = `backup-test-${randomBytes(24).toString("base64url")}`;
  const privateKey = generatePrivateKey();
  try {
    const source = await isolatedBrowser(browser, baseURL); vaults.push(source);
    await createVault(source.page, password);
    await createHd(source.page, password, "backup-hd", 3);
    await derive(source.page, "backup-hd", 3, 6);
    await createPk(source.page, password, "backup-pk", privateKey);
    const hd = await addresses(source.page, "backup-hd", 6);
    const pk = await addresses(source.page, "backup-pk", 1);
    const backup = await exportBackup(source.page, password);
    expect(backup.toString("utf8").includes(privateKey.slice(2)), "backup must not contain a plaintext private key").toBe(false);
    await verifyBackup(source.page, backup, password, 2, 7, 6);
    const verifiedPanel = source.page.getByTestId("vault-backup-panel");
    expect((await verifiedPanel.getByLabel("当前保险库密码", { exact: true }).inputValue()).length).toBe(0);
    await verifiedPanel.screenshot({ path: test.info().outputPath("vault-backup-verified.png"), animations: "disabled" });
    await source.page.screenshot({ path: test.info().outputPath("chinese-accounts.png"), fullPage: true, animations: "disabled" });
    // Ordinary reopening must not invalidate a valid backup's native encrypted account records.
    await reloadUnlock(source.page, password, "backup-hd", 6);
    await verifyBackup(source.page, backup, password, 2, 7, 6);

    const target = await isolatedBrowser(browser, baseURL); vaults.push(target);
    await restoreBackup(target.page, backup, password, "backup-hd", 6);
    expect(await addresses(target.page, "backup-hd", 6)).toEqual(hd);
    expect(await addresses(target.page, "backup-pk", 1)).toEqual(pk);
    await reloadUnlock(target.page, password, "backup-hd", 6);
    expect(await addresses(target.page, "backup-hd", 6)).toEqual(hd);
    expect(await addresses(target.page, "backup-pk", 1)).toEqual(pk);
    // Derivation proves the restored vault contains usable secret material, beyond public addresses.
    await derive(target.page, "backup-hd", 1, 7);
    expect((await addresses(target.page, "backup-hd", 7)).slice(0, 6)).toEqual(hd);
    // Independent source storage must still contain exactly its original six HD plus one PK wallet.
    expect(await addresses(source.page, "backup-hd", 6)).toEqual(hd);
    expect(await addresses(source.page, "backup-pk", 1)).toEqual(pk);
    expectOffline(vaults);
  } finally { await Promise.all(vaults.map((v) => v.context.close())); }
});

test("vault backup rejects wrong passwords, tampering, missing records, another vault and stale tabs", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const vaults: VaultBrowser[] = [];
  const password = `backup-test-${randomBytes(24).toString("base64url")}`;
  try {
    const source = await isolatedBrowser(browser, baseURL); vaults.push(source);
    await createVault(source.page, password);
    await createHd(source.page, password, "backup-source", 3);
    const original = await addresses(source.page, "backup-source", 3);
    const backup = await exportBackup(source.page, password);
    await rejectBackup(source.page, backup, `${password}-wrong`);
    // Malformed files fail before decryption, without touching the current IndexedDB.
    await rejectBackup(source.page, Buffer.from('{"invalid":"backup"}'), password);
    await rejectBackup(source.page, corruptBackup(backup, "ciphertext"), password);
    await rejectBackup(source.page, corruptBackup(backup, "missing-account"), password);
    const other = await isolatedBrowser(browser, baseURL); vaults.push(other);
    await createVault(other.page, password); // Same password ensures failure proves vault identity checking.
    await createHd(other.page, password, "backup-source", 3); // Same name/count, different actual addresses.
    await rejectBackup(source.page, await exportBackup(other.page, password), password);
    const empty = await isolatedBrowser(browser, baseURL); vaults.push(empty);
    await empty.page.goto("/accounts");
    const restore = await selectBackup(empty.page, backup, `${password}-wrong`, true);
    await restore.getByRole("button", { name: "恢复到此浏览器", exact: true }).click();
    await expect(restore.getByTestId("vault-backup-error")).toBeVisible({ timeout: 60_000 });
    await empty.page.reload();
    await expect(empty.page.getByRole("button", { name: "创建保险库", exact: true })).toBeVisible();
    expect(await empty.page.evaluate(async () => (await indexedDB.databases()).some((db) => db.name === "nado-ika-custody"))).toBe(false);
    expect(await addresses(source.page, "backup-source", 3)).toEqual(original);
    await verifyBackup(source.page, backup, password, 1, 3);
    // Same-origin tabs share storage but hold separate in-memory sessions. Verification in an
    // old tab must read persisted account records before claiming that its old backup is current.
    const writer = await source.context.newPage();
    writer.on("pageerror", () => source.guard.pageErrors++);
    await writer.goto("/accounts");
    await fillSecret(writer.getByPlaceholder("输入保险库密码", { exact: true }), password);
    await writer.getByRole("button", { name: "解锁", exact: true }).click();
    await expect(accountBlock(writer, "backup-source").getByText("3 个钱包", { exact: true })).toBeVisible({ timeout: 60_000 });
    await derive(writer, "backup-source", 1, 4);
    const updated = await addresses(writer, "backup-source", 4);
    expect(updated.slice(0, 3)).toEqual(original);
    await expect(accountBlock(source.page, "backup-source").getByText("3 个钱包", { exact: true })).toBeVisible();
    await rejectBackup(source.page, backup, password);
    await reloadUnlock(source.page, password, "backup-source", 4);
    expect(await addresses(source.page, "backup-source", 4)).toEqual(updated);
    expectOffline(vaults);
  } finally { await Promise.all(vaults.map((v) => v.context.close())); }
});

test("10000-wallet encrypted backup verifies every signature and restores every address", async ({ browser, baseURL }) => {
  test.skip(process.env.NADO_BACKUP_10000 !== "1", "Opt-in full 10000-wallet recovery QA");
  test.setTimeout(900_000);
  const vaults: VaultBrowser[] = [];
  const password = `backup-large-${randomBytes(24).toString("base64url")}`;
  const started = Date.now();
  const report: { passed: boolean; stages: Array<Record<string, string | number>>; network?: Guard[]; contextsClosed?: boolean } = { passed: false, stages: [] };
  const mark = (stage: string, data: Record<string, number> = {}) => {
    const result = { stage, elapsedMs: Date.now() - started, ...data };
    report.stages.push(result);
    console.log(JSON.stringify(result));
  };
  try {
    const source = await isolatedBrowser(browser, baseURL); vaults.push(source);
    await createVault(source.page, password);
    await createHd(source.page, password, "backup-10000", 3);
    mark("derive-started", { count: 10000 });
    await derive(source.page, "backup-10000", 9997, 10000);
    const original = await addresses(source.page, "backup-10000", 10000);
    mark("source-addresses-validated", { count: 10000 });
    const backup = await exportBackup(source.page, password);
    mark("encrypted-backup-downloaded", { encryptedBytes: backup.length });
    await verifyBackup(source.page, backup, password, 1, 10000);
    mark("backup-verified", { signaturesVerified: 10000, hdWalletsVerified: 10000 });
    const target = await isolatedBrowser(browser, baseURL); vaults.push(target);
    await restoreBackup(target.page, backup, password, "backup-10000", 10000);
    expect(await addresses(target.page, "backup-10000", 10000)).toEqual(original);
    mark("isolated-restoration-matched", { addresses: 10000 });
    await reloadUnlock(target.page, password, "backup-10000", 10000);
    expect(await addresses(target.page, "backup-10000", 10000)).toEqual(original);
    mark("restored-reload-unlock-matched", { addresses: 10000 });
    await derive(target.page, "backup-10000", 1, 10001);
    expect((await addresses(target.page, "backup-10000", 10001)).slice(0, 10000)).toEqual(original);
    expect(await addresses(source.page, "backup-10000", 10000)).toEqual(original);
    expectOffline(vaults);
    report.passed = true;
    mark("future-derivation-proved-source-unchanged", { sourceCount: 10000, restoredCount: 10001 });
  } finally {
    await Promise.all(vaults.map((v) => v.context.close()));
    report.contextsClosed = true;
    report.network = vaults.map((v) => v.guard);
    const summaryPath = test.info().outputPath("backup-10000-summary.json");
    await writeFile(summaryPath, JSON.stringify(report, null, 2));
    await test.info().attach("backup-10000-summary", { path: summaryPath, contentType: "application/json" });
  }
});
