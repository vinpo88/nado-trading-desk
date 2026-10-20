import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { keccak256, recoverMessageAddress, recoverTypedDataAddress, stringToHex, type Hex } from "viem";
import { validateRequest } from "../../../../apps/console/app/lib/walletConnectPolicy";
import { executeApprovedRequest, prepareTransaction } from "../../../../apps/console/app/lib/walletConnectSigning";

const custody = vi.hoisted(() => ({ unlocked: true, evm: null as any, signer: null as any }));
vi.mock("../../../../apps/console/app/lib/custody", () => ({
  isUnlocked: () => custody.unlocked,
  evmAddressForWalletId: () => custody.evm,
  signerForWalletId: () => custody.signer,
}));

// All keys, RPC replies and signed transactions here are disposable in-memory fixtures.
describe("WalletConnect approved request execution", () => {
  let account: ReturnType<typeof privateKeyToAccount>;
  let address: Hex;
  let methods: string[];
  let nonce: number;
  let signed: number;
  let onSigned: (() => void) | undefined;
  let rpcFailure: string | undefined;
  const to = "0x0000000000000000000000000000000000000011";
  beforeEach(() => {
    account = privateKeyToAccount(generatePrivateKey()); address = account.address.toLowerCase() as Hex;
    custody.unlocked = true; methods = []; nonce = 7; signed = 0; onSigned = undefined; rpcFailure = undefined;
    custody.signer = {
      signDigest: vi.fn(async (hash: Hex) => { signed++; const signature = await account.sign({ hash }); onSigned?.(); return signature; }),
      signTypedData: vi.fn(async (data: any) => { signed++; const signature = await account.signTypedData(data); onSigned?.(); return signature; }),
    };
    custody.evm = {
      publicKey: address,
      buildTransaction: vi.fn((tx: any) => {
        const built = {
          rawTransaction: null as Hex | null,
          sign: vi.fn(async () => {
            signed++;
            built.rawTransaction = await account.signTransaction({
              chainId: tx.chainId, to: tx.to, value: tx.value, data: tx.data, nonce: tx.nonce,
              gas: tx.gasLimit, type: tx.type === 2 ? "eip1559" : "legacy",
              ...(tx.type === 2 ? { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas } : { gasPrice: tx.gasPrice }),
            });
            onSigned?.();
            return built;
          }),
        };
        return built;
      }),
    };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, input: RequestInit) => {
      const request = JSON.parse(input.body as string); methods.push(request.method);
      if (request.method === rpcFailure) return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, error: { message: "untrusted provider detail" } }) };
      const results: Record<string, unknown> = {
        eth_chainId: "0xdef1", eth_getTransactionCount: `0x${nonce.toString(16)}`,
        eth_getBlockByNumber: { baseFeePerGas: "0x64" }, eth_maxPriorityFeePerGas: "0x2",
        eth_gasPrice: "0x100", eth_estimateGas: "0x5208", eth_getBalance: "0xde0b6b3a7640000", eth_call: "0x",
      };
      const result = request.method === "eth_sendRawTransaction" ? keccak256(request.params[0]) : results[request.method];
      return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  function login() {
    const message = createSiweMessage({ address, chainId: 57073, domain: "app.nado.xyz", nonce: "test12345678", uri: "https://app.nado.xyz/", version: "1" });
    return { message, review: validateRequest("personal_sign", [stringToHex(message), address], address) };
  }
  function transaction(extra: Record<string, unknown> = {}) { return validateRequest("eth_sendTransaction", [{ from: address, to, value: "0x1", ...extra }], address); }

  it("uses EIP-191 over decoded message bytes and never calls a network for login", async () => {
    const { message, review } = login();
    const signature = await executeApprovedRequest(review, "live:0", address) as Hex;
    expect((await recoverMessageAddress({ message, signature })).toLowerCase()).toBe(address);
    expect(methods).toEqual([]); expect(signed).toBe(1);
    await expect(executeApprovedRequest(review, "live:0", address)).rejects.toThrow(/已处理/);
    expect(signed).toBe(1);
  });
  it("discards signatures if the vault locks during signing", async () => {
    const { review } = login(); onSigned = () => { custody.unlocked = false; };
    await expect(executeApprovedRequest(review, "live:0", address)).rejects.toThrow(/锁定/);
    expect(methods).toEqual([]);
  });
  it("signs typed authorization only for the pinned owner and verifies recovery", async () => {
    const typedData = {
      domain: { name: "Nado", version: "0.0.1", chainId: 57073, verifyingContract: to },
      primaryType: "LinkSigner", types: { LinkSigner: [{ name: "sender", type: "bytes32" }, { name: "signer", type: "bytes32" }, { name: "nonce", type: "uint64" }] },
      message: { sender: `${address}${"0".repeat(24)}`, signer: `0x${"2".repeat(64)}`, nonce: "1" },
    } as const;
    const review = validateRequest("eth_signTypedData_v4", [address, typedData], address);
    const signature = await executeApprovedRequest(review, "live:0", address) as Hex;
    expect((await recoverTypedDataAddress({ ...typedData, signature })).toLowerCase()).toBe(address);
    expect(methods).toEqual([]); expect(signed).toBe(1);
  });
  it("rejects an address/session change during signing even after re-unlocking", async () => {
    const { review } = login(); onSigned = () => { custody.evm = { ...custody.evm }; };
    await expect(executeApprovedRequest(review, "live:0", address)).rejects.toThrow(/会话已发生变化/);
  });
  it("prepares by public reads only, then signs exactly the approved fee/nonce fields", async () => {
    const prepared = await prepareTransaction(transaction(), "live:0", address);
    expect(signed).toBe(0); expect(methods).not.toContain("eth_sendRawTransaction");
    expect(prepared.transaction).toMatchObject({ nonce: 7, gas: 25200n, maxFeePerGas: 202n, maxPriorityFeePerGas: 2n });
    expect(Object.isFrozen(prepared.transaction)).toBe(true);
    const result = await executeApprovedRequest(prepared, "live:0", address);
    expect(result).toMatch(/^0x[0-9a-f]{64}$/); expect(signed).toBe(1);
    expect(methods.filter(method => method === "eth_sendRawTransaction")).toHaveLength(1);
    expect(custody.evm.buildTransaction).toHaveBeenCalledWith(expect.objectContaining({ chainId: 57073, nonce: 7, gasLimit: 25200n, maxFeePerGas: 202n, maxPriorityFeePerGas: 2n }));
    await expect(executeApprovedRequest(prepared, "live:0", address)).rejects.toThrow(/已处理/);
  });
  it("requires another review after nonce changes, without signing or broadcasting", async () => {
    const prepared = await prepareTransaction(transaction(), "live:0", address); nonce++;
    await expect(executeApprovedRequest(prepared, "live:0", address)).rejects.toThrow(/序号已变化/);
    expect(signed).toBe(0); expect(methods).not.toContain("eth_sendRawTransaction");
  });
  it("checks nonce again after signing before broadcast", async () => {
    const prepared = await prepareTransaction(transaction(), "live:0", address); onSigned = () => { nonce++; };
    await expect(executeApprovedRequest(prepared, "live:0", address)).rejects.toThrow(/签名期间交易序号已变化/);
    expect(signed).toBe(1); expect(methods).not.toContain("eth_sendRawTransaction");
  });
  it("refuses a transaction signed by a different key before broadcasting", async () => {
    const prepared = await prepareTransaction(transaction(), "live:0", address);
    account = privateKeyToAccount(generatePrivateKey());
    await expect(executeApprovedRequest(prepared, "live:0", address)).rejects.toThrow(/签名钱包不匹配/);
    expect(methods).not.toContain("eth_sendRawTransaction");
  });
  it("refuses a signed transaction with changed fields", async () => {
    const prepared = await prepareTransaction(transaction(), "live:0", address);
    const originalBuild = custody.evm.buildTransaction;
    custody.evm.buildTransaction = (tx: any) => originalBuild({ ...tx, value: 2n });
    await expect(executeApprovedRequest(prepared, "live:0", address)).rejects.toThrow(/已审核内容不一致/);
    expect(methods).not.toContain("eth_sendRawTransaction");
  });
  it("rejects stale approvals and aborted requests before signing", async () => {
    const { review } = login();
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 91_000);
    await expect(executeApprovedRequest(review, "live:0", address)).rejects.toThrow(/90 秒/);
    vi.useRealTimers();
    const controller = new AbortController(); controller.abort();
    await expect(executeApprovedRequest(login().review, "live:0", address, { signal: controller.signal })).rejects.toThrow(/取消/);
    expect(signed).toBe(0);
  });
  it("rejects simulation failures and excessive gas budgets without signing", async () => {
    rpcFailure = "eth_call";
    await expect(prepareTransaction(transaction(), "live:0", address)).rejects.toThrow(/模拟失败/);
    rpcFailure = undefined;
    await expect(prepareTransaction(transaction({ gas: "0x1000000", maxFeePerGas: "0x2540be400", maxPriorityFeePerGas: "0x2" }), "live:0", address)).rejects.toThrow(/0.01 ETH/);
    expect(signed).toBe(0); expect(methods).not.toContain("eth_sendRawTransaction");
  });
  it("never retries an ambiguous broadcast result", async () => {
    const prepared = await prepareTransaction(transaction(), "live:0", address); rpcFailure = "eth_sendRawTransaction";
    await expect(executeApprovedRequest(prepared, "live:0", address)).rejects.toThrow(/提交状态需要核实/);
    await expect(executeApprovedRequest(prepared, "live:0", address)).rejects.toThrow(/已处理/);
    expect(methods.filter(method => method === "eth_sendRawTransaction")).toHaveLength(1);
  });
});
