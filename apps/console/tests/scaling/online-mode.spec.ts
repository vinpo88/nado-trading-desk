// Real disposable browser custody, simulated read-only chains. No user's profile or live network.
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { liveConfig } from "../_helpers/mock-live";

test.use({ trace: "off", screenshot: "off", video: "off", serviceWorkers: "block" });

const TESTNET = 763373;
const MAINNET = 57073;
const NETWORK_NAMES: Record<number, string> = { [TESTNET]: "测试网", [MAINNET]: "主网" };
type Subscription = { type: string; subaccount: string; at: number };
type SocketRecord = { chainId: number; subscriptions: Subscription[]; closed: boolean };

async function mockOnline(page: Page, baseURL: string | undefined) {
  const origin = new URL(baseURL ?? "http://127.0.0.1:18271").origin;
  const state = {
    healthy: true, documents: 0, writes: 0, unexpected: 0, auth: 0, pageErrors: 0,
    configChains: [] as number[], relayChains: [] as number[], rpcChains: [] as number[], sockets: [] as SocketRecord[],
  };
  page.on("pageerror", () => state.pageErrors++);
  const chainFromCookie = (cookie: string | null) => Number(cookie?.match(/(?:^|;\s*)nado-chain-id=(\d+)/)?.[1] ?? TESTNET);
  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    // Native-balance reads are simulated before any connection can leave the test browser.
    if (["rpc-gel-sepolia.inkonchain.com", "rpc-gel.inkonchain.com"].includes(url.hostname)) {
      const chainId = url.hostname.includes("sepolia") ? TESTNET : MAINNET;
      let rpc: { id?: number; method?: string } = {};
      try { rpc = JSON.parse(request.postData() ?? "{}"); } catch { /* rejected below */ }
      if (rpc.method !== "eth_getBalance") { state.writes++; await route.abort(); return; }
      state.rpcChains.push(chainId);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? 1, result: "0x0" }) });
      return;
    }
    if (url.origin !== origin) { state.unexpected++; await route.abort(); return; }
    if (request.isNavigationRequest() && request.resourceType() === "document") state.documents++;
    if (url.pathname === "/api/nado/state") {
      const chainId = chainFromCookie(await request.headerValue("cookie"));
      state.configChains.push(chainId);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(state.healthy
        ? liveConfig({ chainId, wsSubscribeUrl: `wss://mock.nado.test/${chainId}` })
        : { enabled: true, error: "测试连接暂时不可用" }) });
      return;
    }
    if (url.pathname === "/api/nado/relay/query") {
      let query: { type?: string } = {};
      try { query = JSON.parse(request.postData() ?? "{}"); } catch { /* rejected below */ }
      let data: unknown;
      if (query.type === "subaccount_info") {
        data = { exists: true, spot_balances: [], perp_balances: [], spot_products: [], perp_products: [], health_contributions: {}, healths: [0, 1, 2].map(() => ({ health: "0", assets: "0", liabilities: "0" })) };
      } else if (query.type === "orders") data = { product_orders: [] };
      else if (query.type === "market_price") data = { product_id: 2, ask_x18: "0", bid_x18: "0" };
      else { state.unexpected++; await route.abort(); return; }
      state.relayChains.push(chainFromCookie(await request.headerValue("cookie")));
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "success", data }) });
      return;
    }
    // Any execute, broadcast, deposit, withdrawal or other API is a failure, even if blocked.
    if (url.pathname.startsWith("/api/") || request.method() !== "GET") { state.writes++; await route.abort(); return; }
    await route.continue();
  });
  await page.context().routeWebSocket(/.*/, (socket) => {
    const match = socket.url().match(/^wss:\/\/mock\.nado\.test\/(763373|57073)$/);
    if (!match) { state.unexpected++; socket.close(); return; }
    const record: SocketRecord = { chainId: Number(match[1]), subscriptions: [], closed: false };
    state.sockets.push(record);
    socket.onClose(() => { record.closed = true; });
    socket.onMessage((raw) => {
      let frame: { method?: string; stream?: { type?: string; subaccount?: string } } = {};
      try { frame = JSON.parse(String(raw)); } catch { state.unexpected++; return; }
      if (frame.method === "authenticate") { state.auth++; return; }
      if (frame.method !== "subscribe" || !["fill", "position_change"].includes(frame.stream?.type ?? "") || !frame.stream?.subaccount) {
        state.unexpected++;
        return;
      }
      record.subscriptions.push({ type: frame.stream.type!, subaccount: frame.stream.subaccount, at: Date.now() });
    });
  });
  return state;
}

type MockState = Awaited<ReturnType<typeof mockOnline>>;

async function fillSecret(input: Locator, password: string) {
  await input.fill(password).catch(() => { throw new Error("Unable to enter disposable test password"); });
}

