// Real sealed browser signing with newly generated, unfunded test wallets.
// Every non-local HTTP request is intercepted; no mainnet transaction can leave this test.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, hashDomain, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, toHex, type Hex, type TransactionSerialized } from "viem";

const TOKEN = "0x0200C29006150606B650577BBE7B6248F58470c1";
const ABI = parseAbi([
  "function name() view returns (string)", "function decimals() view returns (uint8)", "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function balanceOf(address owner) view returns (uint256)", "function authorizationState(address authorizer,bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)",
  "event Transfer(address indexed from,address indexed to,uint256 value)", "event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)",
  "function getL1Fee(bytes data) view returns (uint256)", "function getL1FeeUpperBound(uint256 txSize) view returns (uint256)",
]);
const domain = hashDomain({ domain: { name: "USD₮0", version: "1", chainId: 57073n, verifyingContract: TOKEN }, types: { EIP712Domain: [
  { name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
] } });
const blockHash = `0x${"ab".repeat(32)}`;

test("funds: sealed zero-ETH cycle, durable journal and preview-only batch planning", async ({ page, context, baseURL }) => {
  const password = `funds-disposable-${randomBytes(20).toString("hex")}`;
  const balances = new Map<string, bigint>();
  const ethBalances = new Map<string, bigint>();
  const receipts = new Map<string, Record<string, unknown>>();
  const used = new Set<string>();
  const sends: Array<{ from: string; to: string; amount: bigint; payer: string }> = [];
  const unexpected: string[] = [];
  let treasury = "", nonce = 0, holdFirstReceipt = true;
  await context.addCookies([{ name: "nado-chain-id", value: "57073", url: baseURL! }]);
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === baseURL) return route.continue();
    if (url.hostname !== "rpc-gel.inkonchain.com") { unexpected.push(url.origin); return route.abort(); }
    const body = route.request().postDataJSON() as { id: number; method: string; params: any[] };
    body.params ??= [];
    const reply = (result: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) });
    const [first] = body.params;
    switch (body.method) {
      case "eth_chainId": return reply(toHex(57073));
      case "eth_getBalance": return reply(toHex(ethBalances.get(String(first).toLowerCase()) ?? 0n));
      case "eth_gasPrice": return reply(toHex(1_000_000n));
      case "eth_getTransactionCount": return reply(toHex(nonce));
      case "eth_blockNumber": return reply("0x65");
      case "eth_getBlockByNumber": return reply({ number: "0x64", hash: blockHash, timestamp: toHex(Math.floor(Date.now() / 1000)), baseFeePerGas: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x186a0", transactions: [] });
      case "eth_estimateGas": return reply(toHex(100_000n));
      case "eth_getTransactionReceipt": return reply(holdFirstReceipt ? null : receipts.get(String(first).toLowerCase()) ?? null);
      case "eth_getTransactionByHash": return reply(receipts.has(String(first).toLowerCase()) ? { hash: first } : null);
      case "eth_call": {
        const call = decodeFunctionData({ abi: ABI, data: first.data });
        switch (call.functionName) {
          case "name": return reply(encodeFunctionResult({ abi: ABI, functionName: "name", result: "USD₮0" }));
          case "decimals": return reply(encodeFunctionResult({ abi: ABI, functionName: "decimals", result: 6 }));
          case "DOMAIN_SEPARATOR": return reply(encodeFunctionResult({ abi: ABI, functionName: "DOMAIN_SEPARATOR", result: domain }));
          case "balanceOf": return reply(encodeFunctionResult({ abi: ABI, functionName: "balanceOf", result: body.params[2] ? 2_000_000n : balances.get(call.args[0].toLowerCase()) ?? 0n }));
          case "authorizationState": return reply(encodeFunctionResult({ abi: ABI, functionName: "authorizationState", result: used.has(`${call.args[0].toLowerCase()}:${call.args[1].toLowerCase()}`) }));
          case "getL1Fee": return reply(encodeFunctionResult({ abi: ABI, functionName: "getL1Fee", result: 100_000n }));
          case "getL1FeeUpperBound": return reply(encodeFunctionResult({ abi: ABI, functionName: "getL1FeeUpperBound", result: 150_000n }));
          case "transferWithAuthorization": return reply("0x");
        }
        break;
      }
      case "eth_sendRawTransaction": {
        const raw = first as Hex, txHash = keccak256(raw);
        if (receipts.has(txHash)) return reply(txHash);
        const decoded = parseTransaction(raw);
        const payer = (await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized })).toLowerCase();
        expect(payer).toBe(treasury); expect(decoded.nonce).toBe(nonce); expect(decoded.chainId).toBe(57073);
        const call = decodeFunctionData({ abi: ABI, data: decoded.data! });
        if (call.functionName !== "transferWithAuthorization") throw Error("Unexpected signed call");
        const [from, to, amount, , , authNonce] = call.args;
        expect(amount).toBe(1_000_000n);
        const key = `${from.toLowerCase()}:${authNonce.toLowerCase()}`;
        expect(used.has(key)).toBe(false); used.add(key);
        balances.set(from.toLowerCase(), balances.get(from.toLowerCase())! - amount);
        balances.set(to.toLowerCase(), (balances.get(to.toLowerCase()) ?? 0n) + amount);
        ethBalances.set(treasury, ethBalances.get(treasury)! - 100_000_100_000n);
        sends.push({ from: from.toLowerCase(), to: to.toLowerCase(), amount, payer }); nonce++;
        receipts.set(txHash, {
          transactionHash: txHash, blockNumber: "0x64", blockHash, status: "0x1", from: payer,
          gasUsed: toHex(100_000n), effectiveGasPrice: toHex(1_000_000n), l1Fee: toHex(100_000n),
          logs: [
            { address: TOKEN, data: encodeAbiParameters([{ type: "uint256" }], [amount]), topics: encodeEventTopics({ abi: ABI, eventName: "Transfer", args: { from, to } }) },
            { address: TOKEN, data: "0x", topics: encodeEventTopics({ abi: ABI, eventName: "AuthorizationUsed", args: { authorizer: from, nonce: authNonce } }) },
          ],
        });
        return reply(txHash);
      }
    }
    unexpected.push(body.method);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Unmocked test RPC" } }) });
  });

  await page.goto("/accounts");
  await page.getByPlaceholder("输入保险库密码", { exact: true }).fill(password);
  await page.getByPlaceholder("再次输入保险库密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "创建保险库", exact: true }).click();
  await expect(page.getByText("暂无账户", { exact: true })).toBeVisible();
  await page.getByPlaceholder("例如：批量钱包").fill("funds-disposable");
  await page.getByPlaceholder("输入保险库密码", { exact: true }).fill(password);
  await page.getByLabel("派生钱包数量", { exact: true }).fill("3");
  await page.getByRole("button", { name: "创建账户", exact: true }).click();
  const account = page.getByTestId("account-block");
  await expect(account.getByText("3 个钱包", { exact: true })).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await account.getByRole("button", { name: "导出地址", exact: true }).click();
  const download = await downloadEvent;
  const addresses = (await readFile((await download.path())!, "utf8")).trim().split(/\r?\n/).map(a => a.toLowerCase());
  await download.delete();
  treasury = addresses[0]!;
  addresses.forEach(a => { balances.set(a, 0n); ethBalances.set(a, 0n); });
  balances.set(treasury, 3_000_000n); ethBalances.set(treasury, 1_000_000_000_000_000n);

  await page.goto("/funds");
  await page.getByPlaceholder("输入保险库密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "解锁", exact: true }).click();
  await expect(page.getByRole("heading", { name: "批次资金交接", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "预检并查看完整地址", exact: true }).click();
  const start = page.getByRole("button", { name: "启动 1 USDT0 循环测试", exact: true });
  await expect(start).toBeDisabled(); expect(sends).toHaveLength(0);
  await page.screenshot({ path: test.info().outputPath("funds-preflight.png"), fullPage: true });
  await page.getByRole("checkbox").check();
  await start.click();
  // Simulate closing the document after the node accepted leg 1 but before any
  // receipt reached the engine. The restarted page must reconcile the saved hash.
  await expect.poll(() => sends.length).toBe(1);
  await page.reload();
  holdFirstReceipt = false;
  await page.getByPlaceholder("输入保险库密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "解锁", exact: true }).click();
  const resume = page.getByRole("button", { name: "核对原交易并恢复", exact: true });
  await expect(resume).toBeVisible();
  expect(sends).toHaveLength(1);
  await resume.click();
  await expect(page.getByText("3 / 3 笔已核实到账", { exact: true })).toBeVisible({ timeout: 45_000 });
  await page.screenshot({ path: test.info().outputPath("funds-completed.png"), fullPage: true });
  expect(sends.map(s => [s.from, s.to])).toEqual([[addresses[0], addresses[1]], [addresses[1], addresses[2]], [addresses[2], addresses[0]]]);
  expect(balances.get(treasury)).toBe(3_000_000n);
  expect(ethBalances.get(addresses[1]!)).toBe(0n); expect(ethBalances.get(addresses[2]!)).toBe(0n);
  await page.reload();
  await page.getByPlaceholder("输入保险库密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "解锁", exact: true }).click();
  await expect(page.getByText("3 / 3 笔已核实到账", { exact: true })).toBeVisible();
  expect(sends).toHaveLength(3);
  await expect(page.getByRole("button", { name: "核对原交易并恢复", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "交易结束后交给下一批", exact: true }).click();
  await page.getByLabel("来源起始钱包号", { exact: true }).fill("1");
  await page.getByLabel("目标起始钱包号", { exact: true }).fill("2");
  await page.getByLabel("每批钱包数", { exact: true }).fill("1");
  await page.getByRole("button", { name: "预览交接规划", exact: true }).click();
  await expect(page.getByText("规划尚不可执行；钱包数量和交易策略确定后，再连接批次完成信号。", { exact: true })).toBeVisible();
  await expect(start).toHaveCount(0); expect(sends).toHaveLength(3);
  expect(unexpected).toEqual([]);
});
