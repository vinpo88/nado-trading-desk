"use client";

import { Button, LinkButton, Meter, Sidebar as KumoSidebar, Text } from "@cloudflare/kumo";
import type { AccountOption, WalletVM } from "@farm/ui";
import type { Market } from "@farm/adapter-api";
import { AccountFilter } from "./AccountFilter";
import { BulkPanel } from "./BulkPanel";
import { CustodyPanel } from "./CustodyPanel";
import { FundingPanel } from "./FundingPanel";
import type { InTabProduct } from "../lib/liveClient";
import { NetworkSwitch } from "./NetworkSwitch";
import { useNetwork } from "./NetworkProvider";
import { zhError, zhLabel } from "../lib/zh";

interface Props {
  workspaceName: string;
  totalWallets: number;
  shownWallets: number;
  shown: WalletVM[];
  accountOptions: AccountOption[];
  selectedAccounts: Set<string>;
  onAccountsChange: (next: Set<string>) => void;
  cohorts: string[];
  selectedCohorts: Set<string>;
  onToggleCohort: (c: string) => void;
  liveMarkets?: Market[];
  liveEnabled?: boolean;
  onlineAvailable?: boolean;
  connecting?: boolean;
  connectionError?: string;
  onRetryConnection?: () => void;
  liveDefaultProduct?: InTabProduct;
  liveCohortSize?: number;
  onLiveCohortChange?: () => void;
  liveWallets?: WalletVM[];                       // live VMs (with readiness) for the Fund-cohort panel
  onFunded?: (walletIds: string[]) => void;       // repaint after a bulk fund
}

/** Section label — Kumo's own sidebar group-label recipe (sentence case, never uppercased). */
const Label = ({ children }: { children: React.ReactNode }) => (
  <span className="text-sm font-medium text-kumo-subtle">{children}</span>
);

/** Frozen left rail = Kumo's Sidebar (collapsible="none" on the Provider in page.tsx renders a fixed
 *  <aside> that never collapses or turns into a mobile sheet): Kumo Header for the brand, Kumo Content
 *  as the scroll area for the workspace summary, network, account filter, cohort tags and tool panels. */
export function Sidebar(props: Props) {
  const { net } = useNetwork();
  return (
    <KumoSidebar>
      <KumoSidebar.Header>
        <div className="flex min-w-0 flex-col">
          <Text variant="heading" as="span">Nado 交易台</Text>
          <Text variant="secondary" size="xs" as="span">{props.liveEnabled ? "联网管理" : "本地钱包浏览"} · {props.workspaceName}</Text>
        </div>
      </KumoSidebar.Header>

      <KumoSidebar.Content>
        <div className="flex flex-col gap-5">
          <Meter
            label="显示的钱包"
            value={props.shownWallets}
            max={Math.max(props.totalWallets, 1)}
            customValue={`${props.shownWallets} / ${props.totalWallets}`}
            showValue
          />

          {(props.liveEnabled || props.onlineAvailable) && <NetworkSwitch />}
          <div className="flex flex-col gap-2">
            <LinkButton href="/trade-test" variant="secondary" size="sm">自动交易测试</LinkButton>
            <LinkButton href="/funds" variant="secondary" size="sm">资金交接与小额测试</LinkButton>
            <Text variant="secondary" size="xs">资金库支付手续费，其他钱包转出 USDT0 时无需持有 ETH。</Text>
          </div>
          <div className="flex flex-col gap-2 text-xs text-kumo-subtle" data-testid="connection-status">
            {props.connecting ? <p>正在检测连接…</p> : props.connectionError ? (
              <p role="alert">{zhError(props.connectionError)}</p>
            ) : !props.liveEnabled ? (
              <p>当前为离线模式。请双击仓库中的 Start-Nado-Online.cmd 开启在线服务，再重新检测连接。</p>
            ) : <p>已连接{zhLabel(net.networkName)}。连接本身不会下单或转账。</p>}
            <Button size="sm" disabled={props.connecting} onClick={props.onRetryConnection}>重新检测连接</Button>
          </div>

          <div className="flex flex-col gap-2">
            <Label>账户</Label>
            <AccountFilter options={props.accountOptions} selected={props.selectedAccounts} onChange={props.onAccountsChange} />
          </div>

          <div className="flex flex-col gap-2">
            <Label>钱包分组</Label>
            <div className="flex flex-wrap gap-1">
              {props.cohorts.map((c) => {
                const on = props.selectedCohorts.has(c);
                return (
                  <Button key={c} size="xs" variant={on ? "primary" : "secondary"} aria-pressed={on} onClick={() => props.onToggleCohort(c)}>
                    {zhLabel(c)}
                  </Button>
                );
              })}
            </div>
          </div>

          {props.liveEnabled && <BulkPanel wallets={props.shown} liveMarkets={props.liveMarkets} />}

          {props.liveEnabled && <CustodyPanel cohortSize={props.liveCohortSize} product={props.liveDefaultProduct} onCohortChange={props.onLiveCohortChange} isTestnet={net.isTestnet} />}

          {/* Fund cohort is a TESTNET-only bulk on-ramp (its mint step can't run on mainnet, where
              USDT0 is bridged) — hide it entirely on mainnet so it never burns real gas. */}
          {props.liveEnabled && net.isTestnet && props.liveWallets && props.liveWallets.length > 0 && <FundingPanel wallets={props.liveWallets} onFunded={props.onFunded} />}

          <Text variant="secondary" size="xs">
            {props.liveEnabled
              ? `已连接${zhLabel(net.networkName)}。最多为 50 个当前可见钱包建立实时订阅，其余钱包按限速轮询；点击钱包可优先查询。余额显示“—”表示尚未获取。`
              : "浏览本机保存的钱包地址。离线时不查询余额、订单和交易就绪状态。"}
          </Text>
        </div>
      </KumoSidebar.Content>
    </KumoSidebar>
  );
}