async function createWallets(page: Page, password: string, count = 3) {
  await page.goto("/accounts");
  await fillSecret(page.getByPlaceholder("输入保险库密码", { exact: true }), password);
  await fillSecret(page.getByPlaceholder("再次输入保险库密码", { exact: true }), password);
  await page.getByRole("button", { name: "创建保险库", exact: true }).click();
  await expect(page.getByText("暂无账户", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByPlaceholder("例如：批量钱包").fill("online-regression");
  await fillSecret(page.getByPlaceholder("输入保险库密码", { exact: true }), password);
  await page.getByLabel("派生钱包数量", { exact: true }).fill(String(count));
  await page.getByRole("button", { name: "创建账户", exact: true }).click();
  await expect(page.getByTestId("account-block").getByText(`${count} 个钱包`, { exact: true })).toBeVisible({ timeout: 180_000 });
  await page.getByRole("link", { name: "钱包", exact: true }).click();
}

async function unlock(page: Page, password: string) {
  await expect(page.getByRole("button", { name: "解锁", exact: true })).toBeVisible();
  await expect(page.getByTestId("wallet-card")).toHaveCount(0);
  await fillSecret(page.getByPlaceholder("输入保险库密码", { exact: true }), password);
  await page.getByRole("button", { name: "解锁", exact: true }).click();
}

async function expectOnline(page: Page, state: MockState, chainId: number, count = 3) {
  await expect(page.getByText(new RegExp(`^在线 ${NETWORK_NAMES[chainId]} · ${count} 个钱包 · 推送已连接`))).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("group", { name: "网络", exact: true }).getByRole("button", { name: NETWORK_NAMES[chainId], exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => state.configChains.at(-1)).toBe(chainId);
  await expect.poll(() => state.sockets.at(-1)?.chainId).toBe(chainId);
  await expect.poll(() => state.rpcChains.at(-1), { timeout: 30_000 }).toBe(chainId);
  await expect.poll(() => state.relayChains.at(-1), { timeout: 30_000 }).toBe(chainId);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("html")).toHaveAttribute("data-net", chainId === TESTNET ? "testnet" : "mainnet");
}

function expectReadOnly(state: MockState) {
  expect({ writes: state.writes, unexpected: state.unexpected, auth: state.auth, pageErrors: state.pageErrors })
    .toEqual({ writes: 0, unexpected: 0, auth: 0, pageErrors: 0 });
}

test("Chinese online mode: testnet default, mainnet confirmation, reload isolation and launcher reset", async ({ page, baseURL }) => {
  const state = await mockOnline(page, baseURL);
  const password = `online-test-${randomBytes(24).toString("base64url")}`;
  await createWallets(page, password);
  await expectOnline(page, state, TESTNET);
  await expect.poll(() => state.sockets.at(-1)?.subscriptions.length).toBe(6);
  await expect(page.getByTestId("wallet-card")).toHaveCount(3);
  const network = page.getByRole("group", { name: "网络", exact: true });
  const documents = state.documents;
  await network.getByRole("button", { name: "主网", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", { name: "切换到主网？", exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  expect(state.documents).toBe(documents);
  await expectOnline(page, state, TESTNET);

  await network.getByRole("button", { name: "主网", exact: true }).click();
  await confirmation.screenshot({ path: test.info().outputPath("chinese-mainnet-confirmation.png") });
  await Promise.all([
    page.waitForEvent("load"),
    confirmation.getByRole("button", { name: "确认切换主网", exact: true }).click(),
  ]);
  expect(state.documents).toBe(documents + 1);
  const mainConfigStart = state.configChains.length;
  const mainRpcStart = state.rpcChains.length;
  const mainRelayStart = state.relayChains.length;
  await unlock(page, password);
  await expectOnline(page, state, MAINNET);
  await expect.poll(() => state.sockets.at(-1)?.subscriptions.length).toBe(6);
  expect(state.configChains.slice(mainConfigStart)).toEqual([MAINNET]);
  expect(state.rpcChains.slice(mainRpcStart).every((id) => id === MAINNET)).toBe(true);
  expect(state.relayChains.slice(mainRelayStart).every((id) => id === MAINNET)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("chinese-mainnet-wallets.png") });

  // The normal testnet switch also replaces the document and locks the same persisted vault.
  await Promise.all([page.waitForEvent("load"), network.getByRole("button", { name: "测试网", exact: true }).click()]);
  expect(state.documents).toBe(documents + 2);
  await unlock(page, password);
  await expectOnline(page, state, TESTNET);

  // A launcher URL explicitly resets a previously selected mainnet cookie before unlocking.
  await page.context().addCookies([{ name: "nado-chain-id", value: String(MAINNET), url: baseURL ?? "http://127.0.0.1:18271" }]);
  await page.goto("/?network=testnet");
  await expect(page).toHaveURL(/\/$/);
  await unlock(page, password);
  await expectOnline(page, state, TESTNET);
  expect((await page.context().cookies()).find((cookie) => cookie.name === "nado-chain-id")?.value).toBe(String(TESTNET));
  expectReadOnly(state);
});

test("Chinese online mode: failed public config retains network switch and retry reconnects local wallets", async ({ page, baseURL }) => {
  const state = await mockOnline(page, baseURL);
  state.healthy = false;
  const password = `online-retry-${randomBytes(24).toString("base64url")}`;
  await createWallets(page, password);
  await expect(page.getByText("离线 · 本地钱包", { exact: true })).toBeVisible();
  await expect(page.getByTestId("wallet-card")).toHaveCount(3);
  await expect(page.getByRole("group", { name: "网络", exact: true })).toBeVisible();
  await expect(page.getByText("批量操作", { exact: true })).toHaveCount(0);
  expect(state.sockets).toHaveLength(0);
  const configCount = state.configChains.length;
  state.healthy = true;
  await page.getByRole("button", { name: "重新检测连接", exact: true }).click();
  await expectOnline(page, state, TESTNET);
  expect(state.configChains.length).toBeGreaterThan(configCount);
  await expect.poll(() => state.sockets.at(-1)?.subscriptions.length).toBe(6);
  await expect(page.getByText("批量操作", { exact: true })).toBeVisible();
  expectReadOnly(state);
});

test("10000 online wallets keep subscriptions bounded and move the visible working set", async ({ page, baseURL }) => {
  test.skip(process.env.NADO_ONLINE_10000 !== "1", "Opt-in 10000-wallet read-only online scaling QA");
  test.setTimeout(300_000);
  // Mount more than the subscription limit to exercise the actual 50-wallet cap.
  await page.setViewportSize({ width: 1920, height: 1440 });
  const state = await mockOnline(page, baseURL);
  const password = `online-large-${randomBytes(24).toString("base64url")}`;
  const started = Date.now();
  console.log(JSON.stringify({ stage: "online-10000-deriving", count: 10000 }));
  await createWallets(page, password, 10000);
  await expectOnline(page, state, TESTNET, 10000);
  await expect(page.getByText("10000 / 10000", { exact: true })).toBeVisible();
  const firstMounted = await page.getByTestId("wallet-card").count();
  expect(firstMounted).toBeGreaterThan(50);
  expect(firstMounted).toBeLessThan(100);
  await expect.poll(() => state.sockets.at(-1)?.subscriptions.length, { timeout: 20_000 }).toBe(Math.min(firstMounted, 50) * 2);
  const firstSocket = state.sockets.at(-1)!;
  const firstSet = new Set(firstSocket.subscriptions.map((entry) => entry.subaccount));
  console.log(JSON.stringify({ stage: "online-10000-first-screen", elapsedMs: Date.now() - started, mounted: firstMounted, subscriptions: firstSocket.subscriptions.length }));
  await page.getByTestId("wallet-grid").evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await expect(page.getByTestId("wallet-card").filter({ hasText: "#9999 ·" })).toBeVisible();
  // Initial viewport measurement can already have replaced a socket. Wait for the
  // specific pre-scroll connection to change, rather than an absolute total count.
  await expect.poll(() => state.sockets.at(-1) !== firstSocket).toBe(true);
  const lastMounted = await page.getByTestId("wallet-card").count();
  await expect.poll(() => state.sockets.at(-1)?.subscriptions.length, { timeout: 20_000 }).toBe(Math.min(lastMounted, 50) * 2);
  const lastSocket = state.sockets.at(-1)!;
  expect(lastSocket !== firstSocket).toBe(true);
  expect(lastSocket.subscriptions.every((entry) => !firstSet.has(entry.subaccount))).toBe(true);
  for (const socket of state.sockets) {
    expect(socket.subscriptions.length).toBeLessThanOrEqual(100);
    expect(new Set(socket.subscriptions.map((entry) => entry.subaccount)).size).toBeLessThanOrEqual(50);
  }
  // The steady connection's subscriptions are paced, not dumped in one cold-start burst.
  expect(lastSocket.subscriptions.at(-1)!.at - lastSocket.subscriptions[0]!.at).toBeGreaterThan((lastSocket.subscriptions.length - 1) * 60);
  expectReadOnly(state);
  const report = {
    passed: true, elapsedMs: Date.now() - started, walletCount: 10000, firstMounted, lastMounted,
    connections: state.sockets.length, maxSubscriptionsPerConnection: Math.max(...state.sockets.map((socket) => socket.subscriptions.length)),
    maxWalletsPerConnection: Math.max(...state.sockets.map((socket) => new Set(socket.subscriptions.map((entry) => entry.subaccount)).size)),
    writes: state.writes, unexpected: state.unexpected, authenticatedSockets: state.auth, pageErrors: state.pageErrors,
  };
  console.log(JSON.stringify({ stage: "online-10000-complete", ...report }));
  await writeFile(test.info().outputPath("online-10000-summary.json"), JSON.stringify(report, null, 2));
});
