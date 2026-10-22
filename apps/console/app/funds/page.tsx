"use client";

import { LinkButton, Text } from "@cloudflare/kumo";
import { WalletIcon } from "@phosphor-icons/react";
import { FundsPanel } from "../components/FundsPanel";
import { NetworkSwitch } from "../components/NetworkSwitch";

export default function FundsPage() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-4 border-b border-kumo-line bg-kumo-base px-4 py-3">
        <nav aria-label="页面导航" className="flex flex-wrap items-center gap-2 text-sm">
          <LinkButton href="/" variant="ghost" size="sm" icon={WalletIcon}>钱包</LinkButton>
          <span aria-hidden="true">/</span>
          <span aria-current="page">批次资金交接</span>
          <LinkButton href="/accounts" variant="secondary" size="sm">管理账户</LinkButton>
        </nav>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div className="flex max-w-2xl flex-col gap-2">
              <Text variant="heading" size="lg" as="h1">批次资金交接</Text>
              <Text variant="secondary">上一批交易结束、资金回到钱包后，依次交给下一批钱包。1 号资金库统一支付 Ink ETH 手续费。</Text>
            </div>
            <div className="w-56"><NetworkSwitch /></div>
          </div>
          <FundsPanel />
        </div>
      </main>
    </div>
  );
}
