"use client";

import { useState } from "react";
import { Banner, Button, ButtonGroup, LayerDialog } from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import { useNetwork } from "./NetworkProvider";
import { NETWORKS } from "../lib/chainEnv";

const TESTNET = 763373;
const MAINNET = 57073;

/** Both choices reload the app after updating its network cookie. Mainnet asks for confirmation. */
export function NetworkSwitch() {
  const { chainId, setChain } = useNetwork();
  const [confirm, setConfirm] = useState(false);

  const pick = (id: number) => {
    if (id === chainId) return;
    if (id === MAINNET) { setConfirm(true); return; } // guard before real funds
    setChain(id);
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-kumo-subtle">网络</span>
      <ButtonGroup aria-label="网络" className="w-full">
        {[TESTNET, MAINNET].map((id) => {
          const active = chainId === id;
          return (
            <Button
              key={id}
              size="sm"
              variant={active ? "primary" : "secondary"}
              aria-pressed={active}
              className="flex-1 capitalize"
              onClick={() => pick(id)}
            >
              {NETWORKS[id]!.isTestnet ? "测试网" : "主网"}
            </Button>
          );
        })}
      </ButtonGroup>
      <p className="text-xs text-kumo-subtle">切换网络会刷新页面，请重新解锁保险库。</p>

      <LayerDialog.Alert open={confirm} onOpenChange={setConfirm}>
        <LayerDialog.Content size="sm">
          <LayerDialog.Title>切换到主网？</LayerDialog.Title>
          <LayerDialog.Description>
            主网连接 Ink 上的真实 USDT0 和 ETH 资产。切换连接本身不会转账或下单。
          </LayerDialog.Description>
          <LayerDialog.Body>
            <Banner
              variant="alert"
              size="sm"
              icon={<WarningIcon weight="fill" />}
              description="切换后会刷新页面并要求重新解锁。之后手动提交的订单、充值和提现会使用真实资金。"
            />
          </LayerDialog.Body>
          <LayerDialog.Actions>
            <LayerDialog.Actions.Primary
              variant="primary"
              data-net="mainnet"
              onClick={() => { setConfirm(false); setChain(MAINNET); }}
            >
              确认切换主网
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </div>
  );
}
