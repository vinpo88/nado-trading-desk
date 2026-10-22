import { describe, expect, it, vi } from "vitest";
import { createBrowserTradeTestAdapter } from "../../../../apps/console/app/lib/tradeTest/browserAdapter";
import { createTradeTestReadPacer, tradeTestReadTarget } from "../../../../apps/console/app/lib/tradeTest/readProxy";
import { NETWORKS } from "../../../../apps/console/app/lib/chainEnv";
import type { OrderRequest, PreparedTestOrder, TestMarket, TestWallet } from "../../../../apps/console/app/lib/tradeTest/types";
import { assertCleanSnapshot, DEFAULT_TEST_SETTINGS, human, planOpening, requiredTestBalance } from "../../../../apps/console/app/lib/tradeTest/planner";

// No keys, custody, real cryptographic signatures, or live requests in this suite.
vi.mock("../../../../apps/console/app/lib/custody", () => ({ signerForWalletId: () => { throw new Error("real custody forbidden"); } }));
vi.mock("../../../../apps/console/app/lib/liveConfig", () => ({ getLiveConfig: () => { throw new Error("real network forbidden"); } }));

const X18 = 10n ** 18n;
const units = (n: number) => (BigInt(n) * X18).toString();
const wallet: TestWallet = { id: "mock:0", address: "0x1111111111111111111111111111111111111111", label: "fixture" };
const parent = `${wallet.address}64656661756c740000000000`;
const child = `${wallet.address}${"aa".repeat(12)}`;
const digest = `0x${"ab".repeat(32)}`;
const endpoint = "0x2222222222222222222222222222222222222222";
const signature = `0x${"11".repeat(65)}` as `0x${string}`;
type Obj = Record<string, any>;

