import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserFundingAdapter } from "../../../../apps/console/app/lib/tradeTest/fundingAdapter";
import type { TestWallet, TradeTestAdapter } from "../../../../apps/console/app/lib/tradeTest/types";

const wallet: TestWallet = { id: "public-read", address: `0x${"12".repeat(20)}`, label: "read" };
const dda = `0x${"34".repeat(20)}`;
const endpoint = `0x${"56".repeat(20)}`;
const parent = `${wallet.address}64656661756c740000000000`;
const trade = {} as TradeTestAdapter;
const event = () => ({ subaccount: parent, product_id: 0, event_type: "deposit_collateral", isolated: false, submission_idx: "123",
  pre_balance: { spot: { product_id: 0, balance: { amount: "0" } } }, post_balance: { spot: { product_id: 0, balance: { amount: "5999999999999999999" } } } });

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const document = { cookie: "nado-chain-id=57073" };
  vi.stubGlobal("document", document);
  const response = { ok: true, address: dda, owner: wallet.address, chainId: 57073, subaccount: parent };
  const data = { chainId: 57073, observedAt: Date.now(), result: { events: [event()], txs: [{ submission_idx: "123", tx: "execute_slow_mode", timestamp: "1792637467" }] } };
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); requests.push(url);
    if (url === "/api/nado/state") return Response.json({ enabled: true, chainId: 57073, endpoint });
    if (url.startsWith("/api/nado/dda?owner=")) return Response.json(response);
    if (url === "/api/nado/trade-test-read") {
      expect(JSON.parse(String(init?.body))).toEqual({ chainId: 57073, kind: "depositEvents", subaccount: parent });
      return Response.json(data);
    }
    throw new Error(`Unexpected non-read request: ${url}`);
  });
  return { document, response, data, requests, adapter: createBrowserFundingAdapter(trade) };
}

describe("funding public read adapter", () => {
  it("delegates credit-only balance reads without a full trading snapshot", async () => {
    fixture();
    const fundingBalance = vi.fn(async () => ({ parentSender: parent, quoteBalanceX18: "7100000000000000000", observedAt: Date.now() }));
    const snapshot = vi.fn(async () => { throw new Error("full snapshot must not be used for credit"); });
    const adapter = createBrowserFundingAdapter({ ...trade, fundingBalance, snapshot });
    expect((await adapter.fundingBalance(wallet)).quoteBalanceX18).toBe("7100000000000000000");
    expect(fundingBalance).toHaveBeenCalledTimes(1);
    expect(fundingBalance).toHaveBeenCalledWith(wallet);
    expect(snapshot).not.toHaveBeenCalled();
    await expect(createBrowserFundingAdapter(trade).fundingBalance(wallet)).rejects.toThrow("余额读取器不可用");
  });
  it("rejects a network change during a credit balance read", async () => {
    const f = fixture();
    const fundingBalance = async () => {
      f.document.cookie = "nado-chain-id=763373";
      return { parentSender: parent, quoteBalanceX18: "7100000000000000000", observedAt: Date.now() };
    };
    await expect(createBrowserFundingAdapter({ ...trade, fundingBalance }).fundingBalance(wallet)).rejects.toThrow("主网");
  });
  it("binds each DDA to the exact default account and selected mainnet", async () => {
    const f = fixture();
    expect(await f.adapter.getDepositAddress(wallet)).toBe(dda);
    f.response.owner = `0x${"99".repeat(20)}`;
    await expect(f.adapter.getDepositAddress(wallet)).rejects.toThrow("不匹配");
    f.response.owner = wallet.address; f.response.subaccount = `0x${"00".repeat(32)}`;
    await expect(f.adapter.getDepositAddress(wallet)).rejects.toThrow("不匹配");
    f.document.cookie = "nado-chain-id=763373";
    await expect(f.adapter.getDepositAddress(wallet)).rejects.toThrow("主网");
  });
  it("parses real execute_slow_mode deposit-event shape including one-wei normalization", async () => {
    const f = fixture();
    expect(await f.adapter.depositEvents(wallet)).toEqual([{ submissionIndex: "123", at: 1792637467000, deltaX18: "5999999999999999999" }]);
    f.data.result.events = []; f.data.result.txs = [];
    expect(await f.adapter.depositEvents(wallet)).toEqual([]);
  });
  it("rejects mismatched account, product, duplicate and stale archive evidence", async () => {
    const f = fixture();
    f.data.result.events[0]!.subaccount = `0x${"00".repeat(32)}`;
    await expect(f.adapter.depositEvents(wallet)).rejects.toThrow("不匹配");
    f.data.result.events = [event()]; f.data.result.events[0]!.product_id = 1;
    await expect(f.adapter.depositEvents(wallet)).rejects.toThrow("不匹配");
    f.data.result.events = [event(), event()];
    await expect(f.adapter.depositEvents(wallet)).rejects.toThrow("不匹配");
    f.data.result.events = [event()]; f.data.observedAt = 1;
    await expect(f.adapter.depositEvents(wallet)).rejects.toThrow("时间");
  });
});

