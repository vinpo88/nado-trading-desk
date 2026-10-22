// Only read-only preflight and local plan operations are exercised. All financial
// HTTP requests are mocked and every external HTTP/WebSocket connection is denied.
// Wallets are generated in a fresh, disposable browser context; no signing action
// or real financial execute is invoked by this test.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const X18 = 10n ** 18n;
const x = (value: number) => (BigInt(value) * X18).toString();
const MARKETS = ["EURUSD-PERP", "GBPUSD-PERP", "USDJPY-PERP"];
const IDS = [92, 94, 96];
const products = IDS.map(product_id => ({ product_id, oracle_price_x18: x(1), risk: {
  long_weight_initial_x18: "975000000000000000", short_weight_initial_x18: "1025000000000000000",
} }));
const symbols = Object.fromEntries(MARKETS.map((symbol, i) => [symbol, {
  symbol, product_id: IDS[i], type: "perp", isolated_only: true, trading_status: "live", market_hours: { is_open: true },
  min_size: x(100), size_increment: x(1), price_increment_x18: "100000000000000",
  maker_fee_rate_x18: "20000000000000", taker_fee_rate_x18: "70000000000000",
}]));

test("trade pilot: ten-wallet preflight, local plan cancellation, safe export and durable history", async ({ page, context, baseURL }) => {
  const password = `trade-pilot-disposable-${randomBytes(20).toString("hex")}`;
  const unexpected: string[] = [], writes: string[] = [];
  const inspected = new Set<string>();
  let insufficientAddress = "", hasEnoughBalance = false;
  let addresses: string[] = [];
  const depositAddresses = new Set<string>();
  await context.addCookies([{ name: "nado-chain-id", value: "57073", url: baseURL! }]);
  await context.routeWebSocket("**/*", socket => {
    // No financial websocket is needed here; allow Next's local development HMR.
    const url = new URL(socket.url());
    const app = new URL(baseURL!);
    if (url.hostname === app.hostname && url.port === app.port && url.pathname.startsWith("/_next/")) socket.connectToServer();
    else { unexpected.push(`websocket:${url.origin}`); socket.close(); }
  });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === "rpc-gel.inkonchain.com") {
      const rpc = request.postDataJSON() as { id: number; method: string; params: unknown[] };
      const reply = (result: string) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }) });
      if (rpc.method === "eth_chainId") return reply("0xdef1");
      if (rpc.method === "eth_getBalance") { expect(String(rpc.params[0]).toLowerCase()).toBe(addresses[0]); return reply(`0x${1_200_000_000_000_000n.toString(16)}`); }
      if (rpc.method === "eth_call") {
        const call = rpc.params[0] as { to: string; data: string };
        expect(call.to.toLowerCase()).toBe("0x0200c29006150606b650577bbe7b6248f58470c1");
        expect(call.data.slice(0, 10)).toBe("0x70a08231");
        expect(`0x${call.data.slice(-40)}`.toLowerCase()).toBe(addresses[0]);
        return reply(`0x${"0".repeat(64)}`); // Save must work even with an empty treasury.
      }
      writes.push(`RPC ${rpc.method}`); return route.abort();
    }
    if (url.origin !== baseURL) { unexpected.push(`external:${url.origin}`); return route.abort(); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const respond = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/nado/state") return respond({ enabled: true, chainId: 57073, endpoint: `0x${"11".repeat(20)}` });
    if (url.pathname === "/api/nado/dda") {
      expect(request.method()).toBe("GET");
      const owner = url.searchParams.get("owner")!.toLowerCase();
      const index = addresses.indexOf(owner); expect(index).toBeGreaterThanOrEqual(0);
      const address = `0x${(1000 + index).toString(16).padStart(40, "0")}`; depositAddresses.add(address);
      return respond({ ok: true, chainId: 57073, owner, subaccount: `${owner}64656661756c740000000000`, address });
    }
    if (url.pathname !== "/api/nado/trade-test-read") {
      writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Financial writes are blocked by this test" }) });
    }
    const body = request.postDataJSON() as { kind: string; chainId: number; query?: Record<string, unknown> };
    expect(body.chainId).toBe(57073);
    const result = (value: unknown) => respond({ chainId: 57073, observedAt: Date.now(), result: value });
    const success = (data: unknown) => result({ status: "success", data });
    if (body.kind === "symbols") return result(symbols);
    const q = body.query;
    if (body.kind !== "query" || !q) { unexpected.push(`read:${body.kind}`); return route.abort(); }
    switch (q.type) {
      case "subaccount_info": {
        const owner = String(q.subaccount).slice(0, 42).toLowerCase();
        inspected.add(owner);
        return success({ subaccount: q.subaccount, exists: true,
          spot_balances: [{ product_id: 0, balance: { amount: !hasEnoughBalance && owner === insufficientAddress ? "0" : x(20) } }],
          perp_balances: [], spot_products: [{ product_id: 0, oracle_price_x18: x(1) }], perp_products: products,
        });
      }
      case "isolated_positions": return success({ isolated_positions: [] });
      case "fee_rates": return success({ health_check_sequencer_fee: "20000000000000000", taker_sequencer_fee: "10000000000000000" });
      case "orders": return success({ sender: q.sender, product_orders: (q.product_ids as number[]).map(product_id => ({ product_id, orders: [] })) });
      case "all_products": return success({ spot_products: [{ product_id: 0 }, { product_id: 11 }], perp_products: products });
      case "symbols": return success({ symbols });
      case "market_price": return success({ product_id: q.product_id, bid_x18: x(1), ask_x18: "1000100000000000000" });
      default: unexpected.push(`query:${String(q.type)}`); return route.abort();
    }
  });

  await page.goto("/accounts");
  await page.getByPlaceholder("输入保险库密码", { exact: true }).fill(password);
  await page.getByPlaceholder("再次输入保险库密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "创建保险库", exact: true }).click();
  await expect(page.getByText("暂无账户", { exact: true })).toBeVisible();
  await page.getByPlaceholder("例如：批量钱包").fill("trade-pilot-disposable");
  await page.getByPlaceholder("输入保险库密码", { exact: true }).fill(password);
  await page.getByLabel("派生钱包数量", { exact: true }).fill("10");
  await page.getByRole("button", { name: "创建账户", exact: true }).click();
  const account = page.getByTestId("account-block");
  await expect(account.getByText("10 个钱包", { exact: true })).toBeVisible();
  const addressDownloadEvent = page.waitForEvent("download");
  await account.getByRole("button", { name: "导出地址", exact: true }).click();
  const addressDownload = await addressDownloadEvent;
  addresses = (await readFile((await addressDownload.path())!, "utf8")).trim().split(/\r?\n/).map(address => address.toLowerCase());
  await addressDownload.delete();
  expect(addresses).toHaveLength(10);
  expect(new Set(addresses).size).toBe(10);
  insufficientAddress = addresses[6]!;

  await page.goto("/trade-test");
  await page.getByPlaceholder("输入保险库密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "解锁", exact: true }).click();
  await expect(page.getByRole("heading", { name: "自动交易测试", exact: true })).toBeVisible();
  const inspect = page.getByRole("button", { name: "只读检查前 10 个钱包", exact: true });
  await inspect.click();
  const preview = page.locator("section").filter({ has: page.getByRole("heading", { name: /预检结果/ }) });
  const preflightRows = preview.getByTestId("preflight-table").locator("tbody tr");
  await expect(preflightRows).toHaveCount(10);
  await expect(preflightRows.nth(6)).toContainText("需充值 · 由资金库自动补足");
  await expect(preflightRows.nth(6)).toContainText("多 / EURUSD-PERP");
  const save = page.getByRole("button", { name: "保存本批计划", exact: true });
  await expect(save).toBeEnabled();
  const fundingPreview = page.getByTestId("preview-funding");
  await expect(fundingPreview).toContainText(new RegExp(addresses[0]!, "i"));
  await expect(fundingPreview).toContainText("还需转入资金库：5.2 USDT0");
  await expect(fundingPreview).toContainText("资金库链上余额：0 USDT0");
  await expect(fundingPreview.locator("tbody tr").nth(6)).toContainText("启动后自动补足");
  expect(depositAddresses.size).toBe(10);
  expect([...inspected].sort()).toEqual([...addresses].sort());
  expect(writes).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("trade-test-insufficient.png"), fullPage: true });

  await expect(preflightRows.nth(0)).toContainText("多 / EURUSD-PERP");
  await expect(preflightRows.nth(1)).toContainText("空 / EURUSD-PERP");
  await page.getByLabel("批次名称", { exact: true }).fill("隔离浏览器验证批次");
  await save.click();
  await expect(page.getByRole("button", { name: "充值到账后开始交易", exact: true })).toBeEnabled();
  await expect(page.getByTestId("saved-funding")).toContainText("本批计划充值：5.2 USDT0");
  expect(writes).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("trade-test-ready.png"), fullPage: true });
  await page.locator("main").evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: test.info().outputPath("trade-test-overview.png"), fullPage: true });

  // Reload must restore the saved plan while requiring a fresh vault unlock.
  await page.reload();
  await page.getByPlaceholder("输入保险库密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "解锁", exact: true }).click();
  await page.getByRole("combobox", { name: "选择批次", exact: true }).selectOption({ label: "隔离浏览器验证批次 · 57073 · 待启动" });
  await expect(page.getByRole("button", { name: "充值到账后开始交易", exact: true })).toBeEnabled();
  await expect(page.getByTestId("saved-funding")).toContainText("本批计划充值：5.2 USDT0");
  await page.getByRole("button", { name: "取消未启动计划", exact: true }).click();
  await expect(page.getByText("未充值、未发送订单，已取消计划", { exact: true })).toBeVisible();
  expect(writes).toEqual([]);

  const reportDownloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出报告", exact: true }).click();
  const reportDownload = await reportDownloadEvent;
  const text = await readFile((await reportDownload.path())!, "utf8");
  await reportDownload.delete();
  const report = JSON.parse(text) as { id: string; status: string; funding: { treasury: { address: string }; rows: Array<{ maxDepositUnits: string; transactionHash?: string }> }; wallets: Array<{ wallet: { address: string }; orders: unknown[] }> };
  expect(report.status).toBe("completed");
  expect(report.wallets).toHaveLength(10);
  expect(report.wallets.map(item => item.wallet.address.toLowerCase())).toEqual(addresses);
  expect(report.wallets.every(item => item.orders.length === 0)).toBe(true);
  expect(report.funding.treasury.address.toLowerCase()).toBe(addresses[0]);
  expect(report.funding.rows).toHaveLength(10);
  expect(report.funding.rows[6]!.maxDepositUnits).toBe("5200000");
  expect(report.funding.rows.every(row => !row.transactionHash)).toBe(true);
  expect(text).not.toMatch(/"(?:signature|rawTransaction|payload|privateKey|mnemonic|password)"\s*:/i);
  expect(text).not.toContain(password);

  hasEnoughBalance = true;
  await page.getByRole("button", { name: "只读检查前 10 个钱包", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存本批计划", exact: true })).toBeEnabled();
  await expect(page.getByTestId("preflight-table").getByText("通过", { exact: true })).toHaveCount(10);
  await expect(page.getByTestId("preview-funding")).toContainText("本批计划充值：0 USDT0");

  await page.reload();
  await page.getByPlaceholder("输入保险库密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "解锁", exact: true }).click();
  await page.getByRole("combobox", { name: "选择批次", exact: true }).selectOption(report.id);
  await expect(page.getByText("未充值、未发送订单，已取消计划", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "取消未启动计划", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "恢复核对并继续", exact: true })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath("trade-test-cancelled-history.png"), fullPage: true });

  // Render a legacy paused journal in the disposable browser only. No resume or
  // financial button is clicked: these writes are test fixtures, not live records.
  const fixtureHash = `0x${"ad".repeat(32)}`;
  const fixtureTime = Date.now() - 600_000;
  await page.evaluate(async ({ id, hash, at }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("nado-trade-test-v1", 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("runs", "readwrite"), store = tx.objectStore("runs"), request = store.get(id);
      request.onsuccess = () => {
        const run = request.result;
        run.status = "paused"; run.message = 'Block at number "59166064" could not be found.'; run.updatedAt = at + 5000;
        delete run.progress; delete run.events;
        run.funding.status = "paused"; run.funding.message = run.message;
        run.wallets.forEach((row: { status: string; message?: string }) => { row.status = "pending"; delete row.message; });
        Object.assign(run.funding.rows[0], { status: "broadcast", baselineX18: "5956275930735356621", amountUnits: "5000000", maxDepositUnits: "5000000", broadcastStartedAt: at, transaction: { hash, rawTransaction: "never-render-fixture-raw" } });
        store.put(run);
      };
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { id: report.id, hash: fixtureHash, at: fixtureTime });
  const overview = page.getByTestId("execution-overview");
  await expect(overview).toContainText("执行已暂停，不会继续新充值或开仓");
  await expect(overview).toContainText("节点暂时读不到该区块，不等于转账失败");
  await expect(overview).toContainText("1 / 10");
  await expect(overview).toContainText("链上已确认 0 笔");
  await expect(overview).toContainText("Nado 已到账 0 户");
  await expect(page.getByTestId("execution-timeline")).toContainText("旧批次根据已保存的充值和订单记录还原");
  await expect(page.getByTestId("order-details")).toContainText("尚未保存或发送交易订单");
  await expect(page.getByTestId("saved-funding").locator("tbody tr").first()).toContainText("5.956275930735356621");
  await expect(page.getByTestId("saved-funding").getByRole("link")).toHaveAttribute("href", `https://explorer.inkonchain.com/tx/${fixtureHash}`);
  await page.getByTestId("execution-section").scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("trade-test-legacy-paused-monitor.png"), fullPage: true });

  // A newer persisted snapshot must refresh the monitor without a page reload.
  // Filled notional (40 U) is deliberately different from requested quantity (100).
  await page.evaluate(async ({ id, at }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("nado-trade-test-v1", 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("runs", "readwrite"), store = tx.objectStore("runs"), request = store.get(id);
      request.onsuccess = () => {
        const run = request.result, wallet = run.wallets[0], digest = `0x${"ce".repeat(32)}`;
        run.updatedAt = at + 610_000; run.status = "paused"; run.message = "测试记录：等待核对实际成交";
        run.progress = { phase: "closing", at: run.updatedAt, walletId: wallet.wallet.id, message: "正在核对剩余仓位" };
        run.events = [{ id: "display-fixture", phase: "closing", at: run.updatedAt, walletId: wallet.wallet.id, message: "已记录部分成交，准备核对余仓", kind: "progress", orderDigest: digest }];
        run.funding.status = "completed";
        run.funding.rows.forEach((row: { status: string }, i: number) => { row.status = i ? "skipped" : "credited"; });
        Object.assign(run.funding.rows[0], { creditedAt: at + 600_000, creditedEventAt: at + 2000, confirmedAt: at + 1000, actualFeeWei: "1000000000", receipt: { hash: run.funding.rows[0].transaction.hash, status: "success", blockTimestampMs: at + 1000 } });
        wallet.status = "closing";
        wallet.orders = [{ prepared: { digest, sender: wallet.wallet.address, productId: 92, side: "buy", amountX18: "100000000000000000000", priceX18: "1000000000000000000", reduceOnly: false, expiresAt: at + 60_000, payload: { signature: "never-render-fixture-signature" } }, preparedAt: at + 3000, broadcastStartedAt: at + 4000, acknowledgedAt: at + 5000 }];
        wallet.reports = [{ digest, indexed: true, volumeX18: "40000000000000000000", feeX18: "2000000000000000", realizedPnlX18: "0" }];
        store.put(run);
      };
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { id: report.id, at: fixtureTime });
  await expect(overview).toContainText("正在核对剩余仓位");
  await expect(overview).not.toContainText("Block at number");
  await expect(page.getByTestId("saved-funding")).not.toContainText("Block at number");
  await expect(page.getByTestId("saved-funding")).toContainText("链上确认至入账：1.0 秒");
  await expect(page.getByTestId("saved-funding")).toContainText("核验用时：600.0 秒（含暂停）");
  await expect(page.getByTestId("order-details")).toContainText("已有归档成交");
  await expect(page.getByTestId("order-details")).toContainText("40 / 0.002");
  await expect(page.getByTestId("execution-timeline")).toContainText("已记录部分成交，准备核对余仓");
  await expect(page.locator("body")).not.toContainText("never-render-fixture");
  await page.screenshot({ path: test.info().outputPath("trade-test-partial-fill-monitor.png"), fullPage: true });
  await page.getByTestId("order-details").screenshot({ path: test.info().outputPath("trade-test-order-details.png") });
  await page.getByTestId("saved-funding").screenshot({ path: test.info().outputPath("trade-test-funding-evidence.png") });
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
});