function fixture() {
  const state = { now: 1_800_000_000_000, chainId: 57073, accountAddress: wallet.address as string, advanceSign: 0, responseDelay: 0, configDelay: 0 };
  const product = { product_id: 92, oracle_price_x18: units(1), risk: { long_weight_initial_x18: "975000000000000000", short_weight_initial_x18: "1025000000000000000" } };
  const universe: Obj = { spot_products: [{ product_id: 0 }], perp_products: [product] };
  const account: Obj = { subaccount: parent, exists: true, spot_balances: [{ product_id: 0, balance: { amount: units(100) } }], perp_balances: [], ...universe };
  const isolated: Obj = { isolated_positions: [] };
  const symbols: Obj = { "EURUSD-PERP": { symbol: "EURUSD-PERP", type: "perp", product_id: 92, isolated_only: true, trading_status: "live", market_hours: { is_open: true }, min_size: units(100), size_increment: units(1), price_increment_x18: "10000000000000", maker_fee_rate_x18: "20000000000000", taker_fee_rate_x18: "70000000000000" } };
  const ordersBySender: Record<string, Obj[]> = {};
  const history: Obj = { orders: [] };
  const overrides = new Map<string, unknown>();
  const requests: { path: string; body: Obj; observedAt?: number }[] = [];
  let pacer: ((weight: number) => Promise<void>) | undefined;
  const sign = vi.fn(async (_typed: unknown, _chain: number) => { state.now += state.advanceSign; return signature; });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), body = JSON.parse(String(init?.body)) as Obj;
    const record: typeof requests[number] = { path, body };
    requests.push(record);
    if (path === "/api/nado/relay/execute") {
      if (body.cancel_orders) return Response.json(overrides.get("cancelExecute") ?? { status: "success", data: { cancelled_orders: [] } });
      return Response.json(overrides.get("execute") ?? { status: "error", error_code: 9999, error: "mock execution disabled" });
    }
    if (path !== "/api/nado/trade-test-read") throw new Error(`external request forbidden: ${path}`);
    const type = body.query?.type;
    if (pacer) await pacer(type === "orders" ? body.query.product_ids.length * 2 : type === "isolated_positions" ? 10 : type === "all_products" ? 5 : 2);
    const observedAt = state.now;
    record.observedAt = observedAt;
    state.now += state.responseDelay;
    let result: unknown;
    if (body.kind === "symbols") result = symbols;
    else if (body.kind === "archiveOrders") result = history;
    else {
      let data: unknown;
      if (overrides.has(type)) data = overrides.get(type);
      else if (type === "all_products") data = universe;
      else if (type === "symbols") data = { symbols };
      else if (type === "subaccount_info") data = account;
      else if (type === "isolated_positions") data = isolated;
      else if (type === "market_price") data = { product_id: 92, bid_x18: units(1), ask_x18: "1000010000000000000" };
      else if (type === "fee_rates") {
        const maker = Array(93).fill("0"), taker = Array(93).fill("0");
        maker[92] = symbols["EURUSD-PERP"].maker_fee_rate_x18; taker[92] = symbols["EURUSD-PERP"].taker_fee_rate_x18;
        data = { maker_fee_rates_x18: maker, taker_fee_rates_x18: taker, health_check_sequencer_fee: "20000000000000000", taker_sequencer_fee: "10000000000000000" };
      } else if (type === "orders") data = { sender: body.query.sender, product_orders: body.query.product_ids.map((pid: number) => ({ product_id: pid, orders: (ordersBySender[body.query.sender] ?? []).filter(o => o.product_id === pid) })) };
      else throw new Error(`unexpected mock read ${type}`);
      result = { status: "success", data };
    }
    return Response.json({ chainId: state.chainId, observedAt, result });
  });
  const config = vi.fn(async () => { state.now += state.configDelay; return { enabled: true, chainId: state.chainId, endpoint }; });
  const adapter = createBrowserTradeTestAdapter({ fetch: fetchMock, now: () => state.now,
    network: () => NETWORKS[state.chainId]!, config,
    signer: () => ({ address: { family: "evm", value: state.accountAddress }, signTypedData: sign }) as any,
  });
  const addPosition = (amount = units(1)) => isolated.isolated_positions.push({ subaccount: child, base_balance: { product_id: 92, balance: { amount, v_quote_balance: units(-1) } }, quote_balance: { product_id: 0, balance: { amount: units(5) } }, base_product: product });
  const market = (): TestMarket => ({ symbol: "EURUSD-PERP", productId: 92, observedAt: state.now, isOpen: true, isolatedOnly: true, maxLeverage: 40, minNotionalX18: units(100), sizeIncrementX18: units(1), priceIncrementX18: "10000000000000", bidX18: units(1), askX18: "1000010000000000000", oracleX18: units(1), makerFeeRateX18: "20000000000000", takerFeeRateX18: "70000000000000" });
  const open = (): OrderRequest => ({ wallet, market: market(), side: "buy", amountX18: units(100), priceX18: units(1), marginX18: units(5), reduceOnly: false, expiresAt: state.now + 60_000 });
  return { adapter, state, product, universe, account, isolated, symbols, ordersBySender, history, requests, overrides, sign, fetchMock, config, addPosition, market, open,
    usePacer: () => { pacer = createTradeTestReadPacer(() => state.now, async ms => { state.now += ms; }); } };
}

