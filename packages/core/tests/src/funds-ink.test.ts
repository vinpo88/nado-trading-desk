import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Hex } from "viem";
import {
  authorizationTypedData, createInkFundsAdapter, encodeAuthorization, expectedUsdt0DomainSeparator,
  parseInkFundsReceipt, receiptFeeWei, simulateInkSponsoredTransfer, USDT0_FUNDS_ABI,
  verifyAuthorizationSignature, verifyPreparedRawTransaction, verifyUsdt0Metadata,
} from "../../../../apps/console/app/lib/funds/inkAdapter";
import { INK_CHAIN_ID, USDT0_ADDRESS, type FundsAuthorization } from "../../../../apps/console/app/lib/funds/types";

const custody = vi.hoisted(() => ({ unlocked: false }));
vi.mock("../../../../apps/console/app/lib/custody", () => ({
  isUnlocked: () => custody.unlocked,
  cohortWallets: vi.fn(() => { throw new Error("test must not read user custody"); }),
  signerForWalletId: vi.fn(() => { throw new Error("test must not sign with user custody"); }),
  evmAddressForWalletId: vi.fn(() => { throw new Error("test must not unlock user custody"); }),
}));

async function fixture() {
  const holder = privateKeyToAccount(generatePrivateKey());
  const payer = privateKeyToAccount(generatePrivateKey());
  const recipient = privateKeyToAccount(generatePrivateKey());
  const authorization: FundsAuthorization = {
    from: holder.address, to: recipient.address, value: "1000000", validAfter: "100", validBefore: "1000",
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  authorization.signature = await holder.signTypedData(authorizationTypedData(authorization));
  const tx = { from: payer.address, data: encodeAuthorization(authorization), nonce: 7, gas: 130_000n, maxFeePerGas: 1_000_562n, maxPriorityFeePerGas: 1_000_000n };
  const signed = await payer.signTransaction({ chainId: INK_CHAIN_ID, type: "eip1559", to: USDT0_ADDRESS,
    data: tx.data, nonce: tx.nonce, gas: tx.gas, value: 0n, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas });
  return { holder, payer, recipient, authorization, tx, signed };
}
function receipt(a: FundsAuthorization) {
  return {
    transactionHash: `0x${"aa".repeat(32)}`, blockHash: `0x${"bb".repeat(32)}`, status: "0x1", blockNumber: "0x100", gasUsed: "0x1a1a3", effectiveGasPrice: "0xf4359", l1Fee: "0x3b9aca00",
    logs: [
      { address: USDT0_ADDRESS, topics: encodeEventTopics({ abi: USDT0_FUNDS_ABI, eventName: "Transfer", args: { from: a.from, to: a.to } }), data: encodeAbiParameters([{ type: "uint256" }], [BigInt(a.value)]) },
      { address: USDT0_ADDRESS, topics: encodeEventTopics({ abi: USDT0_FUNDS_ABI, eventName: "AuthorizationUsed", args: { authorizer: a.from, nonce: a.nonce } }), data: "0x" },
    ],
  };
}
afterEach(() => { vi.unstubAllGlobals(); });
describe("Ink sponsored USDT0 transaction invariants", () => {
  it("uses the verified mainnet token domain, failing closed on each mismatched field", () => {
    expect(() => verifyUsdt0Metadata("USD₮0", 6, expectedUsdt0DomainSeparator())).not.toThrow();
    expect(() => verifyUsdt0Metadata("USDT0", 6, expectedUsdt0DomainSeparator())).toThrow(/签名域/);
    expect(() => verifyUsdt0Metadata("USD₮0", 18, expectedUsdt0DomainSeparator())).toThrow(/精度/);
    expect(() => verifyUsdt0Metadata("USD₮0", 6, `0x${"0".repeat(64)}`)).toThrow(/签名域/);
  });
  it("accepts 1 USDT0 and the smallest 6-decimal unit, but never zero or rounded amounts", async () => {
    const { authorization } = await fixture();
    expect(authorizationTypedData(authorization).message.value).toBe(1_000_000n);
    expect(authorizationTypedData({ ...authorization, value: "1" }).message.value).toBe(1n);
    for (const value of ["0", "0.1", "-1", "01", "1e6"]) expect(() => authorizationTypedData({ ...authorization, value })).toThrow();
  });
  it("recovers the holder without an approval, binding amount, recipient, nonce and validity", async () => {
    const { authorization, payer } = await fixture();
    await expect(verifyAuthorizationSignature(authorization)).resolves.toBeUndefined();
    for (const change of [{ value: "1000001" }, { to: payer.address }, { nonce: `0x${"ab".repeat(32)}` as Hex }, { validBefore: "1001" }]) {
      await expect(verifyAuthorizationSignature({ ...authorization, ...change })).rejects.toThrow(/签名/);
    }
  });
  it("rejects an authorization signed over another chain domain", async () => {
    const { holder, authorization } = await fixture();
    const td = authorizationTypedData(authorization);
    authorization.signature = await holder.signTypedData({ ...td, domain: { ...td.domain, chainId: 56 } });
    await expect(verifyAuthorizationSignature(authorization)).rejects.toThrow(/签名/);
  });
  it("verifies the exact treasury-signed raw bytes and computes their local hash", async () => {
    const { signed, tx } = await fixture();
    await expect(verifyPreparedRawTransaction(signed, tx)).resolves.toBe(keccak256(signed));
    for (const change of [{ nonce: 8 }, { gas: 131_000n }, { maxFeePerGas: 9n }, { data: "0x" as Hex }]) {
      await expect(verifyPreparedRawTransaction(signed, { ...tx, ...change })).rejects.toThrow(/不一致/);
    }
  });
  it("rejects a valid transaction signature by a different relayer", async () => {
    const { signed, tx, holder } = await fixture();
    await expect(verifyPreparedRawTransaction(signed, { ...tx, from: holder.address })).rejects.toThrow(/地址不匹配/);
  });
  it("rejects a different chain or native-ETH payment in serialized bytes", async () => {
    const { payer, tx } = await fixture();
    for (const change of [{ chainId: 56, value: 0n }, { chainId: INK_CHAIN_ID, value: 1n }]) {
      const raw = await payer.signTransaction({ ...change, type: "eip1559", to: USDT0_ADDRESS, data: tx.data, nonce: tx.nonce, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas });
      await expect(verifyPreparedRawTransaction(raw, tx)).rejects.toThrow(/不一致/);
    }
  });
  it("extracts exact token transfers and nonce use, and charges both execution and L1 fees", async () => {
    const { authorization } = await fixture();
    const raw = receipt(authorization); const parsed = parseInkFundsReceipt(raw, 1_800_000_000_000);
    expect(parsed.transfers).toHaveLength(1); expect(parsed.transfers[0]?.value).toBe("1000000");
    expect(parsed.authorizations[0]?.nonce).toBe(authorization.nonce);
    expect(receiptFeeWei(parsed)).toBe(BigInt(raw.gasUsed) * BigInt(raw.effectiveGasPrice) + 1_000_000_000n);
  });
  it("never treats missing L1 fee as zero or ignores a reverted transaction", async () => {
    const { authorization } = await fixture(); const raw = receipt(authorization);
    expect(() => parseInkFundsReceipt({ ...raw, l1Fee: undefined }, 1_800_000_000_000)).toThrow(/l1Fee/);
    expect(parseInkFundsReceipt({ ...raw, status: "0x0" }, 1_800_000_000_000).status).toBe("reverted");
  });
  it("does not accept spoofed Transfer events emitted by another token", async () => {
    const { authorization, holder } = await fixture(); const raw = receipt(authorization);
    raw.logs[0]!.address = holder.address;
    expect(parseInkFundsReceipt(raw, 1_800_000_000_000).transfers).toEqual([]);
  });
  it("cannot broadcast when locked, or broadcast restored bytes without full plan validation", async () => {
    vi.stubGlobal("document", { cookie: "nado-chain-id=57073" });
    const { signed } = await fixture(); const adapter = createInkFundsAdapter();
    const fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
    custody.unlocked = false;
    await expect(adapter.broadcast(signed)).rejects.toThrow(/锁定/);
    custody.unlocked = true;
    await expect(adapter.broadcast(signed)).rejects.toThrow(/恢复核验/);
    expect(fetchSpy).not.toHaveBeenCalled(); custody.unlocked = false;
  });
});

describe("Ink receipt recovery across lagging RPC backends", () => {
  type Request = { id: number; method: string; params: unknown[] };
  function mockRpc(result: (request: Request) => unknown) {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      expect(new URL(url).origin).toBe("https://rpc-gel.inkonchain.com");
      const request = JSON.parse(String(init.body)) as Request;
      expect(["eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_blockNumber", "eth_getLogs"]).toContain(request.method);
      requests.push(request);
      const value = result(request);
      return Response.json({ jsonrpc: "2.0", id: request.id, result: value });
    });
    return requests;
  }
  function block(number = 256n, blockHash = `0x${"bb".repeat(32)}`) {
    return { number: toHex(number), hash: blockHash, timestamp: toHex(100n + number), transactions: [] };
  }
  it("retries an explicit null block once and confirms only the original receipt", async () => {
    const { authorization } = await fixture(), raw = receipt(authorization);
    let blocks = 0;
    const requests = mockRpc(request => {
      if (request.method === "eth_getTransactionReceipt") return raw;
      if (request.method === "eth_blockNumber") return "0x101";
      return ++blocks === 1 ? null : block();
    });
    const result = await createInkFundsAdapter().getReceipt(raw.transactionHash as Hex);
    expect(result?.hash).toBe(raw.transactionHash);
    expect(result?.blockTimestampMs).toBe(356_000);
    expect(blocks).toBe(2);
    expect(requests.filter(r => r.method === "eth_getTransactionReceipt").map(r => r.params)).toEqual([[raw.transactionHash]]);
  });
  it("returns pending after bounded missing-block retries, then resumes the same hash", async () => {
    const { authorization } = await fixture(), raw = receipt(authorization);
    let blockAvailable = false;
    const requests = mockRpc(request => {
      if (request.method === "eth_getTransactionReceipt") return raw;
      if (request.method === "eth_blockNumber") return "0x101";
      return blockAvailable ? block() : null;
    });
    const adapter = createInkFundsAdapter();
    await expect(adapter.getReceipt(raw.transactionHash as Hex)).resolves.toBeNull();
    expect(requests.filter(r => r.method === "eth_getBlockByNumber")).toHaveLength(2);
    blockAvailable = true;
    const result = await adapter.getReceipt(raw.transactionHash as Hex);
    expect(result?.hash).toBe(raw.transactionHash);
    expect(requests.filter(r => r.method === "eth_getTransactionReceipt").map(r => r.params)).toEqual([[raw.transactionHash], [raw.transactionHash]]);
  });
  it.each([
    ["different hash", block(256n, `0x${"cc".repeat(32)}`)],
    ["different number", block(257n)],
  ])("does not confirm a block with %s", async (_label, wrongBlock) => {
    const { authorization } = await fixture(), raw = receipt(authorization);
    mockRpc(request => request.method === "eth_getTransactionReceipt" ? raw : request.method === "eth_blockNumber" ? "0x102" : wrongBlock);
    await expect(createInkFundsAdapter().getReceipt(raw.transactionHash as Hex)).resolves.toBeNull();
  });
  it("reads a fresh tip on every confirmation check instead of caching the first height", async () => {
    const { authorization } = await fixture(), raw = receipt(authorization);
    let tipReads = 0;
    mockRpc(request => request.method === "eth_getTransactionReceipt" ? raw : request.method === "eth_blockNumber" ? toHex(255n + BigInt(++tipReads)) : block());
    const adapter = createInkFundsAdapter();
    await expect(adapter.getReceipt(raw.transactionHash as Hex)).resolves.toBeNull();
    expect((await adapter.getReceipt(raw.transactionHash as Hex))?.hash).toBe(raw.transactionHash);
    expect(tipReads).toBe(2);
  });
  it("does not swallow unknown RPC failures as a missing block", async () => {
    const { authorization } = await fixture(), raw = receipt(authorization);
    mockRpc(request => {
      if (request.method === "eth_getTransactionReceipt") return raw;
      if (request.method === "eth_blockNumber") return "0x101";
      throw new Error("unexpected RPC failure");
    });
    await expect(createInkFundsAdapter().getReceipt(raw.transactionHash as Hex)).rejects.toThrow();
  });
  it("keeps an authorization scan pending if its latest block is temporarily absent", async () => {
    const { authorization } = await fixture();
    const requests = mockRpc(() => null);
    await expect(createInkFundsAdapter().findAuthorizationReceipt(authorization, 280_000)).resolves.toBeNull();
    expect(requests).toHaveLength(2);
    expect(requests.every(r => r.method === "eth_getBlockByNumber" && r.params[0] === "latest")).toBe(true);
  });
  it("resumes a missing historical scan block and returns the original authorization transaction", async () => {
    const { authorization } = await fixture(), raw = receipt(authorization);
    let historicalAvailable = false;
    const requests = mockRpc(request => {
      if (request.method === "eth_getTransactionReceipt") return raw;
      if (request.method === "eth_blockNumber") return "0x104";
      if (request.method === "eth_getLogs") return [{ ...raw.logs[1], transactionHash: raw.transactionHash, blockNumber: "0x100", blockHash: raw.blockHash, logIndex: "0x1", transactionIndex: "0x0", removed: false }];
      const number = request.params[0] === "latest" ? 260n : BigInt(String(request.params[0]));
      if (number === 0n && !historicalAvailable) return null;
      return block(number);
    });
    const adapter = createInkFundsAdapter();
    await expect(adapter.findAuthorizationReceipt(authorization, 280_000)).resolves.toBeNull();
    expect(requests.filter(r => r.method === "eth_getBlockByNumber" && r.params[0] === "0x0")).toHaveLength(2);
    historicalAvailable = true;
    const result = await adapter.findAuthorizationReceipt(authorization, 280_000);
    expect(result?.hash).toBe(raw.transactionHash);
    expect(result?.authorizations[0]?.nonce).toBe(authorization.nonce);
    expect(requests.filter(r => r.method === "eth_getTransactionReceipt").map(r => r.params)).toEqual([[raw.transactionHash]]);
  });
});

