/** Browser-only Ink USDT0 relayer. Nothing in this module runs on import.
 * Preparation signs in the unlocked browser vault; it never broadcasts. The engine
 * must persist the exact prepared bytes/hash before invoking broadcast(). */
import {
  BlockNotFoundError, createPublicClient, decodeEventLog, decodeFunctionData, encodeFunctionData,
  encodeAbiParameters, hashDomain, http, isAddress, keccak256, parseAbi, parseTransaction,
  recoverTransactionAddress, recoverTypedDataAddress, serializeTransaction,
  toHex, type Address, type Hex as ViemHex, type TransactionSerialized,
} from "viem";
import type { Eip712TypedData } from "@farm/adapter-api";
import { subaccountToHex } from "@nadohq/client";
import { activeChainId } from "../chainEnv";
import { cohortWallets, evmAddressForWalletId, isUnlocked, signerForWalletId } from "../custody";
import { getLiveConfig } from "../liveConfig";
import {
  INK_CHAIN_ID, USDT0_ADDRESS,
  type FundsAdapter, type FundsAuthorization, type FundsLeg, type FundsPlan,
  type FundsPreparedTransaction, type FundsReceipt, type FundsWallet, type Hex,
} from "./types";

export const INK_FUNDS_RPC = "https://rpc-gel.inkonchain.com";
export const INK_GAS_ORACLE = "0x420000000000000000000000000000000000000F" as const;
export const USDT0_DOMAIN = {
  name: "USD₮0", version: "1", chainId: INK_CHAIN_ID, verifyingContract: USDT0_ADDRESS,
} as const;
export const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" },
    { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
} as const;
const DOMAIN_TYPES = { EIP712Domain: [
  { name: "name", type: "string" }, { name: "version", type: "string" },
  { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
] } as const;
export const USDT0_FUNDS_ABI = parseAbi([
  "function name() view returns (string)", "function decimals() view returns (uint8)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function balanceOf(address owner) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)",
]);
const ORACLE_ABI = parseAbi([
  "function getL1Fee(bytes data) view returns (uint256)",
  "function getL1FeeUpperBound(uint256 txSize) view returns (uint256)",
]);
const UINT256_MAX = (1n << 256n) - 1n;
const RELAY_QUERY = "/api/nado/relay/query";
const CONFIRMATIONS = 2n;
const MAX_LOG_SCAN_BLOCKS = 20_000n;
const BLOCK_READ_ATTEMPTS = 2;

function address(value: string): Address {
  if (!isAddress(value, { strict: false }) || /^0x0{40}$/i.test(value)) throw new Error("资金交接地址无效。");
  return value.toLowerCase() as Address;
}
function uint(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${field}格式无效。`);
  const result = BigInt(value);
  if (result > UINT256_MAX) throw new Error(`${field}超出范围。`);
  return result;
}
function quantity(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) || value.length > 66) throw new Error(`${field}返回格式无效。`);
  return BigInt(value);
}
function hash(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("交易哈希或授权序号格式无效。");
  return value.toLowerCase() as Hex;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}返回格式无效。`);
  return value as Record<string, unknown>;
}
function assertMainnetSelection(): void {
  if (activeChainId() !== INK_CHAIN_ID) throw new Error("资金交接只支持 Ink 主网，请先切换主网。");
}
function assertPlan(plan: FundsPlan): void {
  assertMainnetSelection();
  if (plan.chainId !== INK_CHAIN_ID || plan.token.toLowerCase() !== USDT0_ADDRESS.toLowerCase()) throw new Error("交接计划的网络或代币不匹配。");
  address(plan.treasury.address);
  if (!plan.legs.length) throw new Error("交接计划没有转账。");
}
function assertAuthorization(a: FundsAuthorization): void {
  address(a.from); address(a.to); hash(a.nonce);
  if (a.from.toLowerCase() === a.to.toLowerCase()) throw new Error("转出与接收钱包必须不同。");
  if (uint(a.value, "转账金额") < 1n) throw new Error("最小转账数量是 0.000001 USDT0。");
  if (uint(a.validAfter, "授权开始时间") >= uint(a.validBefore, "授权到期时间")) throw new Error("授权有效期无效。");
}
export function authorizationTypedData(a: FundsAuthorization) {
  assertAuthorization(a);
  return {
    domain: USDT0_DOMAIN, types: AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization" as const,
    message: { from: address(a.from), to: address(a.to), value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: hash(a.nonce) },
  };
}
export function expectedUsdt0DomainSeparator(): Hex { return hashDomain({ domain: { ...USDT0_DOMAIN, chainId: BigInt(INK_CHAIN_ID) }, types: DOMAIN_TYPES }); }
export function verifyUsdt0Metadata(name: unknown, decimals: unknown, separator: unknown): void {
  if (name !== USDT0_DOMAIN.name || Number(decimals) !== 6 || hash(separator) !== expectedUsdt0DomainSeparator()) {
    throw new Error("USDT0 合约名称、精度或签名域与 Ink 主网不一致，已停止签名。");
  }
}
function assertLeg(plan: FundsPlan, leg: FundsLeg, a: FundsAuthorization): void {
  assertPlan(plan); assertAuthorization(a);
  if (!plan.legs.some(candidate => candidate.id === leg.id)
    || address(a.from) !== address(leg.from.address) || address(a.to) !== address(leg.to.address)
    || (leg.amount.kind === "fixed" && uint(leg.amount.units, "计划金额") !== BigInt(a.value))) throw new Error("授权与固定交接计划不一致。");
  if (BigInt(a.validBefore) - BigInt(a.validAfter) > BigInt(plan.limits.authorizationTtlSeconds + 120)) throw new Error("授权有效期超过计划上限。");
}
export async function verifyAuthorizationSignature(a: FundsAuthorization): Promise<void> {
  if (!a.signature || !/^0x[0-9a-fA-F]{130}$/.test(a.signature)) throw new Error("缺少有效的持币钱包授权签名。");
  const recovered = await recoverTypedDataAddress({ ...authorizationTypedData(a), signature: a.signature });
  if (address(recovered) !== address(a.from)) throw new Error("授权签名不能匹配持币钱包，已停止处理。");
}
export function encodeAuthorization(a: FundsAuthorization): Hex {
  assertAuthorization(a);
  if (!a.signature) throw new Error("缺少授权签名。");
  return encodeFunctionData({ abi: USDT0_FUNDS_ABI, functionName: "transferWithAuthorization", args: [address(a.from), address(a.to), BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), hash(a.nonce), a.signature] });
}
interface FrozenTransaction {
  from: Address; data: Hex; nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint;
}
/** Decode every spend-bearing field, then recover the relayer and calculate the hash locally. */
export async function verifyPreparedRawTransaction(raw: Hex, expected: FrozenTransaction): Promise<Hex> {
  const decoded = parseTransaction(raw);
  if (decoded.type !== "eip1559" || decoded.chainId !== INK_CHAIN_ID
    || address(decoded.to ?? "") !== address(USDT0_ADDRESS) || (decoded.value ?? 0n) !== 0n
    || decoded.data?.toLowerCase() !== expected.data.toLowerCase() || decoded.nonce !== expected.nonce
    || decoded.gas !== expected.gas || decoded.maxFeePerGas !== expected.maxFeePerGas
    || decoded.maxPriorityFeePerGas !== expected.maxPriorityFeePerGas || (decoded.accessList?.length ?? 0) !== 0) {
    throw new Error("资金库签名交易与准备内容不一致，已停止广播。");
  }
  const sender = await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized });
  if (address(sender) !== address(expected.from)) throw new Error("资金库交易签名地址不匹配。");
  return keccak256(raw);
}
export function receiptFeeWei(receipt: Pick<FundsReceipt, "gasUsed" | "effectiveGasPrice" | "l1FeeWei">): bigint {
  return uint(receipt.gasUsed, "gasUsed") * uint(receipt.effectiveGasPrice, "effectiveGasPrice") + uint(receipt.l1FeeWei, "l1FeeWei");
}
/** Refuse incomplete receipt data: absent L1 fee is unknown, never silently zero. */
export function parseInkFundsReceipt(rawValue: unknown, blockTimestampMs: number): FundsReceipt {
  const raw = object(rawValue, "交易回执");
  const status = quantity(raw.status, "status");
  if (status !== 0n && status !== 1n) throw new Error("交易状态无效。");
  if (!Array.isArray(raw.logs) || !Number.isSafeInteger(blockTimestampMs) || blockTimestampMs <= 0) throw new Error("交易回执缺少日志或时间。");
  const result: FundsReceipt = {
    hash: hash(raw.transactionHash), status: status === 1n ? "success" : "reverted",
    blockNumber: quantity(raw.blockNumber, "blockNumber").toString(), blockTimestampMs,
    gasUsed: quantity(raw.gasUsed, "gasUsed").toString(), effectiveGasPrice: quantity(raw.effectiveGasPrice, "effectiveGasPrice").toString(),
    l1FeeWei: quantity(raw.l1Fee, "l1Fee").toString(), transfers: [], authorizations: [],
  };
  for (const value of raw.logs) {
    const log = object(value, "日志");
    if (String(log.address).toLowerCase() !== USDT0_ADDRESS.toLowerCase()) continue;
    if (log.removed === true || !Array.isArray(log.topics) || !log.topics.length || typeof log.data !== "string") throw new Error("代币日志格式无效。");
    try {
      const parsed = decodeEventLog({ abi: USDT0_FUNDS_ABI, topics: log.topics as [ViemHex, ...ViemHex[]], data: log.data as ViemHex, strict: true });
      if (parsed.eventName === "Transfer") result.transfers.push({ token: USDT0_ADDRESS, from: parsed.args.from, to: parsed.args.to, value: parsed.args.value.toString() });
      if (parsed.eventName === "AuthorizationUsed") result.authorizations.push({ authorizer: parsed.args.authorizer, nonce: parsed.args.nonce });
    } catch { /* unrelated token events do not prove a transfer; the engine verifies both required events */ }
  }
  return result;
}