describe("browser live trading adapter with mock custody and transport", () => {
  it("observes funding credit through one fresh account read after a slow config request", async () => {
    const f = fixture(), start = f.state.now;
    f.state.configDelay = 37_000; f.state.responseDelay = 100;
    expect(await f.adapter.fundingBalance!(wallet)).toEqual({ parentSender: parent, quoteBalanceX18: units(100), observedAt: start + 37_000 });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.body.query).toEqual({ type: "subaccount_info", subaccount: parent });
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.requests.some(r => r.path.endsWith("execute"))).toBe(false);
  });

  it("does not cache funding balances or skip complete market checks for trading snapshots", async () => {
    const f = fixture();
    expect((await f.adapter.fundingBalance!(wallet)).quoteBalanceX18).toBe(units(100));
    f.account.spot_balances[0].balance.amount = units(107); f.state.now += 100;
    expect((await f.adapter.fundingBalance!(wallet)).quoteBalanceX18).toBe(units(107));
    expect(f.requests.map(r => r.body.query?.type)).toEqual(["subaccount_info", "subaccount_info"]);
    await f.adapter.snapshot(wallet);
    expect(f.requests.some(r => r.body.query?.type === "orders")).toBe(true);
    expect(f.requests.some(r => r.body.query?.type === "isolated_positions")).toBe(true);
    expect(f.requests.some(r => r.body.query?.type === "fee_rates")).toBe(true);
  });

  it.each([
    ["foreign subaccount", (f: ReturnType<typeof fixture>) => { f.account.subaccount = child; }],
    ["missing existence", (f: ReturnType<typeof fixture>) => { delete f.account.exists; }],
    ["missing quote", (f: ReturnType<typeof fixture>) => { f.account.spot_balances = []; }],
    ["duplicate quote", (f: ReturnType<typeof fixture>) => { f.account.spot_balances.push(structuredClone(f.account.spot_balances[0])); }],
    ["negative quote", (f: ReturnType<typeof fixture>) => { f.account.spot_balances[0].balance.amount = "-1"; }],
    ["malformed quote", (f: ReturnType<typeof fixture>) => { f.account.spot_balances[0].balance.amount = "NaN"; }],
    ["nonexistent account with balance", (f: ReturnType<typeof fixture>) => { f.account.exists = false; }],
  ])("rejects %s during lightweight funding observation", async (_label, breakRead) => {
    const f = fixture(); breakRead(f);
    await expect(f.adapter.fundingBalance!(wallet)).rejects.toThrow();
    expect(f.sign).not.toHaveBeenCalled();
  });

  it("allows a genuinely uninitialized default account with zero funds", async () => {
    const f = fixture(); f.account.exists = false; f.account.spot_balances = [];
    expect((await f.adapter.fundingBalance!(wallet)).quoteBalanceX18).toBe("0");
  });

  it("preserves a delayed funding observation so the controller can reject or reread it", async () => {
    const f = fixture(), startedAt = f.state.now; f.state.responseDelay = 5001;
    const balance = await f.adapter.fundingBalance!(wallet);
    expect(balance.observedAt).toBe(startedAt);
    expect(f.state.now - balance.observedAt).toBe(5001);
    expect(f.requests).toHaveLength(1);
  });

  it("shares only concurrent configuration reads and revalidates custody after the await", async () => {
    const f = fixture();
    await Promise.all([f.adapter.assertIdentity(wallet, 57073), f.adapter.assertIdentity(wallet, 57073)]);
    expect(f.config).toHaveBeenCalledTimes(1);
    await f.adapter.assertIdentity(wallet, 57073);
    expect(f.config).toHaveBeenCalledTimes(2);
    const identity = f.adapter.assertIdentity(wallet, 57073);
    f.state.accountAddress = endpoint;
    await expect(identity).rejects.toThrow(/钱包地址/);
    expect(f.config).toHaveBeenCalledTimes(3);
  });

  it("queries every registered market status while retaining nonmarket collateral checks", async () => {
    const f = fixture();
    f.universe.spot_products.push({ product_id: 11, book_info: { size_increment: units(1), price_increment_x18: units(1), min_size: units(100) } });
    for (const [productId, status] of [[44, "not_tradable"], [60, "post_only"], [62, "reduce_only"]] as const) {
      f.universe.perp_products.push({ ...f.product, product_id: productId });
      const symbol = `M${productId}-PERP`;
      f.symbols[symbol] = { ...f.symbols["EURUSD-PERP"], symbol, product_id: productId, trading_status: status };
    }
    const snapshot = await f.adapter.snapshot(wallet);
    expect(f.requests.find(r => r.body.query?.type === "orders")!.body.query.product_ids).toEqual([92, 44, 60, 62]);
    expect(snapshot.hasOtherCollateral).toBe(false);
    f.account.spot_balances.push({ product_id: 11, balance: { amount: units(1) } });
    expect(() => assertCleanSnapshot({ ...snapshot, hasOtherCollateral: true })).toThrow(/抵押/);
    expect((await f.adapter.snapshot(wallet)).hasOtherCollateral).toBe(true);
  });

  it("rejects incomplete, conflicting market registries and an unqueryable isolated position", async () => {
    const f = fixture();
    f.overrides.set("symbols", { symbols: { BAD: { symbol: "BAD", product_id: 999, type: "spot" } } });
    await expect(f.adapter.snapshot(wallet)).rejects.toThrow(/不一致/);
    f.overrides.set("symbols", { symbols: { ...f.symbols, DUP: { symbol: "DUP", product_id: 92, type: "perp" } } });
    await expect(f.adapter.snapshot(wallet)).rejects.toThrow(/重复/);
    f.overrides.delete("symbols");
    f.universe.perp_products.push({ ...f.product, product_id: 11 });
    f.addPosition(); f.isolated.isolated_positions[0].base_balance.product_id = 11;
    await expect(f.adapter.snapshot(wallet)).rejects.toThrow(/没有可查询的市场/);
  });
  it("strictly selects FX metadata and preserves sub-basis-point fees", async () => {
    const f = fixture();
    expect(await f.adapter.market("EURUSD-PERP")).toMatchObject({ symbol: "EURUSD-PERP", maxLeverage: 40, isolatedOnly: true, minNotionalX18: units(100), makerFeeRateX18: "20000000000000", takerFeeRateX18: "70000000000000" });
    await expect(f.adapter.market("SPY-PERP")).rejects.toThrow(/所选市场/);
    await expect(f.adapter.market("wSPYx")).rejects.toThrow(/永续/);
    delete f.symbols["EURUSD-PERP"].market_hours;
    await expect(f.adapter.market("EURUSD-PERP")).rejects.toThrow(/交易时段/);
    expect(f.sign).not.toHaveBeenCalled();
  });

  it("uses original absolute order amount and includes unsettled quote in equity", async () => {
    const f = fixture();
    f.addPosition();
    f.account.perp_balances.push({ product_id: 92, balance: { amount: "0", v_quote_balance: units(2) } });
    f.ordersBySender[parent] = [{ product_id: 92, sender: parent, digest, amount: units(-100), unfilled_amount: units(-40), price_x18: units(1) }];
    const snapshot = await f.adapter.snapshot(wallet);
    expect(snapshot).toMatchObject({ quoteBalanceX18: units(100), equityX18: units(107), fixedFeeReserveX18: "90000000000000000", hasCrossPosition: false, hasOtherCollateral: false });
    expect(snapshot.openOrders[0]!.amountX18).toBe(units(100));
    expect(snapshot.positions[0]).toMatchObject({ sender: child, amountX18: units(1), quoteX18: units(4) });
    const childRead = f.requests.find(r => r.body.query?.sender === child)!;
    expect(childRead.body.query.product_ids).toEqual([92]);
  });

  it("fails closed on incomplete order coverage and foreign isolated owners", async () => {
    const f = fixture();
    f.overrides.set("orders", { sender: parent, product_orders: [] });
    await expect(f.adapter.snapshot(wallet)).rejects.toThrow(/全部市场/);
    f.overrides.delete("orders"); f.addPosition();
    f.isolated.isolated_positions[0].subaccount = `0x${"99".repeat(32)}`;
    await expect(f.adapter.snapshot(wallet)).rejects.toThrow(/归属/);
  });

  it("fails closed when fixed fee reserve inputs are missing or negative", async () => {
    const f = fixture();
    f.overrides.set("fee_rates", { health_check_sequencer_fee: "0" });
    await expect(f.adapter.snapshot(wallet)).rejects.toThrow(/固定费/);
    f.overrides.set("fee_rates", { health_check_sequencer_fee: "0", taker_sequencer_fee: "-1" });
    await expect(f.adapter.snapshot(wallet)).rejects.toThrow(/负数/);
  });

  it("retains the earliest true read time rather than stamping slow results as fresh", async () => {
    const f = fixture(); f.state.responseDelay = 150;
    const start = f.state.now;
    const snapshot = await f.adapter.snapshot(wallet);
    expect(snapshot.observedAt).toBe(start + 300); // asset and market registries are metadata; parent orders are the first account sample
    expect(snapshot.observedAt).toBeLessThan(f.state.now);
    const marketStart = f.state.now;
    const market = await f.adapter.market("EURUSD-PERP");
    expect(market.observedAt).toBe(marketStart + 150); // earliest oracle/BBO upstream request
    expect(market.observedAt).toBeLessThan(f.state.now);
  });

  it("signs bounded isolated opening without broadcasting, retaining an exact replayable payload", async () => {
    const f = fixture();
    const order = await f.adapter.prepare(f.open());
    const raw = order.payload.place_order as Obj;
    expect(order).toMatchObject({ sender: parent, marginX18: units(5), amountX18: units(100), reduceOnly: false });
    expect(BigInt(raw.order.appendix) & 256n).toBe(256n);
    expect(BigInt(raw.order.appendix) >> 64n).toBe(5_000_000n);
    expect(raw).toMatchObject({ spot_leverage: false, borrow_margin: false, signature });
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(f.requests.some(r => r.path.endsWith("execute"))).toBe(false);
    f.overrides.set("execute", { status: "success", data: { digest: order.digest } });
    await f.adapter.broadcast(order);
    expect(f.requests.at(-1)!.body).toEqual({ place_order: raw });
  });

  it("closes a sub-minimum residual using parent sender and isolated margin zero, without adding margin", async () => {
    const f = fixture(); f.addPosition();
    const order = await f.adapter.prepare({ wallet, market: f.market(), side: "sell", amountX18: units(1), priceX18: units(1), sender: child, reduceOnly: true, expiresAt: f.state.now + 60_000 });
    const raw = order.payload.place_order as Obj;
    expect(order.sender).toBe(parent);
    expect(order.marginX18).toBeUndefined();
    expect(order.amountX18).toBe(units(1));
    expect(raw.order).toMatchObject({ sender: parent, amount: units(-1), appendix: "2817" });
    expect(order.payload.tradeTest).toMatchObject({ positionSender: child });
    await expect(f.adapter.prepare({ ...f.open(), sender: child, marginX18: undefined, reduceOnly: true, side: "sell", amountX18: units(2) })).rejects.toThrow(/实时仓位/);
  });

  it("rejects excess notional, stale quotes, changed identities and changed networks before execution", async () => {
    const f = fixture();
    await expect(f.adapter.prepare({ ...f.open(), amountX18: units(151), marginX18: units(8) })).rejects.toThrow(/上限/);
    const request = f.open(); f.state.now += 5001;
    await expect(f.adapter.prepare(request)).rejects.toThrow(/行情已过期/);
    const order = await f.adapter.prepare(f.open());
    f.state.accountAddress = endpoint;
    await expect(f.adapter.broadcast(order)).rejects.toThrow(/钱包地址/);
    f.state.accountAddress = wallet.address; f.state.chainId = 763373;
    await expect(f.adapter.broadcast(order)).rejects.toThrow(/网络已改变/);
    expect(f.requests.filter(r => r.path.endsWith("execute"))).toHaveLength(0);
  });

  it("runs the final freshness guard after a slow config read and never executes an aged quote", async () => {
    const f = fixture(), request = f.open(), order = await f.adapter.prepare(request), saved = structuredClone(order);
    f.state.configDelay = 5001;
    const guard = vi.fn(async () => {
      expect(f.state.now - request.market.observedAt).toBe(5001);
      throw new Error("mock durable quote has expired");
    });
    await expect(f.adapter.broadcast(order, guard)).rejects.toThrow("mock durable quote has expired");
    expect(guard).toHaveBeenCalledTimes(1);
    expect(f.requests.filter(r => r.path.endsWith("execute"))).toHaveLength(0);
    expect(order).toEqual(saved);
    expect(f.sign).toHaveBeenCalledTimes(1);
  });

  it("rejects an order that expires during the final config read without submitting or resigning", async () => {
    const f = fixture(), order = await f.adapter.prepare(f.open()), saved = structuredClone(order), guard = vi.fn();
    f.state.configDelay = 60_000;
    await expect(f.adapter.broadcast(order, guard)).rejects.toThrow("已经到期");
    expect(guard).not.toHaveBeenCalled();
    expect(f.requests.filter(r => r.path.endsWith("execute"))).toHaveLength(0);
    expect(order).toEqual(saved);
    expect(f.sign).toHaveBeenCalledTimes(1);
  });

  it("rechecks expiry after an asynchronous final guard", async () => {
    const f = fixture(), order = await f.adapter.prepare(f.open());
    await expect(f.adapter.broadcast(order, async () => { f.state.now = order.expiresAt; })).rejects.toThrow("已经到期");
    expect(f.requests.filter(r => r.path.endsWith("execute"))).toHaveLength(0);
  });

  it("reconciles only OrderNotFound cancellation after proving the digest absent", async () => {
    const f = fixture(), order = await f.adapter.prepare(f.open());
    f.overrides.set("cancelExecute", { status: "error", error_code: 2020, error: "Order not found" });
    await expect(f.adapter.cancel(wallet, order)).resolves.toBeUndefined();
    f.ordersBySender[parent] = [{ product_id: 92, digest: order.digest }];
    await expect(f.adapter.cancel(wallet, order)).rejects.toThrow(/2020/);
    f.overrides.set("cancelExecute", { status: "error", error_code: 2010, error: "other rejection" });
    await expect(f.adapter.cancel(wallet, order)).rejects.toThrow(/2010/);
  });

  it("calculates filled notional from net quote plus fee without charging the sequencer twice", async () => {
    const f = fixture(), buy = await f.adapter.prepare(f.open());
    const sell: PreparedTestOrder = { ...buy, digest, side: "sell" };
    f.history.orders = [
      { digest: buy.digest, subaccount: parent, product_id: 92, base_filled: units(100), quote_filled: "-100007000000000000000", fee: "7000000000000000", sequencer_fee: "1000000000000000", builder_fee: "0", first_fill_timestamp: "1800000000", last_fill_timestamp: "1800000001", realized_pnl: "0" },
      { digest, subaccount: parent, product_id: 92, base_filled: units(-100), quote_filled: "99993000000000000000", fee: "7000000000000000", sequencer_fee: "1000000000000000", builder_fee: "0", first_fill_timestamp: "1800000002", last_fill_timestamp: "1800000003", realized_pnl: "0" },
    ];
    const reports = await f.adapter.reports(wallet, [buy, sell]);
    expect(reports.map(r => r.volumeX18)).toEqual([units(100), units(100)]);
    expect(reports.map(r => r.feeX18)).toEqual(["7000000000000000", "7000000000000000"]);
    f.history.orders = [];
    expect((await f.adapter.reports(wallet, [buy]))[0]!.indexed).toBe(false);
    f.history.orders = undefined;
    await expect(f.adapter.reports(wallet, [buy])).rejects.toThrow(/历史订单/);
  });

  it("allows complete 96-product rounds with bounded burst pacing while keeping fresh account and quotes", async () => {
    const f = fixture(); f.usePacer(); f.state.responseDelay = 40;
    f.universe.perp_products = Array.from({ length: 96 }, (_, i) => ({ ...f.product, product_id: i + 1 }));
    for (let productId = 1; productId <= 96; productId++) {
      if (productId === 92) continue;
      const symbol = `M${productId}-PERP`;
      f.symbols[symbol] = { ...f.symbols["EURUSD-PERP"], symbol, product_id: productId };
    }
    f.account.perp_products = f.universe.perp_products;
    f.addPosition();
    const starts: number[] = [];
    for (let round = 0; round < 3; round++) {
      const snapshot = await f.adapter.snapshot(wallet);
      const market = await f.adapter.market("EURUSD-PERP");
      const order = await f.adapter.prepare({ ...f.open(), market });
      expect(order.amountX18).toBe(units(100));
      expect(f.state.now - snapshot.observedAt).toBeLessThan(5000);
      expect(f.state.now - market.observedAt).toBeLessThan(5000);
      starts.push(snapshot.observedAt);
    }
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(10_000);
    expect(f.requests.filter(r => r.path.endsWith("execute"))).toHaveLength(0);
  });
});

