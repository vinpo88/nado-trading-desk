const HEX32 = /^0x[\da-fA-F]{64}$/;
const OBJECT = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keysOnly = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
/** Burst-aware rolling limits, leaving 25% for other console reads on the same IP. */
export function createTradeTestReadPacer(now = Date.now, sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))) {
  let events: { at: number; weight: number }[] = [];
  let tail = Promise.resolve();
  return (weight: number): Promise<void> => {
    if (!Number.isInteger(weight) || weight < 1 || weight > 300) return Promise.reject(new Error("读取权重超出单次预算"));
    const queuedAt = now();
    const task = tail.catch(() => {}).then(async () => {
      while (true) {
        const current = now();
        if (current - queuedAt > 20_000) throw new Error("读取队列繁忙，请稍后继续");
        events = events.filter(e => e.at > current - 60_000);
        const recent = events.filter(e => e.at > current - 10_000);
        if (recent.reduce((sum, e) => sum + e.weight, 0) + weight <= 300 && events.reduce((sum, e) => sum + e.weight, 0) + weight <= 1800) {
          events.push({ at: current, weight }); return;
        }
        const waits = [
          ...(recent.reduce((sum, e) => sum + e.weight, 0) + weight > 300 ? [recent[0]!.at + 10_000 - current] : []),
          ...(events.reduce((sum, e) => sum + e.weight, 0) + weight > 1800 ? [events[0]!.at + 60_000 - current] : []),
        ];
        await sleep(Math.max(1, ...waits));
      }
    });
    tail = task; return task;
  };
}
const pacers = new Map<number, ReturnType<typeof createTradeTestReadPacer>>();
export async function paceRead(chainId: number, body: Record<string, unknown>): Promise<void> {
  const q = OBJECT(body.query) ? body.query : {};
  const weight = q.type === "orders" && Array.isArray(q.product_ids) ? 2 * q.product_ids.length : q.type === "isolated_positions" ? 10 : q.type === "all_products" ? 5 : body.kind === "depositEvents" ? 3 : 2;
  let pace = pacers.get(chainId);
  if (!pace) { pace = createTradeTestReadPacer(); pacers.set(chainId, pace); }
  await pace(weight);
}

/** A deliberately read-only, bounded allowlist. It cannot relay an execute or an arbitrary URL. */
export function tradeTestReadTarget(body: unknown, chainId: number): { url: string; body?: string } {
  if (!OBJECT(body) || body.chainId !== chainId || !keysOnly(body, ["chainId", "kind", "query", "digests", "subaccount"])) throw new Error("测试读取网络或参数不匹配");
  const base = chainId === 57073 ? "https://api.prod.nado.xyz" : chainId === 763373 ? "https://api.test.nado.xyz" : undefined;
  if (!base) throw new Error("不支持的网络");
  if (body.kind === "symbols" && keysOnly(body, ["chainId", "kind"])) return { url: `${base}/archive/v2/symbols` };
  if (body.kind === "depositEvents" && keysOnly(body, ["chainId", "kind", "subaccount"])) {
    if (typeof body.subaccount !== "string" || !HEX32.test(body.subaccount)) throw new Error("充值查询账户不正确");
    return { url: `${base}/archive/v1`, body: JSON.stringify({ events: { subaccounts: [body.subaccount], product_ids: [0], event_types: ["deposit_collateral"], desc: true, limit: { raw: 10 } } }) };
  }
  if (body.kind === "archiveOrders" && keysOnly(body, ["chainId", "kind", "digests"])) {
    if (!Array.isArray(body.digests) || !body.digests.length || body.digests.length > 60 || body.digests.some(d => typeof d !== "string" || !HEX32.test(d))) throw new Error("订单摘要不正确");
    return { url: `${base}/archive/v1`, body: JSON.stringify({ orders: { digests: body.digests, limit: body.digests.length } }) };
  }
  if (body.kind !== "query" || !keysOnly(body, ["chainId", "kind", "query"]) || !OBJECT(body.query)) throw new Error("只允许测试所需的公开读取");
  const q = body.query;
  const pid = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
  const hex = (v: unknown) => typeof v === "string" && HEX32.test(v);
  const valid =
    ((q.type === "all_products" || q.type === "contracts" || q.type === "symbols") && keysOnly(q, ["type"])) ||
    ((q.type === "subaccount_info" || q.type === "isolated_positions") && keysOnly(q, ["type", "subaccount"]) && hex(q.subaccount)) ||
    (q.type === "fee_rates" && keysOnly(q, ["type", "sender"]) && hex(q.sender)) ||
    (q.type === "market_price" && keysOnly(q, ["type", "product_id"]) && pid(q.product_id)) ||
    (q.type === "orders" && keysOnly(q, ["type", "sender", "product_ids"]) && hex(q.sender) && Array.isArray(q.product_ids) && q.product_ids.length > 0 && q.product_ids.length <= 200 && q.product_ids.every(pid));
  if (!valid) throw new Error("该读取类型或参数不在白名单内");
  return { url: `${base}/gateway/v1/query`, body: JSON.stringify(q) };
}
