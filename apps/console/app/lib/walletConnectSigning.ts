import { formatEther, hashMessage, keccak256, parseTransaction, recoverMessageAddress, recoverTransactionAddress, recoverTypedDataAddress, toHex, type Hex, type TransactionSerialized } from "viem";
import type { Eip712TypedData } from "@farm/adapter-api";
import { evmAddressForWalletId, isUnlocked, signerForWalletId, type InTabEvmAddress } from "./custody";
import { freezeReview, INK_CHAIN_ID, MAX_GAS_BUDGET, MAX_TRANSACTION_VALUE, policyError, REVIEW_MAX_AGE_MS, validateRequest, validAddress, WalletConnectPolicyError, type PreparedRequest, type TransactionPayload } from "./walletConnectPolicy";

const INK_RPC = "https://rpc-gel.inkonchain.com";
const INK_CHAIN_HEX = "0xdef1";
interface Options { signal?: AbortSignal }
export interface ApprovedTransaction extends TransactionPayload {
  nonce: number; gas: bigint;
}
export type ReadyTransactionRequest = Extract<PreparedRequest, { kind: "transaction" }> & {
  preparedAt: number; transaction: ApprovedTransaction; simulation: string;
};
const readyTransactions = new WeakSet<object>();
const consumedRequests = new WeakSet<object>();
const executingWallets = new Set<string>();
type Guard = () => InTabEvmAddress;

function guardFor(review: PreparedRequest, walletId: string, pinnedAddress: string, options: Options): Guard {
  const address = validAddress(pinnedAddress);
  if (review.address !== address) policyError("审核钱包与连接钱包不一致，请重新连接。");
  let initial: InTabEvmAddress | undefined;
  const guard = () => {
    if (options.signal?.aborted) policyError("请求已取消，请在官网重新发起。");
    if (!isUnlocked()) policyError("保险库已锁定，请解锁后重新发起请求。");
    if (Date.now() - review.createdAt > REVIEW_MAX_AGE_MS || review.createdAt > Date.now() + 1000) policyError("此审核已超过 90 秒，请重新发起并确认。");
    let current: InTabEvmAddress;
    try { current = evmAddressForWalletId(walletId); } catch { return policyError("当前钱包已不可用，请重新连接。"); }
    if (validAddress(current.publicKey) !== address || initial && current !== initial) policyError("钱包或保险库会话已发生变化，请重新连接并审核。");
    initial = current;
    return current;
  };
  guard();
  return guard;
}
async function checked<T>(operation: () => Promise<T>, guard: Guard): Promise<T> {
  guard();
  try { const result = await operation(); guard(); return result; }
  catch (error) { guard(); throw error; }
}
async function rpc(method: string, params: unknown[], guard: Guard, options: Options): Promise<unknown> {
  const timeout = AbortSignal.timeout(15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const response = await checked(() => fetch(INK_RPC, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal,
    }), guard);
    if (!response.ok) policyError("Ink 节点请求失败，请稍后重新发起并审核。");
    const body: unknown = await checked(() => response.json(), guard);
    if (!body || typeof body !== "object" || Array.isArray(body)) policyError("Ink 节点返回了无效结果。");
    const result = body as Record<string, unknown>;
    if (result.error || !Object.hasOwn(result, "result") || result.id !== 1 || result.jsonrpc !== "2.0") {
      if (method === "eth_call" || method === "eth_estimateGas") policyError("交易模拟失败或合约拒绝执行，已停止签名。");
      policyError("Ink 节点未能完成请求，请稍后重新发起并审核。");
    }
    return result.result;
  } catch (error) {
    if (error instanceof WalletConnectPolicyError) throw error;
    guard();
    return policyError("无法完成 Ink 节点请求，请检查网络后重新发起并审核。");
  }
}
function rpcQuantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) || value.length > 66) policyError("Ink 节点返回的整数格式无效。");
  return BigInt(value);
}
async function ensureChain(guard: Guard, options: Options) {
  if (rpcQuantity(await checked(() => rpc("eth_chainId", [], guard, options), guard)) !== BigInt(INK_CHAIN_ID)) policyError("节点链号与 Ink 主网不符，已停止处理。");
}
async function pendingNonce(address: Hex, guard: Guard, options: Options): Promise<number> {
  const nonce = rpcQuantity(await checked(() => rpc("eth_getTransactionCount", [address, "pending"], guard, options), guard));
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) policyError("交易序号过大。");
  return Number(nonce);
}
function feeCap(tx: ApprovedTransaction): bigint {
  const fee = tx.type === 0 ? tx.gasPrice : tx.maxFeePerGas;
  if (fee === undefined || fee <= 0n) policyError("交易费用上限无效。");
  return fee;
}
function rpcTransaction(tx: TransactionPayload): Record<string, string> {
  const result: Record<string, string> = { from: tx.from, to: tx.to, value: toHex(tx.value), data: tx.data, type: toHex(tx.type) };
  for (const key of ["gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas", "nonce"] as const) if (tx[key] !== undefined) result[key] = toHex(tx[key]);
  return result;
}
function gasBudget(tx: ApprovedTransaction): bigint {
  if (tx.value < 0n || tx.value > MAX_TRANSACTION_VALUE) policyError("单笔 ETH 金额不能超过 0.005 ETH。");
  const budget = tx.gas * feeCap(tx);
  if (tx.gas <= 0n || budget > MAX_GAS_BUDGET) policyError("此交易的 gas 费用上限超过 0.01 ETH，已停止处理。");
  return budget;
}