describe("read-only trading proxy allowlist", () => {
  it("only produces fixed read endpoints and binds the cookie network", () => {
    expect(tradeTestReadTarget({ chainId: 57073, kind: "symbols" }, 57073)).toEqual({ url: "https://api.prod.nado.xyz/archive/v2/symbols" });
    expect(tradeTestReadTarget({ chainId: 57073, kind: "query", query: { type: "symbols" } }, 57073).body).toBe('{"type":"symbols"}');
    expect(JSON.parse(tradeTestReadTarget({ chainId: 57073, kind: "depositEvents", subaccount: parent }, 57073).body!)).toEqual({ events: { subaccounts: [parent], product_ids: [0], event_types: ["deposit_collateral"], desc: true, limit: { raw: 10 } } });
    expect(tradeTestReadTarget({ chainId: 57073, kind: "query", query: { type: "orders", sender: parent, product_ids: [92] } }, 57073).url).toBe("https://api.prod.nado.xyz/gateway/v1/query");
    for (const body of [
      { chainId: 763373, kind: "symbols" },
      { chainId: 57073, kind: "symbols", url: "https://example.com" },
      { chainId: 57073, kind: "query", query: { type: "place_order" } },
      { chainId: 57073, kind: "query", query: { type: "orders", sender: parent, product_ids: [] } },
      { chainId: 57073, kind: "archiveOrders", digests: ["bad"] },
      { chainId: 57073, kind: "depositEvents", subaccount: "bad" },
      { chainId: 57073, kind: "depositEvents", subaccount: parent, query: { event_types: ["match_orders"] } },
    ]) expect(() => tradeTestReadTarget(body, 57073)).toThrow();
  });
});

