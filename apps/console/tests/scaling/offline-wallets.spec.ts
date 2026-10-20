// Regression: local vault identities must remain visible when trading is disabled or unavailable.
// Real browser crypto + IndexedDB in Playwright's disposable context; no user profile or real chain.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// Passwords/mnemonics must not appear in screenshots, traces, or retained browser storage.
test.use({ trace: "off", screenshot: "off", video: "off", serviceWorkers: "block" });

type StateMode = "disabled" | "network-failure" | "config-error";

async function offlineOnly(page: Page, baseURL: string | undefined, mode: StateMode) {
  const origin = new URL(baseURL ?? "http://127.0.0.1:18270").origin;
  const requests = { state: 0, stateSettled: 0, external: 0, api: 0, websocket: 0 };
  const settleState = (request: { url(): string }) => {
    if (new URL(request.url()).pathname === "/api/nado/state") requests.stateSettled++;
  };
  page.on("requestfinished", settleState);
  page.on("requestfailed", settleState);
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { requests.external++; await route.abort(); return; }
    if (url.pathname === "/api/nado/state") {
      requests.state++;
      if (mode === "network-failure") { await route.abort("failed"); return; }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mode === "config-error"
          ? { enabled: true, error: "Public configuration unavailable" }
          : { enabled: false }),
      });
      return;
    }
    // Block local relay/RPC routes as well as remote requests: nothing can reach a real chain.
    if (url.pathname.startsWith("/api/")) { requests.api++; await route.abort(); return; }
    await route.continue();
  });
  await page.context().routeWebSocket(/.*/, (socket) => { requests.websocket++; socket.close(); });
  return requests;
}

async function enterPassword(page: Page, password: string, confirm = false) {
  // Replace a possible Playwright fill failure (which can contain its argument) with a safe error.
  const placeholder = confirm ? "再次输入保险库密码" : "输入保险库密码";
  await page.getByPlaceholder(placeholder, { exact: true }).fill(password).catch(() => {
    throw new Error("Unable to enter disposable test-输入保险库密码");
  });
}

async function createAccount(page: Page, password: string) {
  await page.goto("/accounts");
  await enterPassword(page, password);
  await enterPassword(page, password, true);
  await page.getByRole("button", { name: "创建保险库", exact: true }).click();
  await expect(page.getByText("暂无账户", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByPlaceholder("例如：批量钱包").fill("offline-regression");
  await enterPassword(page, password);
  await page.getByLabel("派生钱包数量", { exact: true }).fill("3");
  await page.getByRole("button", { name: "创建账户", exact: true }).click();
  const account = page.getByTestId("account-block").filter({ hasText: "offline-regression" });
  await expect(account.getByText("3 个钱包", { exact: true })).toBeVisible({ timeout: 30_000 });

  const pending = page.waitForEvent("download");
  await account.getByRole("button", { name: "导出地址", exact: true }).click();
  const download = await pending;
  const addresses = (await readFile((await download.path())!, "utf8")).trim().split(/\r?\n/);
  await download.delete();
  expect(addresses).toHaveLength(3);
  expect(new Set(addresses.map((a) => a.toLowerCase())).size).toBe(3);
  for (const address of addresses) expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  return addresses;
}

async function expectLocalCards(page: Page, count: number) {
  await expect(page.getByTestId("wallet-card")).toHaveCount(count, { timeout: 30_000 });
  await expect(page.getByText(`${count} / ${count}`, { exact: true })).toBeVisible();
  await expect(page.getByText(`显示 ${count} 个 · 可横向滚动`, { exact: true })).toBeVisible();
  const first = page.getByTestId("wallet-card").first();
  await expect(first.getByText("本地", { exact: true })).toBeVisible();
  await expect(first.getByText("余额未查询", { exact: true })).toBeVisible();
  await expect(page.getByText("批量操作", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(在 \d+ 个钱包上执行|启动 \d+ 个钱包的定时任务)$/ })).toHaveCount(0);
}

async function expectAddressOnlyDrawer(page: Page, address: string) {
  const errors: string[] = [];
  const captureError = (error: Error) => { errors.push(error.message); };
  page.on("pageerror", captureError);
  await page.getByTestId("wallet-card").first().click();
  const drawer = page.getByRole("dialog", { name: "本地钱包", exact: true });
  try {
    await expect(drawer).toBeVisible();
  } catch (error) {
    // This listener is installed only after leaving all password/secret entry forms.
    if (errors.length) throw new Error(`本地钱包 drawer crashed: ${errors.join("; ")}`);
    throw error;
  } finally {
    page.off("pageerror", captureError);
  }
  await expect(drawer.getByText(address, { exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "复制地址", exact: true })).toBeVisible();
  await expect(page.getByText("下单", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", {
    name: /^(签名并提交|充值|提现|补充手续费|吃单（立即成交或撤销）|平仓|在浏览器中生成并签名)$/,
  })).toHaveCount(0);
  await drawer.getByRole("button", { name: "关闭钱包", exact: true }).click();
  await expect(drawer).toHaveCount(0);
}

