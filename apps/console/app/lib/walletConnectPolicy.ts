import { formatEther, formatUnits, hashTypedData, isAddress, type Hex, type TypedDataDefinition } from "viem";

export const INK_CHAIN_ID = 57073;
export const NADO_ORIGIN = "https://app.nado.xyz";
export const SUPPORTED_METHODS = ["personal_sign", "eth_signTypedData_v4", "eth_sendTransaction", "eth_accounts", "eth_requestAccounts", "eth_chainId", "net_version", "wallet_switchEthereumChain"] as const;
export const REVIEW_MAX_AGE_MS = 90_000;
export const MAX_TRANSACTION_VALUE = 5_000_000_000_000_000n;
export const MAX_GAS_BUDGET = 10_000_000_000_000_000n;

export class WalletConnectPolicyError extends Error {}
export function policyError(message: string): never { throw new WalletConnectPolicyError(message); }
export type JsonRecord = Record<string, unknown>;
export interface TransactionPayload {
  from: Hex; to: Hex; chainId: typeof INK_CHAIN_ID; value: bigint; data: Hex;
  nonce?: number; gas?: bigint; gasPrice?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; type: 0 | 2;
}
interface ReviewBase { method: string; address: Hex; title: string; details: string; caution?: string; createdAt: number }
export type PreparedRequest =
  | (ReviewBase & { kind: "login"; payload: { messageHex: Hex; message: string } })
  | (ReviewBase & { kind: "typedData"; payload: { typedData: TypedDataDefinition } })
  | (ReviewBase & { kind: "transaction"; payload: TransactionPayload })
  | (ReviewBase & { kind: "switchChain" | "read"; payload: null });

