/** Uses only the treasury signer. Recipient wallets need no ETH for a DDA deposit. */
import { createInkFundsAdapter } from "../funds/inkAdapter";
import { subaccountToHex } from "@nadohq/client";
import { activeChainId } from "../chainEnv";
import { getLiveConfig } from "../liveConfig";
import { IndexedDbFundsStore } from "../funds/store";
import { INK_CHAIN_ID, USDT0_ADDRESS, type Hex } from "../funds/types";
import type { TestFundingAdapter } from "./funding";
import type { TradeTestAdapter } from "./types";

export function createBrowserFundingAdapter(trade: TradeTestAdapter): TestFundingAdapter {
  const funds = createInkFundsAdapter(), locks = new IndexedDbFundsStore();
  const mainnet = () => { if (activeChainId() !== INK_CHAIN_ID) throw new Error("自动充值只支持 Ink 主网"); };
  const obj = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("充值记录格式不完整"); return value as Record<string, unknown>; };
  const integer = (value: unknown) => { if (typeof value !== "string" || !/^-?\d+$/.test(value)) throw new Error("充值记录数值不完整"); return BigInt(value); };
  return {
    funds,
    assertIdentity: (wallet, chainId) => trade.assertIdentity(wallet, chainId),
    snapshot: wallet => trade.snapshot(wallet),
    fundingBalance: async wallet => {
      mainnet();
      if (!trade.fundingBalance) throw new Error("充值余额读取器不可用，请刷新控制台后恢复原批次");
      const balance = await trade.fundingBalance(wallet);
      mainnet();
      return balance;
    },
    readTreasury: wallet => funds.readWallet(wallet),
    withTreasuryLock: (address, task) => locks.withTreasuryLock(address, task),
    async depositEvents(wallet) {
      mainnet();
      const subaccount = subaccountToHex({ subaccountOwner: wallet.address, subaccountName: "default" }).toLowerCase();
      const response = await fetch("/api/nado/trade-test-read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId: INK_CHAIN_ID, kind: "depositEvents", subaccount }), cache: "no-store", signal: AbortSignal.timeout(40_000) });
      mainnet(); if (!response.ok) throw new Error("Nado 充值入账记录暂不可读");
      const body = obj(await response.json());
      if (body.chainId !== INK_CHAIN_ID || typeof body.observedAt !== "number" || body.observedAt > Date.now() + 1000 || Date.now() - body.observedAt > 5000) throw new Error("充值记录网络或时间不匹配");
      const result = obj(body.result);
      if (!Array.isArray(result.events) || !Array.isArray(result.txs) || result.events.length > 10) throw new Error("充值入账记录不完整");
      const txs = new Map<string, number>();
      for (const value of result.txs) { const tx = obj(value), index = integer(tx.submission_idx).toString(), at = Number(integer(tx.timestamp)) * 1000; if (txs.has(index) || !Number.isSafeInteger(at) || at <= 0) throw new Error("充值时间记录不匹配"); txs.set(index, at); }
      const seen = new Set<string>();
      return result.events.map(value => {
        const event = obj(value), index = integer(event.submission_idx).toString();
        if (event.subaccount !== subaccount || event.product_id !== 0 || event.event_type !== "deposit_collateral" || event.isolated !== false || seen.has(index) || !txs.has(index)) throw new Error("充值记录账户或事件不匹配");
        seen.add(index);
        const before = obj(obj(obj(event.pre_balance).spot).balance), after = obj(obj(obj(event.post_balance).spot).balance);
        const delta = integer(after.amount) - integer(before.amount);
        if (delta <= 0n || BigInt(index) < 0n) throw new Error("充值记录数量不正确");
        return { submissionIndex: index, at: txs.get(index)!, deltaX18: delta.toString() };
      });
    },
    async getDepositAddress(wallet) {
      mainnet();
      const config = await getLiveConfig(true);
      mainnet();
      if (!config.enabled || config.chainId !== INK_CHAIN_ID || !/^0x[\da-fA-F]{40}$/.test(config.endpoint ?? "")) throw new Error("Nado 主网配置或 Endpoint 无效");
      const response = await fetch(`/api/nado/dda?owner=${encodeURIComponent(wallet.address)}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`无法核对 Nado 专属充值地址：${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      mainnet();
      const subaccount = subaccountToHex({ subaccountOwner: wallet.address, subaccountName: "default" }).toLowerCase();
      if (body.ok !== true || body.chainId !== INK_CHAIN_ID || typeof body.owner !== "string" || body.owner.toLowerCase() !== wallet.address.toLowerCase() || body.subaccount !== subaccount || typeof body.address !== "string" || !/^0x[\da-fA-F]{40}$/.test(body.address) || /^0x0{40}$/i.test(body.address)) throw new Error("Nado 充值地址网络、账户或地址不匹配");
      if ([wallet.address, USDT0_ADDRESS, config.endpoint!].some(value => value.toLowerCase() === (body.address as string).toLowerCase())) throw new Error("Nado 专属充值地址不能是钱包、代币合约或 Endpoint");
      return body.address as Hex;
    },
  };
}