/** Public RPC reads only. The final nonce, gas and fees are frozen before user confirmation. */
export async function prepareTransaction(review: PreparedRequest, walletId: string, pinnedAddress: string, options: Options = {}): Promise<ReadyTransactionRequest> {
  if (review.kind !== "transaction") policyError("此请求不是可准备的交易。");
  const guard = guardFor(review, walletId, pinnedAddress, options);
  await checked(() => ensureChain(guard, options), guard);
  const nonce = await checked(() => pendingNonce(review.address, guard, options), guard);
  if (review.payload.nonce !== undefined && review.payload.nonce !== nonce) policyError("网站提供的交易序号已变化，请在官网重新发起交易。");
  const tx: ApprovedTransaction = { ...review.payload, nonce, gas: review.payload.gas ?? 0n };
  if (tx.type === 2) {
    const block = await checked(() => rpc("eth_getBlockByNumber", ["latest", false], guard, options), guard);
    if (!block || typeof block !== "object" || Array.isArray(block)) policyError("无法读取 Ink 当前基础费用。");
    const baseFee = rpcQuantity((block as Record<string, unknown>).baseFeePerGas);
    tx.maxPriorityFeePerGas ??= rpcQuantity(await checked(() => rpc("eth_maxPriorityFeePerGas", [], guard, options), guard));
    tx.maxFeePerGas ??= baseFee * 2n + tx.maxPriorityFeePerGas;
    if (tx.maxFeePerGas < baseFee || tx.maxFeePerGas < tx.maxPriorityFeePerGas) policyError("交易费用上限不足，请在官网重新发起交易。");
  } else tx.gasPrice ??= rpcQuantity(await checked(() => rpc("eth_gasPrice", [], guard, options), guard));
  const estimateInput = rpcTransaction(tx);
  if (review.payload.gas === undefined) delete estimateInput.gas;
  const estimated = rpcQuantity(await checked(() => rpc("eth_estimateGas", [estimateInput], guard, options), guard));
  if (estimated <= 0n) policyError("节点返回的 gas 估算无效。");
  if (review.payload.gas !== undefined && review.payload.gas < estimated) policyError("网站提供的 gas 上限不足，请重新发起交易。");
  tx.gas = review.payload.gas ?? (estimated * 120n + 99n) / 100n;
  const budget = gasBudget(tx);
  const balance = rpcQuantity(await checked(() => rpc("eth_getBalance", [review.address, "pending"], guard, options), guard));
  if (balance < tx.value + budget) policyError("钱包 ETH 余额不足以支付金额与 gas 费用上限。");
  const simulation = await checked(() => rpc("eth_call", [rpcTransaction(tx), "pending"], guard, options), guard);
  if (typeof simulation !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(simulation)) policyError("节点返回的模拟结果无效。");
  const feeDetails = tx.type === 2
    ? `最高单价：${tx.maxFeePerGas} wei/gas\n优先费单价：${tx.maxPriorityFeePerGas} wei/gas`
    : `gas 单价：${tx.gasPrice} wei/gas`;
  const prepared: ReadyTransactionRequest = freezeReview({
    ...review, preparedAt: Date.now(), transaction: tx, simulation: "Ink 节点模拟通过",
    details: `${review.details}\n\n交易序号（nonce）：${nonce}\ngas 上限：${tx.gas}\n${feeDetails}\ngas 费用上限：${formatEther(budget)} ETH\nETH 金额 + gas 上限：${formatEther(tx.value + budget)} ETH\nInk 可能另收 L1 数据费，此处未计入。\n模拟：通过；模拟不保证实际执行结果或合约安全。\n审核有效期：自请求创建起 90 秒；序号变化需重新审核。`,
  });
  readyTransactions.add(prepared);
  return prepared;
}

function ready(value: PreparedRequest | ReadyTransactionRequest): asserts value is ReadyTransactionRequest {
  if (!readyTransactions.has(value)) policyError("交易尚未完成费用准备与模拟，请重新发起并审核。");
}
function verifySignedTransaction(raw: Hex, tx: ApprovedTransaction) {
  const decoded = parseTransaction(raw);
  const expectedType = tx.type === 2 ? "eip1559" : "legacy";
  if (decoded.chainId !== INK_CHAIN_ID || decoded.type !== expectedType || decoded.nonce !== tx.nonce || decoded.gas !== tx.gas || (decoded.to ?? "").toLowerCase() !== tx.to || (decoded.value ?? 0n) !== tx.value || (decoded.data ?? "0x").toLowerCase() !== tx.data ||
    (tx.type === 2 && (decoded.maxFeePerGas !== tx.maxFeePerGas || decoded.maxPriorityFeePerGas !== tx.maxPriorityFeePerGas)) || (tx.type === 0 && decoded.gasPrice !== tx.gasPrice)) policyError("签名交易与已审核内容不一致，已停止广播。");
}