// Explicit opt-in smoke test of PUBLIC reads only. Signing and executes are forbidden.
it.skipIf(process.env.NADO_TRADE_READ_SMOKE !== "1")("reads actual mainnet preflight data without keys or signing", async () => {
  const configResponse = await fetch("http://127.0.0.1:18270/api/nado/state", { headers: { cookie: "nado-chain-id=57073" }, signal: AbortSignal.timeout(15000) });
  const config = await configResponse.json();
  const addresses = (process.env.NADO_TRADE_READ_ADDRESSES ?? "").split(",").filter(Boolean) as `0x${string}`[];
  expect(addresses.length).toBeGreaterThan(0);
  expect(addresses.length).toBeLessThanOrEqual(10);
  for (const address of addresses) expect(address).toMatch(/^0x[\da-f]{40}$/);
  for (const [index, address] of addresses.entries()) {
    const targetWallet: TestWallet = { id: `read-only:${index}`, address, label: `${index + 1}` };
    const adapter = createBrowserTradeTestAdapter({
      network: () => NETWORKS[57073]!, config: async () => config,
      signer: () => ({ address: { family: "evm", value: address }, signTypedData: async () => { throw new Error("Live smoke MUST NOT sign"); } }) as any,
      fetch: async (input, init) => {
        if (String(input) !== "/api/nado/trade-test-read") throw new Error("Live smoke MUST NOT execute");
        const response = await fetch(`http://127.0.0.1:18270${input}`, { ...init, headers: { "content-type": "application/json", cookie: "nado-chain-id=57073" }, signal: AbortSignal.timeout(15000) });
        expect(response.ok).toBe(true);
        return response;
      },
    });
    const fundingStartedAt = Date.now();
    const funding = await adapter.fundingBalance!(targetWallet);
    console.log(JSON.stringify({ observation: "fundingBalance", address, elapsedMs: Date.now() - fundingStartedAt,
      ageMs: Date.now() - funding.observedAt, nadoBalance: human(funding.quoteBalanceX18) }));
    expect(funding.parentSender.slice(0, 42)).toBe(address);
    expect(Date.now() - funding.observedAt).toBeLessThan(5000);
    const snapshotStartedAt = Date.now();
    const snapshot = await adapter.snapshot(targetWallet);
    console.log(JSON.stringify({ observation: "snapshot", address, elapsedMs: Date.now() - snapshotStartedAt,
      ageMs: Date.now() - snapshot.observedAt, nadoBalance: human(snapshot.quoteBalanceX18),
      openOrders: snapshot.openOrders.length, positions: snapshot.positions.filter(p => BigInt(p.amountX18) !== 0n).length }));
    expect(snapshot.parentSender.slice(0, 42)).toBe(address);
    expect(Date.now() - snapshot.observedAt).toBeLessThan(5000);
    const market = await adapter.market("EURUSD-PERP");
    const planned = planOpening(market, DEFAULT_TEST_SETTINGS, index % 2 ? "sell" : "buy");
    console.log(JSON.stringify({ wallet: index + 1, nadoBalance: human(snapshot.quoteBalanceX18), minimumWithReserve: human(requiredTestBalance(snapshot, planned.minimumBalanceX18).toString()), openOrders: snapshot.openOrders.length, positions: snapshot.positions.filter(p => BigInt(p.amountX18) !== 0n).length }));
  }
}, 90_000);