test("offline vault wallets: list, address details, account filters, reload and additional derivation", async ({ page, baseURL }) => {
  const requests = await offlineOnly(page, baseURL, "disabled");
  const password = `offline-test-${randomBytes(24).toString("base64url")}`;
  const addresses = await createAccount(page, password);
  await page.getByRole("link", { name: "钱包", exact: true }).click();
  await expect.poll(() => requests.stateSettled).toBeGreaterThan(0);
  await expectLocalCards(page, 3);
  await expectAddressOnlyDrawer(page, addresses[0]!);

  await page.getByRole("button", { name: "全部账户", exact: true }).click();
  const filter = page.getByRole("dialog");
  await expect(filter.getByRole("checkbox", { name: "offline-regression" })).toBeChecked();
  await filter.getByRole("button", { name: "全不选", exact: true }).click();
  await expect(page.getByTestId("wallet-card")).toHaveCount(0);
  await expect(page.getByText("没有符合筛选条件的钱包", { exact: true })).toBeVisible();
  await expect(page.getByText("0 / 3", { exact: true })).toBeVisible();
  await filter.getByRole("button", { name: "全选", exact: true }).click();
  await page.keyboard.press("Escape");
  await expectLocalCards(page, 3);

  await page.reload();
  await expect(page.getByRole("button", { name: "解锁", exact: true })).toBeVisible();
  await expect(page.getByTestId("wallet-card")).toHaveCount(0);
  await enterPassword(page, password);
  await page.getByRole("button", { name: "解锁", exact: true }).click();
  await expectLocalCards(page, 3);
  await expectAddressOnlyDrawer(page, addresses[0]!);

  await page.getByRole("link", { name: "账户", exact: true }).click();
  const account = page.getByTestId("account-block").filter({ hasText: "offline-regression" });
  await account.getByRole("button", { name: "追加派生钱包", exact: true }).click();
  await expect(account.getByText("4 个钱包", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: "钱包", exact: true }).click();
  await expectLocalCards(page, 4);
  expect(requests.state).toBeGreaterThan(0);
  expect({ external: requests.external, api: requests.api, websocket: requests.websocket }).toEqual({ external: 0, api: 0, websocket: 0 });
});

for (const mode of ["network-failure", "config-error"] as const) {
  test(`local vault wallets survive state ${mode} without exposing trading`, async ({ page, baseURL }) => {
    const requests = await offlineOnly(page, baseURL, mode);
    const password = `offline-test-${randomBytes(24).toString("base64url")}`;
    const addresses = await createAccount(page, password);
    await page.getByRole("link", { name: "钱包", exact: true }).click();
    await expect.poll(() => requests.stateSettled).toBeGreaterThan(0);
    await expectLocalCards(page, 3);
    await expectAddressOnlyDrawer(page, addresses[0]!);
    expect(requests.state).toBeGreaterThan(0);
    expect({ external: requests.external, api: requests.api, websocket: requests.websocket }).toEqual({ external: 0, api: 0, websocket: 0 });
  });
}