/** Call only after the bridge has received explicit approval for this exact review. */
export async function executeApprovedRequest(prepared: PreparedRequest | ReadyTransactionRequest, walletId: string, pinnedAddress: string, options: Options = {}): Promise<string | string[] | null> {
  const guard = guardFor(prepared, walletId, pinnedAddress, options);
  if (prepared.kind === "read") {
    if (prepared.method === "eth_accounts" || prepared.method === "eth_requestAccounts") return [prepared.address];
    if (prepared.method === "eth_chainId") return INK_CHAIN_HEX;
    if (prepared.method === "net_version") return String(INK_CHAIN_ID);
    return policyError("不支持此读取请求。");
  }
  if (prepared.kind === "switchChain") return null;
  if (consumedRequests.has(prepared) || executingWallets.has(prepared.address)) policyError("此请求已处理，或此钱包仍有请求正在处理；请勿重复确认。");
  consumedRequests.add(prepared);
  executingWallets.add(prepared.address);
  let broadcastAttempted = false;
  let transactionHash: Hex | undefined;
  try {
    if (prepared.kind === "login") {
      // Recheck SIWE validity at approval time, preserving the original message bytes.
      validateRequest(prepared.method, [prepared.payload.messageHex, prepared.address], prepared.address);
      guard();
      const signer = signerForWalletId(walletId);
      if (!signer.signDigest) policyError("当前钱包不支持标准登录签名。");
      const digest = hashMessage({ raw: prepared.payload.messageHex });
      const signature = await checked(() => signer.signDigest!(digest), guard);
      const recovered = await checked(() => recoverMessageAddress({ message: { raw: prepared.payload.messageHex }, signature }), guard);
      if (validAddress(recovered) !== prepared.address) policyError("登录签名验证失败，已停止返回签名。");
      return signature;
    }
    if (prepared.kind === "typedData") {
      validateRequest(prepared.method, [prepared.address, prepared.payload.typedData], prepared.address);
      guard();
      const signer = signerForWalletId(walletId);
      if (!signer.signTypedData) policyError("当前钱包不支持结构化签名。");
      const signature = await checked(() => signer.signTypedData!(prepared.payload.typedData as unknown as Eip712TypedData, INK_CHAIN_ID), guard);
      const recovered = await checked(() => recoverTypedDataAddress({ ...prepared.payload.typedData, signature }), guard);
      if (validAddress(recovered) !== prepared.address) policyError("结构化签名验证失败，已停止返回签名。");
      return signature;
    }
    ready(prepared);
    if (Date.now() - prepared.preparedAt > REVIEW_MAX_AGE_MS) policyError("交易费用审核已过期，请重新准备并确认。");
    const tx = prepared.transaction;
    gasBudget(tx);
    await checked(() => ensureChain(guard, options), guard);
    if (await checked(() => pendingNonce(prepared.address, guard, options), guard) !== tx.nonce) policyError("交易序号已变化，原审核已失效。请重新准备交易并再次确认。");
    const evm = guard();
    const built = evm.buildTransaction({
      to: tx.to, value: tx.value, data: tx.data, nonce: tx.nonce, gasLimit: tx.gas,
      type: tx.type, gasPrice: tx.gasPrice, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      chainId: INK_CHAIN_ID as never, rpcUrl: INK_RPC,
    });
    await checked(() => built.sign(), guard);
    const raw = built.rawTransaction;
    if (typeof raw !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(raw)) policyError("钱包未返回有效的已签名交易。");
    verifySignedTransaction(raw as Hex, tx);
    const recovered = await checked(() => recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized }), guard);
    if (validAddress(recovered) !== prepared.address) policyError("交易签名钱包不匹配，已停止广播。");
    transactionHash = keccak256(raw as Hex);
    if (await checked(() => pendingNonce(prepared.address, guard, options), guard) !== tx.nonce) policyError("签名期间交易序号已变化，已停止广播。请重新准备并确认。");
    guard();
    // From this point any failure is ambiguous: never retry an approved transaction automatically.
    broadcastAttempted = true;
    const result = await checked(() => rpc("eth_sendRawTransaction", [raw], guard, options), guard);
    if (typeof result !== "string" || result.toLowerCase() !== transactionHash) policyError("节点返回的交易哈希与本地计算结果不一致。");
    return transactionHash;
  } catch (error) {
    if (broadcastAttempted) policyError(`交易提交状态需要核实；不会自动重发。请用此哈希在 Ink 浏览器查询：${transactionHash ?? "未知"}`);
    if (error instanceof WalletConnectPolicyError) throw error;
    policyError("钱包未能完成此请求，未广播交易。请重新发起并审核。");
  } finally { executingWallets.delete(prepared.address); }
}
