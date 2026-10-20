"use client";

import { Badge, InlineCopyText, LayerDialog, Text } from "@cloudflare/kumo";
import type { WalletVM } from "@farm/ui";
import { QRCodeSVG } from "qrcode.react";
import { AccountKindBadge } from "./AccountKindBadge";

/** Public identity only: no live context, wallet signer or remote reads are loaded here. */
export function LocalWalletDrawer({ wallet, onClose }: {
  wallet: WalletVM | null;
  onClose: () => void;
}) {
  return (
    <LayerDialog.Root open={wallet !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <LayerDialog.Content size="sm">
        <LayerDialog.Title>本地钱包</LayerDialog.Title>
        <LayerDialog.Description>保存在本地保险库中的公开地址</LayerDialog.Description>
        <LayerDialog.Body>
          {wallet && (
            <div className="flex flex-col gap-4 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                <AccountKindBadge kind={wallet.accountKind}>{wallet.accountName}</AccountKindBadge>
                <Badge variant="secondary">{wallet.accountKind === "HD" ? "助记词账户（HD）" : "私钥账户（PK）"}</Badge>
                <Text variant="mono-secondary" as="span">钱包 #{wallet.index}</Text>
              </div>
              <div className="flex flex-col gap-2">
                <Text variant="secondary" size="xs">公开地址</Text>
                <InlineCopyText value={wallet.address.value} truncate={false} className="min-w-0 break-all text-left" labels={{ copyAction: "复制地址", copied: "地址已复制" }}>
                  {wallet.address.value}
                </InlineCopyText>
                <div className="self-start rounded-lg bg-white p-3">
                  <QRCodeSVG value={wallet.address.value} size={160} aria-label="公开地址二维码" />
                </div>
              </div>
              <Text variant="secondary">
                当前为本地只读视图，尚未联网读取余额、订单或交易准备状态。
              </Text>
            </div>
          )}
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel="关闭">
          <LayerDialog.Actions.Primary onClick={onClose}>关闭钱包</LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}