export function createInkFundsAdapter(): FundsAdapter {
  const client = createPublicClient({ transport: http(INK_FUNDS_RPC, { timeout: 15_000, retryCount: 0 }) });
  const validatedTransactions = new Map<Hex, { guard: () => unknown; at: number }>();
  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const response = await fetch(INK_FUNDS_RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("Ink 节点暂时不可用，请恢复时先核查原交易。");
    const body = object(await response.json(), "Ink 节点");
    if (body.error || body.id !== 1 || body.jsonrpc !== "2.0" || !Object.hasOwn(body, "result")) throw new Error("Ink 节点未完成请求；不会自动生成另一笔付款。");
    return body.result;
  }
  /** A load-balanced RPC may return a receipt before every backend has its block.
   * Only viem's explicit null-block error is transient here. Other RPC/format errors
   * still fail closed; callers retain the original transaction and authorization. */
  async function readReceiptBlock(blockNumber?: bigint) {
    for (let attempt = 0; attempt < BLOCK_READ_ATTEMPTS; attempt++) {
      try {
        const block = await client.getBlock(blockNumber === undefined ? { blockTag: "latest" } : { blockNumber });
        if (blockNumber !== undefined && block.number !== blockNumber) return null;
        return block;
      } catch (error) {
        if (!(error instanceof BlockNotFoundError)) throw error;
      }
    }
    return null;
  }
  async function checkDomain(): Promise<void> {
    assertMainnetSelection();
    if (await client.getChainId() !== INK_CHAIN_ID) throw new Error("RPC 返回的网络不是 Ink 主网。");
    const [name, decimals, separator] = await Promise.all([
      client.readContract({ address: USDT0_ADDRESS, abi: USDT0_FUNDS_ABI, functionName: "name" }),
      client.readContract({ address: USDT0_ADDRESS, abi: USDT0_FUNDS_ABI, functionName: "decimals" }),
      client.readContract({ address: USDT0_ADDRESS, abi: USDT0_FUNDS_ABI, functionName: "DOMAIN_SEPARATOR" }),
    ]);
    verifyUsdt0Metadata(name, decimals, separator);
    assertMainnetSelection();
  }
  function signerGuard(wallet: FundsWallet) {
    assertMainnetSelection();
    if (!isUnlocked()) throw new Error("保险库已锁定，请解锁后继续原计划。");
    const initial = evmAddressForWalletId(wallet.id);
    const guard = () => {
      assertMainnetSelection();
      if (!isUnlocked()) throw new Error("保险库已锁定，已停止签名。");
      const current = evmAddressForWalletId(wallet.id);
      if (current !== initial || address(current.publicKey) !== address(wallet.address)) throw new Error("钱包或保险库会话发生变化，已停止签名。");
      return current;
    };
    guard(); return guard;
  }
  async function l1Budget(raw: Hex): Promise<bigint> {
    const fee = await client.readContract({ address: INK_GAS_ORACLE, abi: ORACLE_ABI, functionName: "getL1Fee", args: [raw] });
    // Fjord's size bound covers compression differences in signatures and L1 fee changes.
    let bound = fee;
    try {
      const sizeBound = await client.readContract({ address: INK_GAS_ORACLE, abi: ORACLE_ABI, functionName: "getL1FeeUpperBound", args: [BigInt((raw.length - 2) / 2)] });
      if (sizeBound > bound) bound = sizeBound;
    } catch { /* Older oracle: use the successful getL1Fee estimate with the same explicit margin. */ }
    return (bound * 150n + 99n) / 100n + 10_000n;
  }
  async function query(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertMainnetSelection();
    const response = await fetch(RELAY_QUERY, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("无法核验 Nado 的仓位和挂单，交接已暂停。");
    const result = object(await response.json(), "Nado");
    if (result.status !== "success" || result.error) throw new Error("Nado 未返回完整账户状态，交接已暂停。");
    assertMainnetSelection(); return object(result.data, "Nado 数据");
  }
  async function checkNado(wallet: FundsWallet, productIds: number[], requireReturned: boolean) {
    const subaccount = subaccountToHex({ subaccountOwner: address(wallet.address), subaccountName: "default" });
    const [summary, orders, isolated] = await Promise.all([
      query({ type: "subaccount_info", subaccount }), query({ type: "orders", sender: subaccount, product_ids: productIds }),
      query({ type: "isolated_positions", subaccount }),
    ]);
    if (!Array.isArray(summary.spot_balances) || !Array.isArray(summary.perp_balances) || !Array.isArray(orders.product_orders) || !Array.isArray(isolated.isolated_positions)) throw new Error("Nado 账户状态不完整，不能判定交易已结束。");
    for (const item of orders.product_orders) {
      const entry = object(item, "挂单");
      if (!Array.isArray(entry.orders) || entry.orders.length) throw new Error(`${wallet.label ?? wallet.id} 尚有挂单或挂单状态未知。`);
    }
    if (isolated.isolated_positions.length) throw new Error(`${wallet.label ?? wallet.id} 仍有隔离仓位。`);
    for (const item of [...summary.spot_balances, ...summary.perp_balances]) {
      const entry = object(item, "仓位"); const balance = object(entry.balance, "仓位余额");
      if (typeof balance.amount !== "string" || !/^-?[0-9]+$/.test(balance.amount)) throw new Error("Nado 仓位余额格式无效。");
      const amount = BigInt(balance.amount);
      if (Number(entry.product_id) !== 0 && amount !== 0n) throw new Error(`${wallet.label ?? wallet.id} 尚有仓位，不能交接资金。`);
      if (requireReturned && Number(entry.product_id) === 0 && (amount > 1_000_000_000_000n || amount < 0n)) throw new Error(`${wallet.label ?? wallet.id} 的资金尚未全部从 Nado 返回链上，交接不会代为提现。`);
    }
  }
  const adapter: FundsAdapter = {
    async getChainId() { assertMainnetSelection(); return client.getChainId(); },
    async assertIdentity(wallet) {
      const candidate = cohortWallets().find(item => item.walletId === wallet.id);
      if (!candidate || address(candidate.address) !== address(wallet.address)) throw new Error("计划钱包与当前保险库钱包不一致。");
      signerGuard(wallet)();
    },
    async readWallet(wallet) {
      assertMainnetSelection();
      const [token, eth] = await Promise.all([
        client.readContract({ address: USDT0_ADDRESS, abi: USDT0_FUNDS_ABI, functionName: "balanceOf", args: [address(wallet.address)] }),
        client.getBalance({ address: address(wallet.address) }),
      ]);
      return { tokenUnits: token.toString(), ethWei: eth.toString() };
    },
    async assertTradingReady(plan) {
      assertPlan(plan); await checkDomain();
      if (plan.kind === "test-cycle") return;
      const completion = plan.completion;
      if (!completion?.eventId || !completion.batchId || !Number.isFinite(Date.parse(completion.completedAt))) throw new Error("缺少交易批次完成记录。");
      const cfg = await getLiveConfig(true);
      if (!cfg.enabled || cfg.chainId !== INK_CHAIN_ID || !cfg.products?.length) throw new Error("无法核实 Nado 主网配置。");
      const sources = [...new Map(plan.legs.map(leg => [leg.from.id, leg.from])).values()];
      for (const source of sources) {
        if (!completion.sourceWalletIds.includes(source.id)) throw new Error("交接来源不属于已完成的交易批次。");
        await adapter.assertIdentity(source);
        await checkNado(source, cfg.products.map(product => product.productId), true);
        const balance = await adapter.readWallet(source);
        const legs = plan.legs.filter(leg => leg.from.id === source.id && leg.status !== "confirmed");
        const minimum = legs.reduce((sum, leg) => sum + (leg.amount.kind === "fixed" ? BigInt(leg.amount.units) : 1n), 0n);
        if (BigInt(balance.tokenUnits) < minimum) throw new Error(`${source.label ?? source.id} 的链上 USDT0 尚不足，等待资金回到钱包。`);
      }
    },
    async signAuthorization(plan, leg, authorization) {
      assertLeg(plan, leg, authorization); await checkDomain();
      const guard = signerGuard(leg.from); await adapter.assertIdentity(plan.treasury); guard();
      const block = await client.getBlock({ blockTag: "latest" }); guard();
      if (block.timestamp <= BigInt(authorization.validAfter) || block.timestamp + 30n >= BigInt(authorization.validBefore)) throw new Error("授权尚未生效或即将到期，未签名。");
      if (await adapter.authorizationUsed(authorization)) throw new Error("授权已经使用，必须先核实原交易。");
      guard();
      const signer = signerForWalletId(leg.from.id);
      if (!signer.signTypedData) throw new Error("持币钱包不支持结构化签名。");
      const signature = await signer.signTypedData(authorizationTypedData(authorization) as unknown as Eip712TypedData, INK_CHAIN_ID);
      guard(); await verifyAuthorizationSignature({ ...authorization, signature }); guard();
      return signature;
    },
    async prepareTransaction(plan, leg, authorization) {
      assertLeg(plan, leg, authorization); await checkDomain(); await verifyAuthorizationSignature(authorization);
      const guard = signerGuard(plan.treasury); await adapter.assertIdentity(leg.from); guard();
      const from = address(plan.treasury.address); const data = encodeAuthorization(authorization);
      const [block, gasPrice, nonce, balance, source] = await Promise.all([
        client.getBlock({ blockTag: "latest" }), client.getGasPrice(), client.getTransactionCount({ address: from, blockTag: "pending" }),
        client.getBalance({ address: from, blockTag: "pending" }), adapter.readWallet(leg.from),
      ]); guard();
      if (block.timestamp <= BigInt(authorization.validAfter) || block.timestamp + 30n >= BigInt(authorization.validBefore)) throw new Error("授权已过期或即将到期；请核查原计划，不自动生成新付款。");
      if (BigInt(source.tokenUnits) < BigInt(authorization.value)) throw new Error("来源钱包 USDT0 余额不足。");
      const latestNonce = await client.getTransactionCount({ address: from, blockTag: "latest" }); guard();
      if (nonce !== latestNonce) throw new Error("资金库还有未确认交易，请等待后继续，避免交易序号冲突。");
      if (block.baseFeePerGas == null) throw new Error("Ink 节点没有返回基础费用。");
      const priority = gasPrice > block.baseFeePerGas ? gasPrice - block.baseFeePerGas : 1n;
      const maxFeePerGas = block.baseFeePerGas * 2n + priority;
      const estimate = await client.estimateGas({ account: from, to: USDT0_ADDRESS, value: 0n, data, maxFeePerGas, maxPriorityFeePerGas: priority }); guard();
      if (estimate <= 0n || estimate > 500_000n) throw new Error("授权转账 gas 估算异常，已停止签名。");
      const tx: FrozenTransaction = { from, data, nonce, gas: (estimate * 120n + 99n) / 100n, maxFeePerGas, maxPriorityFeePerGas: priority };
      const unsigned = serializeTransaction({ chainId: INK_CHAIN_ID, type: "eip1559", to: USDT0_ADDRESS, value: 0n, data, nonce, gas: tx.gas, maxFeePerGas, maxPriorityFeePerGas: priority });
      let ceiling = tx.gas * maxFeePerGas + await l1Budget(unsigned); guard();
      if (ceiling > uint(plan.limits.maxFeePerLegWei, "单笔预算") || ceiling > uint(plan.limits.maxTotalFeeWei, "整批预算")) throw new Error("预计最大手续费超过计划预算，未签名交易。");
      if (balance < ceiling) throw new Error("资金库 ETH 不足以支付包含 L1 费用的预算。");
      // No broadcast here: caller must durably save the resulting raw bytes first.
      const built = guard().buildTransaction({ to: USDT0_ADDRESS, value: 0n, data, nonce, gasLimit: tx.gas, type: 2,
        maxFeePerGas, maxPriorityFeePerGas: priority, chainId: INK_CHAIN_ID as never, rpcUrl: INK_FUNDS_RPC });
      await built.sign(); guard();
      if (typeof built.rawTransaction !== "string" || !/^0x(?:[a-fA-F0-9]{2})+$/.test(built.rawTransaction)) throw new Error("资金库未返回有效交易字节。");
      const rawTransaction = built.rawTransaction as Hex;
      const transactionHash = await verifyPreparedRawTransaction(rawTransaction, tx); guard();
      ceiling = tx.gas * maxFeePerGas + await l1Budget(rawTransaction); guard();
      if (ceiling > BigInt(plan.limits.maxFeePerLegWei) || ceiling > BigInt(plan.limits.maxTotalFeeWei) || balance < ceiling) throw new Error("最终含 L1 费用的预算不足，未广播交易。");
      if (await client.getTransactionCount({ address: from, blockTag: "pending" }) !== nonce) throw new Error("准备期间资金库交易序号变化，未广播交易。");
      guard();
      return { hash: transactionHash, rawTransaction, nonce: String(nonce), feeCeilingWei: ceiling.toString() } satisfies FundsPreparedTransaction;
    },
    async validatePreparedTransaction(plan, leg, authorization, prepared) {
      assertLeg(plan, leg, authorization); await checkDomain(); await verifyAuthorizationSignature(authorization);
      const guard = signerGuard(plan.treasury); await adapter.assertIdentity(leg.from); guard();
      const decoded = parseTransaction(prepared.rawTransaction);
      if (decoded.type !== "eip1559" || decoded.gas === undefined || decoded.maxFeePerGas === undefined
        || decoded.maxPriorityFeePerGas === undefined || decoded.nonce === undefined
        || BigInt(decoded.nonce) !== uint(prepared.nonce, "已保存交易序号")) throw new Error("保存的交易字段不完整，禁止广播。");
      const expected: FrozenTransaction = { from: address(plan.treasury.address), data: encodeAuthorization(authorization),
        nonce: decoded.nonce, gas: decoded.gas, maxFeePerGas: decoded.maxFeePerGas, maxPriorityFeePerGas: decoded.maxPriorityFeePerGas };
      const computedHash = await verifyPreparedRawTransaction(prepared.rawTransaction, expected); guard();
      if (computedHash !== hash(prepared.hash) || decoded.gas <= 0n || decoded.gas > 600_000n) throw new Error("保存的交易哈希或 gas 上限不匹配。");
      const feeCeiling = uint(prepared.feeCeilingWei, "已保存费用预算");
      const currentL1Fee = await client.readContract({ address: INK_GAS_ORACLE, abi: ORACLE_ABI, functionName: "getL1Fee", args: [prepared.rawTransaction] }); guard();
      const currentCeiling = decoded.gas * decoded.maxFeePerGas + currentL1Fee;
      if (currentCeiling > feeCeiling || feeCeiling > uint(plan.limits.maxFeePerLegWei, "单笔预算")) throw new Error("L1 费用或保存的费用预算已超过预留上限，暂不广播原交易。");
      const latest = await client.getTransactionCount({ address: expected.from, blockTag: "latest" }); guard();
      if (latest !== decoded.nonce) throw new Error("资金库当前交易序号与原交易不一致，请先核实原交易或缺失的前序交易；不会重新签名付款。");
      const balance = await client.getBalance({ address: expected.from, blockTag: "pending" }); guard();
      if (balance < feeCeiling) throw new Error("资金库 ETH 不足以覆盖原交易费用上限。");
      validatedTransactions.set(computedHash, { guard, at: Date.now() });
    },
    async broadcast(rawTransaction) {
      assertMainnetSelection();
      if (!isUnlocked()) throw new Error("保险库已锁定，未广播交易；解锁后可恢复原任务。");
      const decoded = parseTransaction(rawTransaction);
      if (decoded.type !== "eip1559" || decoded.chainId !== INK_CHAIN_ID || address(decoded.to ?? "") !== address(USDT0_ADDRESS) || (decoded.value ?? 0n) !== 0n || !decoded.data) throw new Error("只允许重发已准备的 Ink USDT0 授权交易。");
      const call = decodeFunctionData({ abi: USDT0_FUNDS_ABI, data: decoded.data });
      if (call.functionName !== "transferWithAuthorization") throw new Error("交易不是已允许的授权转账。");
      const expectedHash = keccak256(rawTransaction);
      const validated = validatedTransactions.get(expectedHash);
      if (!validated || Date.now() - validated.at > 30_000) throw new Error("原始交易尚未通过本次恢复核验，不能广播。");
      validated.guard();
      try {
        const result = await client.sendRawTransaction({ serializedTransaction: rawTransaction as TransactionSerialized });
        if (result.toLowerCase() !== expectedHash) throw new Error("节点返回的交易哈希与本地字节不匹配。");
        return expectedHash;
      } catch (error) {
        // Any timeout or already-known error is ambiguous. Check this exact hash only.
        const existing = await rpc("eth_getTransactionByHash", [expectedHash]).catch(() => null);
        if (existing && hash(object(existing, "原交易").hash) === expectedHash) return expectedHash;
        throw new Error(`提交状态待核实；保留原始交易，恢复时仅重发相同字节。哈希：${expectedHash}`, { cause: error });
      }
    },
    async getReceipt(transactionHash) {
      const raw = await rpc("eth_getTransactionReceipt", [hash(transactionHash)]);
      if (raw === null) return null;
      const record = object(raw, "回执");
      if (hash(record.transactionHash) !== hash(transactionHash)) throw new Error("节点返回了其他交易的回执。");
      const number = quantity(record.blockNumber, "blockNumber");
      const blockHash = hash(record.blockHash);
      const [block, tip] = await Promise.all([readReceiptBlock(number), client.getBlockNumber({ cacheTime: 0 })]);
      if (!block || tip < number + CONFIRMATIONS - 1n || block.hash?.toLowerCase() !== blockHash) return null;
      return parseInkFundsReceipt(raw, Number(block.timestamp) * 1000);
    },
    async authorizationUsed(a) {
      assertAuthorization(a);
      return client.readContract({ address: USDT0_ADDRESS, abi: USDT0_FUNDS_ABI, functionName: "authorizationState", args: [address(a.from), hash(a.nonce)] });
    },
    async findAuthorizationReceipt(a, sinceMs) {
      assertAuthorization(a);
      if (!Number.isFinite(sinceMs) || sinceMs <= 0) throw new Error("缺少原授权时间，无法安全恢复扫描。");
      const latest = await readReceiptBlock();
      if (!latest) return null;
      let low = latest.number > MAX_LOG_SCAN_BLOCKS ? latest.number - MAX_LOG_SCAN_BLOCKS : 0n;
      let high = latest.number;
      const oldest = await readReceiptBlock(low);
      if (!oldest) return null;
      if (Number(oldest.timestamp) * 1000 > sinceMs) throw new Error("原授权超出自动核查窗口，请根据原交易哈希核实；不会重新付款。");
      const sinceSeconds = BigInt(Math.max(0, Math.floor(sinceMs / 1000) - 60));
      while (low < high) {
        const middle = (low + high) / 2n;
        const candidate = await readReceiptBlock(middle);
        if (!candidate) return null;
        if (candidate.timestamp < sinceSeconds) low = middle + 1n; else high = middle;
      }
      for (let start = low; start <= latest.number; start += 2_000n) {
        const end = start + 1_999n > latest.number ? latest.number : start + 1_999n;
        const logs = await client.getLogs({ address: USDT0_ADDRESS, event: USDT0_FUNDS_ABI[7], args: { authorizer: address(a.from), nonce: hash(a.nonce) }, fromBlock: start, toBlock: end, strict: true });
        for (const log of logs) {
          if (!log.transactionHash) continue;
          const receipt = await adapter.getReceipt(log.transactionHash);
          if (receipt?.status === "success" && receipt.authorizations.some(item => address(item.authorizer) === address(a.from) && item.nonce.toLowerCase() === a.nonce.toLowerCase())
            && receipt.transfers.some(item => address(item.from) === address(a.from) && address(item.to) === address(a.to) && item.value === a.value)) return receipt;
        }
      }
      return null;
    },
  };
  return adapter;
}

/** Read-only mainnet simulation with two brand-new disposable in-memory accounts.
 * Only the random holder signs; no custody API, real balance or broadcast is used.
 * The token storage slot is validated against balanceOf before relying on the override.
 * This is a fresh-recipient reference, not an exact quote for every planned transfer. */
export async function simulateInkSponsoredTransfer(): Promise<{ gasUnits: string; executionFeeWei: string; l1FeeWei: string; estimatedFeeWei: string; sourceEthWei: "0"; amountUnits: "1000000" }> {
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const holder = privateKeyToAccount(generatePrivateKey());
  const payer = privateKeyToAccount(generatePrivateKey());
  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  const client = createPublicClient({ transport: http(INK_FUNDS_RPC, { timeout: 15_000, retryCount: 0 }) });
  if (await client.getChainId() !== INK_CHAIN_ID) throw new Error("模拟节点不是 Ink 主网。");
  const [name, decimals, separator, block, gasPrice] = await Promise.all([
    client.readContract({ address: USDT0_ADDRESS, abi: USDT0_FUNDS_ABI, functionName: "name" }),
    client.readContract({ address: USDT0_ADDRESS, abi: USDT0_FUNDS_ABI, functionName: "decimals" }),
    client.readContract({ address: USDT0_ADDRESS, abi: USDT0_FUNDS_ABI, functionName: "DOMAIN_SEPARATOR" }),
    client.getBlock({ blockTag: "latest" }), client.getGasPrice(),
  ]);
  verifyUsdt0Metadata(name, decimals, separator);
  const nonceBytes = new Uint8Array(32); crypto.getRandomValues(nonceBytes);
  const authorization: FundsAuthorization = { from: holder.address, to: recipient, value: "1000000", validAfter: "0", validBefore: (block.timestamp + 900n).toString(), nonce: toHex(nonceBytes) };
  authorization.signature = await holder.signTypedData(authorizationTypedData(authorization));
  await verifyAuthorizationSignature(authorization);
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder.address, 51n]));
  const stateOverride = [
    { address: holder.address, balance: 0n }, { address: recipient, balance: 0n },
    { address: payer.address, balance: 10n ** 18n },
    { address: USDT0_ADDRESS, stateDiff: [{ slot, value: toHex(2_000_000n, { size: 32 }) }] },
  ];
  const overriddenBalance = await client.readContract({ address: USDT0_ADDRESS, abi: USDT0_FUNDS_ABI, functionName: "balanceOf", args: [holder.address], stateOverride });
  if (overriddenBalance !== 2_000_000n) throw new Error("只读模拟的合约余额布局已变化，不能继续估算。");
  const data = encodeAuthorization(authorization);
  const gas = await client.estimateGas({ account: payer.address, to: USDT0_ADDRESS, value: 0n, data, stateOverride });
  if (gas <= 0n || gas > 500_000n || block.baseFeePerGas == null) throw new Error("只读模拟返回了异常费用。");
  const priority = gasPrice > block.baseFeePerGas ? gasPrice - block.baseFeePerGas : 1n;
  const serialized = serializeTransaction({ chainId: INK_CHAIN_ID, type: "eip1559", to: USDT0_ADDRESS, value: 0n, data, nonce: 0, gas, maxFeePerGas: block.baseFeePerGas * 2n + priority, maxPriorityFeePerGas: priority });
  const l1Fee = await client.readContract({ address: INK_GAS_ORACLE, abi: ORACLE_ABI, functionName: "getL1Fee", args: [serialized] });
  return { gasUnits: gas.toString(), executionFeeWei: (gas * gasPrice).toString(), l1FeeWei: l1Fee.toString(), estimatedFeeWei: (gas * gasPrice + l1Fee).toString(), sourceEthWei: "0", amountUnits: "1000000" };
}
