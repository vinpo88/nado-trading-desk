"use client";

import { LinkButton } from "@cloudflare/kumo";
import { NetworkSwitch } from "../components/NetworkSwitch";
import { TradeTestPanel } from "../components/TradeTestPanel";

export default function TradeTestPage() {
  return <div className="flex h-dvh flex-col overflow-hidden">
    <header className="flex items-center justify-between gap-4 border-b border-kumo-line bg-kumo-base px-4 py-3"><nav className="flex gap-2 items-center text-sm" aria-label="页面导航"><LinkButton href="/" variant="ghost" size="sm">钱包</LinkButton><span>/</span><span aria-current="page">自动交易测试</span><LinkButton href="/funds" variant="secondary" size="sm">资金交接</LinkButton></nav></header>
    <main className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-7xl space-y-5 px-4 py-6"><div className="flex flex-wrap gap-4 justify-between"><div><h1 className="text-2xl font-semibold">自动交易测试</h1><p className="mt-2 text-sm text-kumo-subtle">外汇优先，以真实成交、实际成本和能否稳定收尾评估下一批。</p></div><div className="w-56"><NetworkSwitch /></div></div><TradeTestPanel /></div></main>
  </div>;
}