// Explicit opt-in read-only integration check. No real wallet key, transaction or state write.
describe.skipIf(process.env.NADO_READONLY_SIMULATION !== "1")("Ink public-RPC disposable-account simulation", () => {
  it("estimates a 1 USDT0 authorization with a zero-ETH source and separate gas payer", async () => {
    // Optional Windows system-proxy transport for hosts where Node cannot reach the
    // public RPC. The strict method allowlist makes this bridge read-only as well.
    if (process.env.NADO_READONLY_RPC_VIA_POWERSHELL === "1") {
      const { spawn } = await import("node:child_process");
      const allowed = new Set(["eth_chainId", "eth_call", "eth_getBlockByNumber", "eth_gasPrice", "eth_estimateGas"]);
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        if (new URL(url).origin !== "https://rpc-gel.inkonchain.com") throw new Error("readonly test RPC origin rejected");
        const request = JSON.parse(String(init.body));
        if (!allowed.has(request.method)) throw new Error("readonly test RPC method rejected");
        const output = await new Promise<string>((resolve, reject) => {
          const command = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $payload=[Console]::In.ReadToEnd(); $response=Invoke-RestMethod -Uri 'https://rpc-gel.inkonchain.com' -Method Post -ContentType 'application/json' -Body $payload -TimeoutSec 30; $response | ConvertTo-Json -Depth 30 -Compress";
          const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true });
          let stdout = ""; let stderr = "";
          child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; });
          child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { stderr += chunk; });
          child.on("error", reject); child.on("close", code => { if (code === 0) resolve(stdout); else reject(new Error(`readonly RPC transport failed: ${stderr.slice(0, 200)}`)); });
          child.stdin.end(JSON.stringify(request));
        });
        return new Response(output, { status: 200, headers: { "content-type": "application/json" } });
      });
    }
    const result = await simulateInkSponsoredTransfer();
    console.info("Read-only Ink 1 USDT0 / zero-ETH holder sample:", JSON.stringify(result));
    expect(result.amountUnits).toBe("1000000"); expect(result.sourceEthWei).toBe("0");
    expect(BigInt(result.gasUnits)).toBeGreaterThan(50_000n);
    expect(BigInt(result.estimatedFeeWei)).toBe(BigInt(result.executionFeeWei) + BigInt(result.l1FeeWei));
  }, 90_000);
});