// Opt-in public reads against the running console; no custody functions, keys,
// signature methods or financial RPC methods are reachable through this guard.
it.skipIf(process.env.NADO_FUNDING_READ_SMOKE !== "1")("checks actual DDA, archive and treasury reads without signing", async () => {
  const address = process.env.NADO_FUNDING_READ_ADDRESS;
  expect(address).toMatch(/^0x[\da-fA-F]{40}$/);
  const target: TestWallet = { id: "read-only", address: address as `0x${string}`, label: "public" };
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("document", { cookie: "nado-chain-id=57073" });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/nado/dda?owner=") || url === "/api/nado/state" || url === "/api/nado/trade-test-read") {
      if (url.endsWith("trade-test-read")) expect(JSON.parse(String(init?.body)).kind).toBe("depositEvents");
      return originalFetch(`http://127.0.0.1:18270${url}`, { ...init, headers: { "content-type": "application/json", cookie: "nado-chain-id=57073" } });
    }
    if (url === "https://rpc-gel.inkonchain.com" || url === "https://rpc-gel.inkonchain.com/") {
      const body = JSON.parse(String(init?.body));
      for (const call of Array.isArray(body) ? body : [body]) {
        expect(["eth_call", "eth_getBalance", "eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_blockNumber"]).toContain(call.method);
        if (call.method === "eth_call") expect(call.params[0].data.startsWith("0x70a08231")).toBe(true);
      }
      return originalFetch(input, init);
    }
    throw new Error(`Live smoke MUST NOT sign, broadcast or execute: ${url}`);
  });
  const adapter = createBrowserFundingAdapter(trade);
  const destination = await adapter.getDepositAddress(target);
  expect(destination).toMatch(/^0x[\da-fA-F]{40}$/);
  const events = await adapter.depositEvents(target), balances = await adapter.readTreasury(target);
  console.log(JSON.stringify({ address, depositAddress: destination, depositEvents: events.length, newestDepositIndex: events[0]?.submissionIndex, tokenUnits: balances.tokenUnits, ethWei: balances.ethWei }));
  const transactionHash = process.env.NADO_FUNDING_READ_TRANSACTION;
  if (transactionHash) {
    expect(transactionHash).toMatch(/^0x[\da-fA-F]{64}$/);
    const receipt = await adapter.funds.getReceipt(transactionHash as `0x${string}`);
    expect(receipt?.hash).toBe(transactionHash.toLowerCase());
    expect(receipt?.status).toBe("success");
    expect(receipt?.transfers.some(t => t.from.toLowerCase() === address!.toLowerCase() && t.to.toLowerCase() === destination.toLowerCase())).toBe(true);
    console.log(JSON.stringify({ verifiedTransaction: receipt!.hash, blockNumber: receipt!.blockNumber,
      blockTimestampMs: receipt!.blockTimestampMs, gasUsed: receipt!.gasUsed, effectiveGasPrice: receipt!.effectiveGasPrice, l1FeeWei: receipt!.l1FeeWei }));
  }
}, 60_000);
