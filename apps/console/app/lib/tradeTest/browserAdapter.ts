/** Browser custody only. prepare signs; broadcast sends the exact persisted bytes. */
import { hashTypedData } from "viem";
import { getNadoEIP712Domain, getNadoEIP712Types, getNadoEIP712PrimaryType, getOrderNonce, getOrderVerifyingAddress, packOrderAppendix, subaccountToHex } from "@nadohq/client";
import type { Eip712TypedData, WalletSigner } from "@farm/adapter-api";
import { activeNetwork, type NetworkConfig } from "../chainEnv";
import { signerForWalletId } from "../custody";
import { getLiveConfig, type LiveConfig } from "../liveConfig";
import type { AccountSnapshot, OrderRequest, PreparedTestOrder, TestMarket, TestOpenOrder, TestOrderReport, TestWallet, TradeTestAdapter } from "./types";

const X18 = 10n ** 18n;
const HEX32 = /^0x[\da-fA-F]{64}$/;
type Obj = Record<string, unknown>;
class ExecuteRejected extends Error {
  constructor(readonly code: number | undefined, detail: string) { super(`Nado 拒绝 ${code ?? ""} ${detail}`); }
}
function obj(v: unknown, label = "数据"): Obj { if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${label}缺失或格式错误`); return v as Obj; }
function array(v: unknown, label: string): unknown[] { if (!Array.isArray(v)) throw new Error(`${label}缺失`); return v; }
function integer(v: unknown, label: string): bigint { if (typeof v !== "string" || !/^-?\d+$/.test(v)) throw new Error(`${label}数值无效`); return BigInt(v); }
function id(v: unknown): number { if (!Number.isSafeInteger(v) || Number(v) < 0) throw new Error("产品编号无效"); return Number(v); }
function sender(v: unknown): string { if (typeof v !== "string" || !HEX32.test(v)) throw new Error("账户编号无效"); return v.toLowerCase(); }
function digest(v: unknown): string { return sender(v); }
const abs = (v: bigint) => v < 0n ? -v : v;
const parentOf = (wallet: TestWallet) => subaccountToHex({ subaccountOwner: wallet.address, subaccountName: "default" }).toLowerCase();
const owns = (wallet: TestWallet, s: string) => sender(s).slice(0, 42) === wallet.address.toLowerCase();
const jsonSafe = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, value) => typeof value === "bigint" ? value.toString() : value)) as Obj;

export interface BrowserTradeTestDependencies {
  fetch: typeof fetch; now: () => number; network: () => NetworkConfig;
  signer: (walletId: string) => WalletSigner; config: () => Promise<LiveConfig>;
}

/** No signing or network traffic happens at construction time. Dependencies permit offline tests. */
export function createBrowserTradeTestAdapter(overrides: Partial<BrowserTradeTestDependencies> = {}): TradeTestAdapter {
  const d: BrowserTradeTestDependencies = { fetch: (...args) => fetch(...args), now: Date.now, network: activeNetwork, signer: signerForWalletId, config: () => getLiveConfig(true), ...overrides };
  // Bind a run adapter to one network. A later cookie change fails instead of moving the run.
  const chainId = d.network().chainId;
  const readTimes = new WeakMap<Obj, number>();
  const observedAt = (value: Obj): number => { const at = readTimes.get(value); if (at === undefined) throw new Error("读取时间缺失"); return at; };
  function network(): NetworkConfig { const net = d.network(); if (net.chainId !== chainId) throw new Error("测试进行中网络已改变，停止操作"); return net; }
  function assertLocalIdentity(wallet: TestWallet, expectedChain = chainId): void {
    network();
    if (expectedChain !== chainId || !/^0x[\da-fA-F]{40}$/.test(wallet.address)) throw new Error("测试钱包或网络不匹配");
    const signer = d.signer(wallet.id);
    if (signer.address.family !== "evm" || signer.address.value.toLowerCase() !== wallet.address.toLowerCase()) throw new Error("测试钱包地址已改变或未解锁");
  }
  // Share only an in-flight configuration request. Completed/error results are
  // discarded, and every caller rechecks custody and network after awaiting it.
  let pendingConfig: Promise<LiveConfig> | undefined;
  async function currentConfig(): Promise<LiveConfig> {
    const request = pendingConfig ??= d.config();
    try { return await request; }
    finally { if (pendingConfig === request) pendingConfig = undefined; }
  }
  async function assertIdentity(wallet: TestWallet, expectedChain = chainId): Promise<void> {
    assertLocalIdentity(wallet, expectedChain);
    const cfg = await currentConfig();
    assertLocalIdentity(wallet, expectedChain);
    if (!cfg.enabled || cfg.chainId !== chainId || !/^0x[\da-fA-F]{40}$/.test(cfg.endpoint ?? "")) throw new Error("本地服务网络或签名配置不匹配");
  }
  async function read(kind: string, fields: Obj = {}): Promise<Obj> {
    network();
    const response = await d.fetch("/api/nado/trade-test-read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, chainId, ...fields }), cache: "no-store", signal: AbortSignal.timeout(40_000) });
    network();
    if (!response.ok) throw new Error(`Nado 读取失败 ${response.status}`);
    const body = obj(await response.json());
    if (body.chainId !== chainId) throw new Error("读取结果网络不匹配");
    if (typeof body.observedAt !== "number" || !Number.isFinite(body.observedAt) || body.observedAt > d.now() + 1000) throw new Error("读取时间无效");
    const result = obj(body.result);
    readTimes.set(result, body.observedAt);
    return result;
  }
  async function query(q: Obj): Promise<Obj> {
    const envelope = await read("query", { query: q });
    if (envelope.status !== "success") throw new Error(`Nado 读取被拒绝 ${String(envelope.error_code ?? "")} ${String(envelope.error ?? "")}`);
    const data = obj(envelope.data);
    readTimes.set(data, observedAt(envelope));
    return data;
  }
  async function fundingBalance(wallet: TestWallet) {
    await assertIdentity(wallet);
    const parentSender = parentOf(wallet);
    const account = await query({ type: "subaccount_info", subaccount: parentSender });
    assertLocalIdentity(wallet);
    if (sender(account.subaccount) !== parentSender || typeof account.exists !== "boolean") throw new Error("返回充值账户身份不完整");
    const spots = array(account.spot_balances, "充值余额").map(value => obj(value));
    const productIds = spots.map(spot => id(spot.product_id));
    if (new Set(productIds).size !== productIds.length) throw new Error("充值余额包含重复产品");
    const quote = spots.find(spot => spot.product_id === 0);
    if (account.exists && !quote) throw new Error("充值账户 USDT0 余额缺失");
    const amount = quote ? integer(obj(quote.balance).amount, "充值账户 USDT0 余额") : 0n;
    if (amount < 0n || (!account.exists && amount !== 0n)) throw new Error("充值账户 USDT0 余额无效");
    const at = observedAt(account);
    // Preserve the upstream observation, including its age. The funding controller
    // applies the same 5-second bound and can retry a stale read without paying.
    return { parentSender, quoteBalanceX18: amount.toString(), observedAt: at };
  }
  async function snapshot(wallet: TestWallet): Promise<AccountSnapshot> {
    await assertIdentity(wallet);
    const parentSender = parentOf(wallet);
    // Reserve the expensive complete-order read BEFORE sampling balances. Rolling
    // rate-limit waits then happen before the snapshot, instead of aging its balances.
    const [universe, registryResponse] = await Promise.all([query({ type: "all_products" }), query({ type: "symbols" })]);
    const universeProducts = [...array(universe.spot_products, "现货产品全集"), ...array(universe.perp_products, "永续产品全集")].map(x => obj(x));
    const assetIds = [...new Set(universeProducts.map(x => id(x.product_id)))];
    // The asset universe can contain collateral without a queryable orderbook
    // (production product 11 is one). Use the gateway's market registry for orders,
    // keeping ALL trading statuses so paused/reduce-only markets are still checked.
    const registry = obj(registryResponse.symbols, "市场目录");
    const productIds = Object.entries(registry).map(([name, value]) => {
      const entry = obj(value, "市场目录项"), productId = id(entry.product_id);
      if (entry.symbol !== name || !["spot", "perp"].includes(String(entry.type)) || productId <= 0 || !assetIds.includes(productId)) throw new Error("市场目录与资产全集不一致，请重新读取");
      return productId;
    });
    if (new Set(productIds).size !== productIds.length) throw new Error("市场目录包含重复编号");
    if (!productIds.length) throw new Error("无法确认全部挂单市场");
    const parentOrders = await query({ type: "orders", sender: parentSender, product_ids: productIds });
    const [account, isolated, fees] = await Promise.all([
      query({ type: "subaccount_info", subaccount: parentSender }), query({ type: "isolated_positions", subaccount: parentSender }), query({ type: "fee_rates", sender: parentSender }),
    ]);
    const healthCheckFee = integer(fees.health_check_sequencer_fee, "健康检查固定费"), takerSequencerFee = integer(fees.taker_sequencer_fee, "吃单固定费");
    if (healthCheckFee < 0n || takerSequencerFee < 0n) throw new Error("固定费用不能为负数");
    // Balance reserve only, not a claim of incurred fees: opening/closing health
    // checks plus up to five close attempts. Liquidation/withdrawal fees excluded.
    const fixedFeeReserve = 2n * healthCheckFee + 5n * takerSequencerFee;
    if (sender(account.subaccount) !== parentSender || typeof account.exists !== "boolean") throw new Error("返回账户身份不完整");
    const spots = array(account.spot_balances, "现货余额").map(x => obj(x));
    const perps = array(account.perp_balances, "全仓余额").map(x => obj(x));
    const products = [...array(account.spot_products, "现货产品"), ...array(account.perp_products, "永续产品")].map(x => obj(x));
    if (products.some(x => !assetIds.includes(id(x.product_id)))) throw new Error("产品全集已改变，请重新读取");
    const productMap = new Map(products.map(x => [id(x.product_id), x]));
    const isolatedRows = array(isolated.isolated_positions, "逐仓账户").map(x => obj(x));
    let equity = 0n, quoteBalance = 0n, hasOtherCollateral = false, hasCrossPosition = false;
    for (const spot of spots) {
      const amount = integer(obj(spot.balance).amount, "现货余额");
      if (id(spot.product_id) === 0) quoteBalance = amount;
      else if (amount !== 0n) hasOtherCollateral = true;
    }
    if (account.exists && !spots.some(s => s.product_id === 0)) throw new Error("USDT0 余额缺失");
    equity = quoteBalance;
    for (const perp of perps) {
      const balance = obj(perp.balance), amount = integer(balance.amount, "全仓数量"), vQuote = integer(balance.v_quote_balance, "待结算金额");
      if (amount !== 0n) hasCrossPosition = true;
      const p = productMap.get(id(perp.product_id));
      if (!p) throw new Error("仓位预言机数据缺失");
      equity += amount * integer(p.oracle_price_x18, "预言机价格") / X18 + vQuote;
    }
    const positions: AccountSnapshot["positions"] = [];
    const allSenders = [parentSender];
    const childProducts = new Map<string, number>();
    for (const row of isolatedRows) {
      const child = sender(row.subaccount);
      if (!owns(wallet, child) || child === parentSender || allSenders.includes(child)) throw new Error("逐仓账户归属异常");
      allSenders.push(child);
      const base = obj(row.base_balance), balance = obj(base.balance), quote = obj(row.quote_balance);
      const productId = id(base.product_id), baseProduct = obj(row.base_product);
      if (!productIds.includes(productId)) throw new Error("逐仓产品没有可查询的市场，无法完整核对挂单");
      childProducts.set(child, productId);
      if (id(quote.product_id) !== 0 || id(baseProduct.product_id) !== productId) throw new Error("逐仓资产不匹配");
      const amount = integer(balance.amount, "逐仓数量"), vQuote = integer(balance.v_quote_balance, "逐仓待结算金额"), margin = integer(obj(quote.balance).amount, "逐仓余额");
      const oracle = integer(baseProduct.oracle_price_x18, "逐仓预言机");
      equity += margin + vQuote + amount * oracle / X18;
      positions.push({ sender: child, productId, amountX18: amount.toString(), quoteX18: (margin + vQuote).toString() });
    }
    const openOrders: TestOpenOrder[] = [];
    let snapshotObservedAt = Math.min(observedAt(parentOrders), observedAt(account), observedAt(isolated), observedAt(fees));
    const orderResults = await Promise.all(allSenders.map(async accountSender => {
      // Each isolated child belongs to exactly one perp product. Orders for all
      // products still live on the parent, which was checked in full above.
      const accountProducts = accountSender === parentSender ? productIds : [childProducts.get(accountSender)!];
      const result = accountSender === parentSender ? parentOrders : await query({ type: "orders", sender: accountSender, product_ids: accountProducts });
      return { accountSender, accountProducts, result };
    }));
    for (const { accountSender, accountProducts, result } of orderResults) {
      snapshotObservedAt = Math.min(snapshotObservedAt, observedAt(result));
      if (sender(result.sender) !== accountSender) throw new Error("挂单账户不匹配");
      const rows = array(result.product_orders, "挂单列表").map(x => obj(x));
      if (accountProducts.some(p => !rows.some(x => x.product_id === p))) throw new Error("挂单查询未覆盖全部市场");
      for (const row of rows) for (const entry of array(row.orders, "市场挂单")) {
        const order = obj(entry), owner = sender(order.sender);
        if (owner !== accountSender) throw new Error("挂单归属不一致");
        integer(order.unfilled_amount, "剩余挂单数量");
        openOrders.push({ sender: owner, digest: digest(order.digest), productId: id(row.product_id), amountX18: abs(integer(order.amount, "原始挂单数量")).toString(), priceX18: integer(order.price_x18 ?? order.priceX18, "挂单价格").toString() });
      }
    }
    return { observedAt: snapshotObservedAt, parentSender, quoteBalanceX18: quoteBalance.toString(), equityX18: equity.toString(), fixedFeeReserveX18: fixedFeeReserve.toString(), positions, openOrders, hasOtherCollateral, hasCrossPosition };
  }
  async function market(symbol: string): Promise<TestMarket> {
    if (!/^[A-Z0-9]+-PERP$/.test(symbol)) throw new Error("只能明确选择永续市场");
    const symbols = await read("symbols"), entry = obj(symbols[symbol], "所选市场");
    if (entry.symbol !== symbol || entry.type !== "perp" || typeof entry.isolated_only !== "boolean" || typeof entry.trading_status !== "string") throw new Error("市场类型或交易状态不完整");
    const productId = id(entry.product_id);
    const [products, bbo] = await Promise.all([query({ type: "all_products" }), query({ type: "market_price", product_id: productId })]);
    if (id(bbo.product_id) !== productId) throw new Error("盘口市场不匹配");
    const product = array(products.perp_products, "永续风险参数").map(x => obj(x)).find(x => x.product_id === productId);
    if (!product) throw new Error("所选市场风险参数缺失");
    const risk = obj(product.risk), long = X18 - integer(risk.long_weight_initial_x18, "多头风险权重"), short = integer(risk.short_weight_initial_x18, "空头风险权重") - X18;
    const initial = long > short ? long : short;
    if (initial <= 0n) throw new Error("杠杆参数无效");
    let isOpen = entry.trading_status === "live";
    if (entry.market_hours !== null) { const hours = obj(entry.market_hours, "交易时段"); if (typeof hours.is_open !== "boolean") throw new Error("交易时段不完整"); isOpen &&= hours.is_open; }
    return { symbol, productId, observedAt: Math.min(observedAt(products), observedAt(bbo)), isOpen, isolatedOnly: entry.isolated_only, maxLeverage: Number(X18) / Number(initial),
      minNotionalX18: integer(entry.min_size, "最低金额").toString(), sizeIncrementX18: integer(entry.size_increment, "数量刻度").toString(), priceIncrementX18: integer(entry.price_increment_x18, "价格刻度").toString(),
      bidX18: integer(bbo.bid_x18, "买价").toString(), askX18: integer(bbo.ask_x18, "卖价").toString(), oracleX18: integer(product.oracle_price_x18, "预言机价格").toString(),
      makerFeeRateX18: integer(entry.maker_fee_rate_x18, "挂单费率").toString(), takerFeeRateX18: integer(entry.taker_fee_rate_x18, "吃单费率").toString() };
  }
  function typedOrder(raw: Obj): Eip712TypedData {
    const productId = id(raw.product_id), order = obj(raw.order);
    return { domain: getNadoEIP712Domain(getOrderVerifyingAddress(productId), chainId), types: getNadoEIP712Types("place_order"), primaryType: getNadoEIP712PrimaryType("place_order"), message: {
      sender: sender(order.sender), priceX18: integer(order.priceX18, "订单价格"), amount: integer(order.amount, "订单数量"), expiration: integer(order.expiration, "到期时间"), nonce: integer(order.nonce, "订单序号"), appendix: integer(order.appendix, "订单属性"),
    } };
  }
  const orderHash = (raw: Obj) => hashTypedData(typedOrder(raw) as Parameters<typeof hashTypedData>[0]);
  async function prepare(request: OrderRequest): Promise<PreparedTestOrder> {
    await assertIdentity(request.wallet);
    const net = network(), amount = integer(request.amountX18, "下单数量"), price = integer(request.priceX18, "下单价格");
    const notional = amount * price / X18;
    const cap = BigInt(Math.floor(Math.min(150, net.caps.orderNotionalUsdt0) * 1e6)) * 10n ** 12n;
    if (amount <= 0n || price <= 0n || notional > cap || !Number.isFinite(request.expiresAt) || request.expiresAt <= d.now() || request.expiresAt > d.now() + 600_000) throw new Error("数量、金额上限或到期时间无效");
    if (amount % BigInt(request.market.sizeIncrementX18) !== 0n || price % BigInt(request.market.priceIncrementX18) !== 0n) throw new Error("订单没有对齐市场精度");
    let orderSender = parentOf(request.wallet), margin: bigint | undefined;
    if (request.reduceOnly) {
      if (request.marginX18 !== undefined || !request.sender) throw new Error("平仓不得再次划入保证金");
      const isolated = await query({ type: "isolated_positions", subaccount: orderSender });
      const position = array(isolated.isolated_positions, "逐仓账户").map(x => obj(x)).find(p => sender(p.subaccount) === sender(request.sender) && id(obj(p.base_balance).product_id) === request.market.productId);
      if (!position || !owns(request.wallet, sender(position.subaccount))) throw new Error("逐仓平仓账户已不存在或不属于该钱包");
      const remaining = integer(obj(obj(position.base_balance).balance).amount, "实时逐仓数量");
      if (amount > abs(remaining) || (remaining > 0n ? "sell" : "buy") !== request.side) throw new Error("平仓数量或方向与实时仓位不符");
      // The verified production close-order format
      // use the parent sender with isolated=true, reduceOnly=true, margin=0 (appendix 2817).
      // Older public error descriptions 2085/2088 describe a superseded child-sender path.
      margin = 0n;
    } else {
      if (request.sender && sender(request.sender) !== orderSender) throw new Error("只能从父账户开逐仓仓位");
      margin = integer(request.marginX18, "逐仓保证金");
      if (margin <= 0n || margin % 10n ** 12n !== 0n || notional < BigInt(request.market.minNotionalX18) || notional > margin * 20n) throw new Error("逐仓保证金、20 倍杠杆或最低订单金额不正确");
      if (!request.market.isOpen) throw new Error("市场不允许新开仓");
      const fees = await query({ type: "fee_rates", sender: orderSender });
      const takerRates = array(fees.taker_fee_rates_x18, "账户吃单费率"), makerRates = array(fees.maker_fee_rates_x18, "账户挂单费率");
      // No assumed VIP exemption: reject changed fees and let a fresh preview be reviewed.
      if (integer(takerRates[request.market.productId], "账户费率") !== BigInt(request.market.takerFeeRateX18) || integer(makerRates[request.market.productId], "账户费率") !== BigInt(request.market.makerFeeRateX18)) throw new Error("账户实际费率与预览不同，请重新核对");
    }
    if (!Number.isFinite(request.market.observedAt) || request.market.observedAt > d.now() + 1000 || d.now() - request.market.observedAt > 5000) throw new Error("签名前行情已过期");
    const appendix = packOrderAppendix({ orderExecutionType: request.reduceOnly ? "ioc" : "post_only", reduceOnly: request.reduceOnly, ...(margin === undefined ? {} : { isolated: { margin } }) });
    const raw: Obj = { product_id: request.market.productId, order: { sender: orderSender, priceX18: price.toString(), amount: (request.side === "buy" ? amount : -amount).toString(), expiration: String(Math.floor(request.expiresAt / 1000)), nonce: String(getOrderNonce()), appendix: appendix.toString() }, spot_leverage: false, borrow_margin: false };
    await assertIdentity(request.wallet);
    if (d.now() - request.market.observedAt > 5000) throw new Error("签名前行情已过期");
    const signer = d.signer(request.wallet.id);
    if (!signer.signTypedData) throw new Error("当前钱包不支持交易签名");
    const signature = await signer.signTypedData(typedOrder(raw), chainId);
    network();
    if (!/^0x[\da-fA-F]{130}$/.test(signature)) throw new Error("钱包返回无效签名");
    raw.signature = signature;
    return { digest: orderHash(raw), sender: orderSender, productId: request.market.productId, side: request.side, amountX18: amount.toString(), priceX18: price.toString(), reduceOnly: request.reduceOnly, marginX18: request.reduceOnly ? undefined : margin?.toString(), expiresAt: request.expiresAt,
      payload: jsonSafe({ place_order: raw, tradeTest: { chainId, wallet: request.wallet, ...(request.reduceOnly ? { positionSender: request.sender } : {}) } }) };
  }
  async function execute(payload: Obj): Promise<Obj> {
    network();
    const res = await d.fetch("/api/nado/relay/execute", { method: "POST", headers: { "content-type": "application/json", "x-nado-chain-id": String(chainId) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
    network();
    if (!res.ok) throw new Error(`Nado 提交结果未知 ${res.status}；须先核对原订单`);
    const body = obj(await res.json());
    if (body.status !== "success") throw new ExecuteRejected(typeof body.error_code === "number" ? body.error_code : undefined, String(body.error ?? ""));
    return body;
  }
  async function broadcast(order: PreparedTestOrder, beforeSend?: () => void | Promise<void>): Promise<void> {
    const meta = obj(order.payload.tradeTest), wallet = obj(meta.wallet) as unknown as TestWallet, raw = obj(order.payload.place_order), wire = obj(raw.order);
    if (meta.chainId !== chainId || sender(wire.sender) !== order.sender || !owns(wallet, order.sender) || id(raw.product_id) !== order.productId || orderHash(raw).toLowerCase() !== digest(order.digest)) throw new Error("保存订单的网络、账户或摘要已改变");
    const signedAmount = integer(wire.amount, "保存订单数量");
    if (abs(signedAmount).toString() !== order.amountX18 || (signedAmount > 0n ? "buy" : "sell") !== order.side || wire.priceX18 !== order.priceX18 || ((BigInt(String(wire.appendix)) & 2048n) !== 0n) !== order.reduceOnly || raw.spot_leverage !== false || raw.borrow_margin !== false) throw new Error("保存订单字段已改变");
    await assertIdentity(wallet);
    // The config read above can be slow. Recheck the durable run/quote AFTER
    // it, at the final network boundary, without changing the signed request.
    if (!Number.isFinite(order.expiresAt) || order.expiresAt <= d.now()) throw new Error("已签名订单已经到期，保留原记录且不发送");
    await beforeSend?.();
    if (order.expiresAt <= d.now()) throw new Error("已签名订单已经到期，保留原记录且不发送");
    const result = await execute({ place_order: raw });
    if (digest(obj(result.data).digest) !== order.digest.toLowerCase()) throw new Error("Nado 回执摘要不匹配，须人工核对");
  }
  async function cancel(wallet: TestWallet, order: PreparedTestOrder): Promise<void> {
    await assertIdentity(wallet);
    if (!owns(wallet, order.sender)) throw new Error("不能取消其他钱包订单");
    const cfg = await d.config(), tx = { sender: sender(order.sender), productIds: [order.productId], digests: [digest(order.digest)], nonce: String(getOrderNonce()) };
    const typed: Eip712TypedData = { domain: getNadoEIP712Domain(cfg.endpoint!, chainId), types: getNadoEIP712Types("cancel_orders"), primaryType: getNadoEIP712PrimaryType("cancel_orders"), message: { ...tx, nonce: BigInt(tx.nonce) } };
    await assertIdentity(wallet);
    const signer = d.signer(wallet.id);
    if (!signer.signTypedData) throw new Error("钱包不支持撤单签名");
    const signature = await signer.signTypedData(typed, chainId);
    await assertIdentity(wallet);
    try {
      await execute({ cancel_orders: { tx, signature } });
    } catch (error) {
      if (!(error instanceof ExecuteRejected) || error.code !== 2020) throw error;
      // Only the documented OrderNotFound error may be reconciled. Unknown
      // responses/timeouts remain errors and never authorize a new placement.
      const current = await query({ type: "orders", sender: order.sender, product_ids: [order.productId] });
      if (sender(current.sender) !== order.sender) throw new Error("撤单核对账户不匹配");
      const rows = array(current.product_orders, "撤单核对挂单").map(x => obj(x));
      const product = rows.find(x => x.product_id === order.productId);
      if (!product || array(product.orders, "撤单核对市场").some(x => digest(obj(x).digest) === order.digest)) throw error;
    }
  }
  async function reports(wallet: TestWallet, orders: PreparedTestOrder[]): Promise<TestOrderReport[]> {
    await assertIdentity(wallet);
    if (!orders.length) return [];
    if (orders.some(o => !owns(wallet, o.sender))) throw new Error("成交报告包含其他钱包订单");
    const response = await read("archiveOrders", { digests: orders.map(o => digest(o.digest)) });
    const rows = array(response.orders, "历史订单").map(x => obj(x));
    return orders.map(order => {
      const matches = rows.filter(x => x.digest === order.digest);
      if (!matches.length) return { digest: order.digest, indexed: false, volumeX18: "0", feeX18: "0", realizedPnlX18: "0" };
      if (matches.length !== 1) throw new Error("历史订单出现重复摘要");
      const row = matches[0]!;
      if (!owns(wallet, sender(row.subaccount)) || id(row.product_id) !== order.productId) throw new Error("历史订单归属不匹配");
      const base = integer(row.base_filled, "已成交数量"), fee = integer(row.fee, "交易及序列器费用"), builder = integer(row.builder_fee, "界面费用");
      if (builder !== 0n) throw new Error("本次无 Builder 订单出现额外费用，须人工核对");
      const quote = integer(row.quote_filled, "已成交净报价金额");
      // quote_filled is net of the order fee. For buys it is -(notional + fee),
      // for sells +(notional - fee); fee already includes sequencer fees.
      const volume = abs(quote + fee);
      if (base === 0n && volume !== 0n || base !== 0n && (base > 0n) !== (order.side === "buy")) throw new Error("历史成交金额或方向不一致");
      const first = Number(integer(row.first_fill_timestamp, "首笔成交时间")) * 1000, last = Number(integer(row.last_fill_timestamp, "末笔成交时间")) * 1000;
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > last) throw new Error("历史成交时间无效");
      return { digest: order.digest, indexed: true, volumeX18: volume.toString(), feeX18: fee.toString(), realizedPnlX18: integer(row.realized_pnl, "已实现盈亏").toString(), firstFillAt: first, lastFillAt: last };
    });
  }
  return { mode: "live", assertIdentity, snapshot, fundingBalance, market, prepare, broadcast, cancel, reports };
}