export function freezeReview<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeReview(child);
    Object.freeze(value);
  }
  return value;
}
export function validAddress(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) || !isAddress(value, { strict: false })) policyError("钱包地址格式无效。");
  return value.toLowerCase() as Hex;
}
function object(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) policyError("请求对象格式无效。");
  return value as JsonRecord;
}
function exactKeys(value: JsonRecord, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) policyError("请求包含暂不支持的字段，已停止处理。");
}
function paramsArray(params: unknown, length: number): unknown[] {
  if (!Array.isArray(params) || params.length !== length) policyError("请求参数数量不正确。");
  return params;
}
function quantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) || value.length > 66) policyError(`${label}必须是有效的十六进制整数。`);
  return BigInt(value);
}
function chain(value: unknown) {
  if (!(value === INK_CHAIN_ID || value === String(INK_CHAIN_ID) || (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) && value.length < 18 && BigInt(value) === BigInt(INK_CHAIN_ID)))) policyError("只允许 Ink 主网（链号 57073）。");
}
function bytes(value: unknown, maxBytes: number): Hex {
  if (typeof value !== "string" || value.length > 2 + maxBytes * 2 || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) policyError("请求的十六进制数据无效或过大。");
  return value.toLowerCase() as Hex;
}
function officialUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { return policyError("登录网址格式无效。"); }
  if (url.origin !== NADO_ORIGIN || url.username || url.password) policyError("登录声明必须属于官方 Nado 网站。");
}
function timestamp(value: string, label: string): number {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) policyError(`${label}格式无效。`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) policyError(`${label}格式无效。`);
  return time;
}
function login(params: unknown, address: Hex, base: ReviewBase): PreparedRequest {
  const [raw, requestedAddress] = paramsArray(params, 2);
  if (validAddress(requestedAddress) !== address) policyError("登录签名地址与当前连接钱包不一致。");
  const messageHex = bytes(raw, 16_384);
  let message: string;
  try { message = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(messageHex.slice(2).match(/../g) ?? [], b => parseInt(b, 16))); }
  catch { return policyError("只允许 UTF-8 格式的标准 SIWE 登录声明。"); }
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(message)) policyError("登录声明含有无效控制字符。");
  const lines = message.split("\n");
  if (lines[0] !== "app.nado.xyz wants you to sign in with your Ethereum account:" && lines[0] !== "https://app.nado.xyz wants you to sign in with your Ethereum account:") policyError("只允许官方 Nado 的标准 SIWE 登录声明，不能签署任意消息。");
  if (validAddress(lines[1]) !== address || lines[2] !== "") policyError("登录声明的钱包地址或格式不匹配。");
  let index = 3;
  // EIP-4361's optional statement is one line and followed by a blank line.
  if (lines[index] === "") index++;
  else if (!lines[index]?.startsWith("URI: ")) {
    if (!lines[index] || lines[index + 1] !== "") policyError("登录声明格式无效。");
    index += 2;
  }
  const take = (name: string) => {
    const line = lines[index++];
    if (!line?.startsWith(`${name}: `)) return policyError(`登录声明缺少 ${name} 字段。`);
    return line.slice(name.length + 2);
  };
  officialUrl(take("URI"));
  if (take("Version") !== "1") policyError("只支持 SIWE 第 1 版登录声明。");
  if (take("Chain ID") !== String(INK_CHAIN_ID)) policyError("登录声明必须使用 Ink 主网（57073）。");
  if (!/^[a-zA-Z0-9]{8,128}$/.test(take("Nonce"))) policyError("登录声明的随机数无效。");
  const now = Date.now();
  const issued = timestamp(take("Issued At"), "签发时间");
  if (issued > now + 60_000 || issued < now - 300_000) policyError("登录声明已过期或签发时间异常，请在官网重新请求登录。");
  if (lines[index]?.startsWith("Expiration Time: ")) {
    const expires = timestamp(take("Expiration Time"), "到期时间");
    if (expires <= now || expires <= issued) policyError("登录声明已到期。");
  }
  if (lines[index]?.startsWith("Not Before: ") && timestamp(take("Not Before"), "生效时间") > now) policyError("登录声明尚未生效。");
  if (lines[index]?.startsWith("Request ID: ")) take("Request ID");
  if (lines[index] === "Resources:") {
    index++;
    if (index >= lines.length) policyError("登录声明的资源列表为空。");
    while (index < lines.length) {
      const line = lines[index++];
      if (!line?.startsWith("- ")) policyError("登录声明资源格式无效。");
      officialUrl(line.slice(2));
    }
  }
  if (index !== lines.length) policyError("登录声明含有额外或重复字段。");
  return { ...base, kind: "login", title: "签署 Nado 登录声明", details: `网站：${NADO_ORIGIN}\n钱包：${address}\n网络：Ink 主网（57073）\n\n完整登录声明：\n${message}`, caution: "这会向 Nado 证明你控制此钱包。请核对下方完整声明。", payload: { messageHex, message } };
}
function cloneJson(value: unknown): JsonRecord {
  let serialized: string;
  try { serialized = typeof value === "string" ? value : JSON.stringify(value); }
  catch { return policyError("结构化签名数据必须是有效 JSON。"); }
  if (!serialized || serialized.length > 65_536) policyError("结构化签名数据为空或过大。");
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { return policyError("结构化签名数据不是有效 JSON。"); }
  const inspect = (item: unknown, depth: number) => {
    if (depth > 16) policyError("结构化签名数据嵌套过深。");
    if (typeof item === "number" && !Number.isSafeInteger(item)) policyError("签名中的大整数必须用字符串表示。");
    if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) policyError("签名数据含有不支持的字段。");
      inspect(child, depth + 1);
    }
  };
  inspect(parsed, 0);
  return object(parsed);
}
function typedData(params: unknown, address: Hex, base: ReviewBase): PreparedRequest {
  const [requestedAddress, raw] = paramsArray(params, 2);
  if (validAddress(requestedAddress) !== address) policyError("结构化签名地址与当前连接钱包不一致。");
  const td = cloneJson(raw);
  exactKeys(td, ["types", "domain", "primaryType", "message"]);
  const domain = object(td.domain), types = object(td.types), message = object(td.message);
  exactKeys(domain, ["name", "version", "chainId", "verifyingContract", "salt"]);
  chain(domain.chainId);
  const contract = validAddress(domain.verifyingContract);
  if (/^0x0{40}$/.test(contract)) policyError("签名验证合约不能是零地址。");
  if (typeof td.primaryType !== "string" || td.primaryType === "EIP712Domain" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(td.primaryType) || !Object.hasOwn(types, td.primaryType)) policyError("结构化签名类型无效。");
  if (Object.keys(types).length > 32) policyError("签名类型过多。");
  for (const [name, fields] of Object.entries(types)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !Array.isArray(fields) || fields.length > 64) policyError("签名类型定义无效。");
    const seen = new Set<string>();
    for (const field of fields) {
      const f = object(field); exactKeys(f, ["name", "type"]);
      if (typeof f.name !== "string" || typeof f.type !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.name) || seen.has(f.name)) policyError("签名字段定义无效或重复。");
      seen.add(f.name);
    }
  }
  if (message.sender !== undefined) {
    if (typeof message.sender !== "string" || !/^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(message.sender) || message.sender.slice(0, 42).toLowerCase() !== address) policyError("签名中的子账户所有者与当前钱包不一致。");
  }
  for (const key of ["owner", "holder"]) if (message[key] !== undefined && validAddress(message[key]) !== address) policyError("授权中的所有者与当前钱包不一致。");
  const value = td as unknown as TypedDataDefinition;
  try { hashTypedData(value); } catch { return policyError("结构化签名数据未通过 EIP-712 校验。"); }
  const kind = td.primaryType.toLowerCase();
  let title = `签署结构化请求：${td.primaryType}`;
  let caution = "这是结构化授权或操作签名，不是登录；未知类型可能授予权限或转移资产。";
  if (kind.includes("linksigner")) { title = "授权 Nado 委托签名者"; caution = "此签名可能授予指定签名者后续交易权限，并持续生效直至撤销。请核对 signer 及有效期；它不是登录。"; }
  else if (kind.includes("order")) { title = "签署 Nado 订单"; caution = "此签名可用于提交真实订单，可能建立仓位并产生交易费用。"; }
  else if (kind.includes("withdraw") || kind.includes("transfer")) { title = "签署提现或资产转移"; caution = "此签名可用于转出资产。请核对目标地址、资产和数量。"; }
  else if (kind.includes("permit") || kind.includes("approval")) { title = "签署代币支出授权"; caution = "此签名可能允许 spender 支出你的代币；最大整数额度表示无限授权。请核对 spender、value/amount 和期限。"; }
  const visibleFields: [string, string][] = [["sender", "子账户（前 20 字节为所有者）"], ["signer", "被授权的委托签名者"], ["spender", "代币授权对象"], ["owner", "资产所有者"], ["nonce", "请求序号"], ["amount", "数量（原始单位）"], ["value", "额度（原始单位）"], ["priceX18", "价格（原值，除以 10¹⁸）"], ["expiration", "到期字段（原始编码）"], ["deadline", "授权期限（原始值）"]];
  const summary = visibleFields.filter(([key]) => message[key] !== undefined).map(([key, label]) => {
    const rawValue = typeof message[key] === "object" ? JSON.stringify(message[key]) : String(message[key]);
    let unlimited = false;
    if (["amount", "value"].includes(key) && /^(?:0x[0-9a-fA-F]+|\d+)$/.test(rawValue)) {
      const field = (types[td.primaryType as string] as JsonRecord[]).find(f => f.name === key);
      const width = typeof field?.type === "string" ? /^uint(\d*)$/.exec(field.type) : null;
      if (width) { const bits = Number(width[1] || "256"); if (bits >= 8 && bits <= 256) unlimited = BigInt(rawValue) === (1n << BigInt(bits)) - 1n; }
    }
    return `${label}：${rawValue}${unlimited ? "（无限额度）" : ""}`;
  }).join("\n");
  return { ...base, kind: "typedData", title, caution, details: `钱包：${address}\n网络：Ink 主网（57073）\n验证合约：${contract}\n${summary}\n\n完整签名数据（整数保留原始单位）：\n${JSON.stringify(td, null, 2)}`, payload: { typedData: value } };
}
function transaction(params: unknown, address: Hex, base: ReviewBase): PreparedRequest {
  const [raw] = paramsArray(params, 1), tx = object(raw);
  exactKeys(tx, ["from", "to", "chainId", "value", "data", "input", "nonce", "gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas", "type"]);
  if (validAddress(tx.from) !== address) policyError("交易发送地址与当前连接钱包不一致。");
  // WalletConnect session chain is pinned independently; EIP-1193 transactions may omit this field.
  if (tx.chainId !== undefined) chain(tx.chainId);
  const to = validAddress(tx.to);
  if (/^0x0{40}$/.test(to)) policyError("不允许发送到零地址。");
  const value = tx.value === undefined ? 0n : quantity(tx.value, "ETH 金额");
  if (value > MAX_TRANSACTION_VALUE) policyError("单笔 ETH 金额不能超过 0.005 ETH。");
  const data = bytes(tx.data ?? tx.input ?? "0x", 32_768);
  if (tx.data !== undefined && tx.input !== undefined && bytes(tx.input, 32_768) !== data) policyError("交易 data 与 input 不一致。");
  const type = tx.type === undefined ? (tx.gasPrice === undefined ? 2 : 0) : Number(quantity(tx.type, "交易类型"));
  if (type !== 0 && type !== 2) policyError("仅支持普通交易和 EIP-1559 交易，不支持账户委托等额外交易类型。");
  const payload: TransactionPayload = { from: address, to, chainId: INK_CHAIN_ID, value, data, type };
  for (const key of ["gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas"] as const) if (tx[key] !== undefined) payload[key] = quantity(tx[key], key);
  if (type === 0 && (payload.maxFeePerGas !== undefined || payload.maxPriorityFeePerGas !== undefined) || type === 2 && payload.gasPrice !== undefined) policyError("不能混用不同交易类型的费用字段。");
  if (tx.nonce !== undefined) {
    const nonce = quantity(tx.nonce, "交易序号");
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) policyError("交易序号过大。");
    payload.nonce = Number(nonce);
  }
  let title = data === "0x" ? "发送 Ink 主网 ETH 交易" : "调用 Ink 主网合约";
  let caution = "确认后将签名并广播真实主网交易，网络费用不可撤销。";
  let action = "";
  if (data.startsWith("0x095ea7b3")) {
    if (data.length !== 138 || !/^0{24}$/.test(data.slice(10, 34))) policyError("代币授权数据格式无效。");
    const spender = `0x${data.slice(34, 74)}`, amount = BigInt(`0x${data.slice(74)}`);
    title = "授权代币支出额度";
    action = `\n授权对象（spender）：${spender}\n额度（最小单位）：${amount === (1n << 256n) - 1n ? "无限额度" : amount.toString()}\n`;
    if (to === "0x0200c29006150606b650577bbe7b6248f58470c1") action += `USDT0 额度：${amount === (1n << 256n) - 1n ? "无限额度" : `${formatUnits(amount, 6)} USDT0`}\n`;
    caution = "授权对象可在额度内转走此合约的代币。请确认代币合约、授权对象与额度。";
  } else if (data.startsWith("0xa22cb465")) {
    if (data.length !== 138 || !/^0{24}$/.test(data.slice(10, 34)) || !/^0{63}[01]$/.test(data.slice(74))) policyError("全部资产授权数据格式无效。");
    title = "设置 NFT 全部资产授权";
    action = `\n授权对象：0x${data.slice(34, 74)}\n全部资产授权：${data.endsWith("1") ? "允许" : "撤销"}\n`;
    caution = "允许全部资产授权后，对方可能转走此合约中属于你的全部 NFT。";
  } else if (data !== "0x") caution += " 这是尚未解析的合约调用，可能涉及授权或资产转移；模拟成功不代表安全。";
  return { ...base, kind: "transaction", title, caution, details: `发送钱包：${address}\n目标地址 / 合约：${to}\n网络：Ink 主网（57073）\nETH 金额：${formatEther(value)} ETH${action}\n完整调用数据：${data}\n交易费用将在模拟后显示。`, payload };
}

export function validateRequest(method: string, params: unknown, currentAddress: string): PreparedRequest {
  if (!(SUPPORTED_METHODS as readonly string[]).includes(method)) policyError("此请求方法不受支持；不允许 eth_sign 或未经审核的签名方式。");
  const address = validAddress(currentAddress);
  const base: ReviewBase = { method, address, title: "", details: "", createdAt: Date.now() };
  let result: PreparedRequest;
  if (method === "personal_sign") result = login(params, address, base);
  else if (method === "eth_signTypedData_v4") result = typedData(params, address, base);
  else if (method === "eth_sendTransaction") result = transaction(params, address, base);
  else if (method === "wallet_switchEthereumChain") {
    const [raw] = paramsArray(params, 1), request = object(raw);
    exactKeys(request, ["chainId"]); chain(request.chainId);
    result = { ...base, kind: "switchChain", title: "确认 Ink 主网", details: "保持使用 Ink 主网（57073）。", payload: null };
  } else {
    paramsArray(params ?? [], 0);
    result = { ...base, kind: "read", title: "读取已连接钱包信息", details: `钱包：${address}\n网络：Ink 主网（57073）`, payload: null };
  }
  return freezeReview(result);
}
