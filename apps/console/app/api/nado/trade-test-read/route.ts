import { NextResponse } from "next/server";
import { chainIdFromCookieHeader } from "../../../lib/chainEnv";
import { paceRead, tradeTestReadTarget } from "../../../lib/tradeTest/readProxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  if (!["1", "true"].includes(process.env.NADO_LIVE ?? "")) return NextResponse.json({ error: "live mode disabled" }, { status: 503 });
  const chainId = chainIdFromCookieHeader(req.headers.get("cookie"));
  let target: ReturnType<typeof tradeTestReadTarget>;
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 24_000) throw new Error("请求过大");
    body = JSON.parse(text) as Record<string, unknown>;
    target = tradeTestReadTarget(body, chainId);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "无效请求" }, { status: 400 });
  }
  try {
    await paceRead(chainId, body!);
    const observedAt = Date.now();
    const response = await fetch(target.url, { method: target.body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: target.body, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return NextResponse.json({ error: `Nado read ${response.status}` }, { status: response.status });
    return NextResponse.json({ chainId, observedAt, result: await response.json() }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "公开读取失败" }, { status: 502 });
  }
}
