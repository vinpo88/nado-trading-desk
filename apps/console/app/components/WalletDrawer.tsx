"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Badge, Banner, Button, ButtonGroup, Collapsible, Grid, InlineCopyText, Input, LayerCard, Loader, Select, Text, cn } from "@cloudflare/kumo";
import { CheckCircleIcon, XCircleIcon, XIcon } from "@phosphor-icons/react";
import type { WalletVM } from "@farm/ui";
import type { PlaceOrderInput, Order, Position, OrderBook, Decimal, Market, Balance } from "@farm/adapter-api";
import { MARKETS, placeOrder, cancelOrders } from "../lib/runtime";
import { placeOrderLive, closePositionLive, depositLive, withdrawLive, refuelGasLive, mintUsdt0Live, readOrderBookLive, readBudget, depositAddressLive, TREASURY_WALLET_ID, DEFAULT_REFUEL_ETH } from "../lib/liveContext";
import type { LiveEvent } from "../lib/liveStream";
import { runInBrowserCustody } from "../lib/custodyLab";
import type { CustodyLabResult } from "../lib/custodyLab";
import { ConfirmDialog } from "./ConfirmDialog";
import { ChineseButton } from "./ChineseButton";
import { AccountKindBadge } from "./AccountKindBadge";
import { useNetwork } from "./NetworkProvider";
import { QRCodeSVG } from "qrcode.react";
import { zhError, zhLabel } from "../lib/zh";

/** A labelled stat tile from Kumo pieces (Kumo ships no stat primitive). */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <LayerCard className="flex flex-col gap-0.5 p-3">
      <Text variant="secondary" size="xs">{label}</Text>
      <span className="capitalize tabular-nums">{value}</span>
    </LayerCard>
  );
}

/** One drawer section = a layered Kumo LayerCard (title in the Secondary strip, body in Primary).
 *  shrink-0: an overflow-hidden flex item in the fixed-height scroll column would otherwise shrink and
 *  clip its own controls instead of letting the column scroll. Titles stay ONE text run (e2e contract). */
function Section({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <LayerCard className="shrink-0">
      <LayerCard.Secondary>{title}</LayerCard.Secondary>
      <LayerCard.Primary className={cn("flex flex-col gap-3", className)}>{children}</LayerCard.Primary>
    </LayerCard>
  );
}

const em = (v: ReactNode) => <strong className="font-medium text-kumo-default">{v}</strong>;

/** Levels per side the drawer reads AND renders — the ladder's row count is fixed to this. */
const BOOK_DEPTH = 6;

/** One side of the order-book ladder: always exactly BOOK_DEPTH rows (missing levels render as blank,
 *  aria-hidden rows) so the box never changes height as levels come and go. */
function BookSide({ label, levels, tone }: { label: string; levels: OrderBook["bids"]; tone: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <Text variant="secondary" size="xs">{label}</Text>
      {Array.from({ length: BOOK_DEPTH }, (_, i) => {
        const l = levels[i];
        return l ? (
          <div key={i} className="flex justify-between gap-2">
            <span className={cn("min-w-0 truncate", tone)}>{l.price}</span><span className="shrink-0 text-kumo-subtle">{l.size}</span>
          </div>
        ) : (
          <div key={i} aria-hidden>{"\u00a0"}</div>
        );
      })}
    </div>
  );
}

export function WalletDrawer({ wallet, onClose, isLive = false, liveEvents, liveMarkets, openOrders, positions, balances, subaccount, onRefueled }: {
  wallet: WalletVM | null;
  onClose: () => void;
  isLive?: boolean;
  liveEvents?: LiveEvent[];
  liveMarkets?: Market[];
  openOrders?: Order[];      // the reconciled open-order LIST for this wallet (not just the count)
  positions?: Position[];    // the reconciled open positions for this wallet
  balances?: Balance[];      // the reconciled per-asset balance LIST for this wallet
  subaccount?: string;       // this wallet's subaccount hex — filters the live feed to THIS wallet
  onRefueled?: (walletIds: string[]) => void; // after a successful gas refuel → repaint these wallets' balances
}) {
  const open = wallet !== null;
  const isTreasury = wallet?.id === TREASURY_WALLET_ID; // the gas source — it funds others, not itself
  const mkt = (id: string): string => id.split(":").pop() ?? id;
  // Show only THIS wallet's live events: a public fill/position_change carries `subaccount`, so keep
  // the ones that match this wallet. (order_update is not pushed to this feed — order state surfaces
  // via the Open-orders list.) With no known subaccount, show nothing rather than leak the cohort feed.
  const walletEvents = subaccount
    ? (liveEvents ?? []).filter((e) => e.subaccount?.toLowerCase() === subaccount.toLowerCase())
    : [];
  const marketOptions = isLive && liveMarkets && liveMarkets.length ? liveMarkets : MARKETS;
  const { net } = useNetwork(); // the active network: gates the testnet-only faucet/mint UI + labels the copy
  const [market, setMarket] = useState(MARKETS[0]!.id);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [kind, setKind] = useState<"limit" | "market">("limit");
  const [price, setPrice] = useState("63120");
  const [size, setSize] = useState("0.1");
  const [amount, setAmount] = useState("100");
  const [gasAmount, setGasAmount] = useState(DEFAULT_REFUEL_ETH);
  const [pending, setPending] = useState<null | "deposit" | "withdraw" | "taker" | "close" | "refuel" | "mint">(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [lab, setLab] = useState<CustodyLabResult | null>(null);
  const [labBusy, setLabBusy] = useState(false);
  const [labErr, setLabErr] = useState<string | null>(null);
  const [book, setBook] = useState<OrderBook | null>(null);
  const [dda, setDda] = useState<string | null>(null); // this wallet's Nado direct-deposit address
  const [balancesOpen, setBalancesOpen] = useState(true); // the Balances list is collapsible

  // Keep the selected market valid for the current option set (mock vs live).
  useEffect(() => {
    if (!marketOptions.some((m) => m.id === market)) {
      setMarket((marketOptions.find((m) => m.id.endsWith("BTC-PERP")) ?? marketOptions[0]!).id);
    }
  }, [isLive, liveMarkets]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape closes the drawer (a Kumo overlay gets this for free; this hand-rolled <aside> must add it).
  // Skipped while a confirm is open — Escape belongs to that dialog then.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && pending === null) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, pending, onClose]);

  // Fetch the selected market's order book while a LIVE drawer is open, and refresh it on an interval
  // (a book goes stale fast). A small debounce coalesces rapid market switches; the refresh yields
  // when the shared read budget is low so it never starves cancels/kill-switch. On a failed read we
  // KEEP the prior snapshot — the render below only shows it while its market matches the selection,
  // so a stale snapshot for a previous market is never shown under the new market's header.
  useEffect(() => {
    if (!isLive || !open || !wallet) { setBook(null); return; }
    let cancelled = false;
    const walletId = wallet.id;
    const load = () => readOrderBookLive(walletId, market, BOOK_DEPTH).then((b) => { if (!cancelled && b) setBook(b); }).catch(() => {});
    const t = setTimeout(load, 120);
    const iv = setInterval(() => { if (readBudget() > 1) void load(); }, 5_000);
    return () => { cancelled = true; clearTimeout(t); clearInterval(iv); };
  }, [isLive, open, market, wallet?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch this wallet's Nado direct-deposit address (DDA) while a LIVE drawer is open (keyless
  // indexer read via the server route). Re-fetches per wallet; aborts on close/switch.
  useEffect(() => {
    if (!isLive || !open || !wallet) { setDda(null); return; }
    const owner = wallet.address.value;
    const ac = new AbortController();
    setDda(null);
    void depositAddressLive(owner, ac.signal).then((a) => { if (!ac.signal.aborted) setDda(a); }).catch(() => {});
    return () => ac.abort();
  }, [isLive, open, wallet?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const append = (m: string) => setLog((l) => [m, ...l].slice(0, 8));

  const submit = async () => {
    if (!wallet) return;
    setBusy(true);
    try {
      const input: PlaceOrderInput = {
        market, side, kind,
        size: size as Decimal,
        price: kind === "limit" ? (price as Decimal) : undefined,
        postOnly: kind === "limit",
        clientId: `c-${Date.now()}`,
      };
      const order: Order = await placeOrder(wallet, input);
      append(`✓ ${zhLabel(side)} ${size} ${market.split(":").pop()} → ${zhLabel(order.status)} · ${zhLabel(order.role)} · ${String(order.venueId).slice(0, 12)}…`);
    } catch (e) {
      append(`✗ ${zhError(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doCancel = async () => {
    if (!wallet) return;
    setBusy(true);
    try {
      const r = await cancelOrders(wallet, { market });
      append(`✓ 已撤销 ${market.split(":").pop()} 的 ${r.cancelled.length} 笔订单`);
    } catch (e) {
      append(`✗ ${zhError(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doFund = async (action: "deposit" | "withdraw") => {
    if (!wallet) return;
    setBusy(true);
    try {
      // Stage 2b: funding signs IN-TAB. Deposit = sealed-key on-chain tx broadcast by a
      // keyless ChainClient; withdraw = in-tab EIP-712 → keyless relay. No server key.
      const r = action === "deposit"
        ? await depositLive(wallet.id, amount)
        : await withdrawLive(wallet.id, amount);
      if (action === "deposit") {
        // Deposit is an on-chain tx: gate on !r.ok, NOT the absence of an error — a mined-but-REVERTED
        // deposit returns { ok:false, status:"reverted" } with no `error` and must not be logged as confirmed.
        if (!r.ok) append(`✗ 充值 ${amount} USDT0 — ${r.error ? zhError(r.error) : zhLabel(r.status ?? "failed")}`);
        else append(`✓ 充值 ${amount} USDT0 已确认${r.tx ? ` · ${r.tx.slice(0, 12)}…` : ""}`);
      } else {
        // Withdraw is an async EIP-712 relay submit: a non-"success" status (ok=false) without an error is a
        // legitimate accepted-pending submission, so keep the error-gated "submitted · status" reporting.
        if (r.error) append(`✗ 提现 ${amount} USDT0 — ${zhError(r.error)}`);
        else append(`✓ 提现 ${amount} USDT0 已由浏览器提交${r.status ? ` · ${zhLabel(r.status)}` : ""}`);
      }
    } catch (e) {
      append(`✗ ${zhError(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doMint = async () => {
    if (!wallet) return;
    setBusy(true);
    try {
      // Testnet faucet: the TREASURY mints USDT0 to this wallet (openly-mintable test token), signed by
      // the treasury's sealed key in-tab + broadcast keyless. Gate on !r.ok so a reverted mint isn't a ✓.
      const r = await mintUsdt0Live(wallet.id, amount, { treasuryWalletId: TREASURY_WALLET_ID });
      if (!r.ok) append(`✗ 领取测试币 ${amount} USDT0 — ${r.error ? zhError(r.error) : zhLabel(r.status ?? "failed")}`);
      else append(`✓ 已向此钱包发放 ${amount} USDT0 测试币${r.tx ? ` · ${r.tx.slice(0, 12)}…` : ""}`);
    } catch (e) {
      append(`✗ ${zhError(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doRefuel = async () => {
    if (!wallet) return;
    setBusy(true);
    try {
      // Gas refuel: send native ETH from the in-tab TREASURY to THIS wallet, signed by the treasury's
      // sealed key in-tab + broadcast by a keyless client (serialized on the treasury nonce). No server key.
      const r = await refuelGasLive(wallet.id, { amountEth: gasAmount, treasuryWalletId: TREASURY_WALLET_ID });
      // Gate on the explicit success flag, NOT the absence of an error: a MINED-but-REVERTED tx returns
      // { ok:false, status:"reverted" } with no `error`, and must never be reported as a ✓ confirmed refuel.
      if (!r.ok) append(`✗ 补充手续费 ${gasAmount} ETH — ${r.error ? zhError(r.error) : zhLabel(r.status ?? "failed")}`);
      else {
        append(`✓ 已向此钱包补充手续费 ${gasAmount} ETH${r.tx ? ` · ${r.tx.slice(0, 12)}…` : ""}`);
        onRefueled?.([wallet.id, TREASURY_WALLET_ID]); // repaint recipient + treasury gas badges now
      }
    } catch (e) {
      append(`✗ ${zhError(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doTaker = async () => {
    if (!wallet) return;
    setBusy(true);
    try {
      // Taker IOC signs IN-TAB → keyless relay (Stage 2a).
      const order = await placeOrderLive(wallet.id, market, { side, size, taker: true });
      append(`✓ 吃单${zhLabel(side)} ${market.split(":").pop()}（立即成交或撤销）→ ${zhLabel(order.status)} · 已成交 ${order.filled}/${order.size} · ${String(order.venueId).slice(0, 12)}…`);
    } catch (e) {
      append(`✗ ${zhError(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doClose = async () => {
    if (!wallet) return;
    setBusy(true);
    try {
      // Close = opposite crossing IOC, signed IN-TAB (Stage 2a).
      const r = await closePositionLive(wallet.id, market);
      append(`✓ ${market.split(":").pop()} 平仓 — ${r.closed ? "已提交立即成交或撤销订单" : "当前没有持仓"}`);
    } catch (e) {
      append(`✗ ${zhError(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const runPending = (): void => {
    const p = pending;
    setPending(null);
    if (p === "deposit" || p === "withdraw") void doFund(p);
    else if (p === "taker") void doTaker();
    else if (p === "close") void doClose();
    else if (p === "refuel") void doRefuel();
    else if (p === "mint") void doMint();
  };

  const runLab = async () => {
    setLabBusy(true); setLabErr(null);
    try { setLab(await runInBrowserCustody()); }
    catch (e) { setLabErr(zhError(e)); }
    finally { setLabBusy(false); }
  };

  // Balances ordered so a NON-ZERO balance ranks above a zero one (then larger first); zeros sink.
  const sortedBalances = [...(balances ?? [])].sort((a, b) => {
    const na = Number(a.total) || 0, nb = Number(b.total) || 0;
    return (nb > 0 ? 1 : 0) - (na > 0 ? 1 : 0) || nb - na;
  });

  // The book for the CURRENT market only (a kept snapshot of a previous market is never shown), and
  // that book only when it has levels to draw — otherwise the fixed slot shows its loading/empty overlay.
  const shownBook = book && book.market === market ? book : null;
  const bookLevels = shownBook && (shownBook.bids.length > 0 || shownBook.asks.length > 0) ? shownBook : null;

  // Kumo has no drawer/sheet primitive, so the drawer stays a hand-rolled <aside> (the e2e locate it as
  // such) built from Kumo pieces: Kumo's own scrim (the recessed token at 80% opacity, exactly as Kumo's
  // Dialog/Sidebar backdrops) and Kumo Sidebar's right-edge recipe (bg-kumo-base, border-l border-kumo-line).
  // Full-width sheet on phones, 440px (w-110) from sm up.
  return (
    <>
      {open && <div aria-hidden className="fixed inset-0 z-30 bg-kumo-recessed opacity-80" onClick={onClose} />}
      <aside
        className={cn(
          "fixed right-0 top-0 z-40 flex h-dvh w-full transform flex-col border-l border-kumo-line bg-kumo-base text-kumo-default transition-transform sm:w-110",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        {wallet && (
          <>
            {/* Pinned header: identity + full address (InlineCopyText) + close. */}
            <div className="flex shrink-0 items-start justify-between gap-2 border-b border-kumo-line px-4 py-3">
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <AccountKindBadge kind={wallet.accountKind}>{wallet.accountName}</AccountKindBadge>
                  {isLive && <Badge variant="primary" className="bg-kumo-brand text-kumo-inverse">在线</Badge>}
                </div>
                <div className="flex items-start gap-1.5">
                  <Text variant="mono-secondary" as="span">#{wallet.index}</Text>
                  {/* FULL address (not truncated) so the operator can read/verify it; copy built in. */}
                  <InlineCopyText value={wallet.address.value} truncate={false} className="min-w-0 break-all text-left" labels={{ copyAction: "复制地址", copied: "地址已复制" }}>
                    {wallet.address.value}
                  </InlineCopyText>
                </div>
              </div>
              <Button variant="ghost" shape="square" size="sm" icon={XIcon} aria-label="关闭钱包" onClick={onClose} />
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
              <Grid variant="side-by-side" gap="sm" className="shrink-0">
                <Stat label="报价币余额" value={`${wallet.quoteBalance} USDT0`} />
                <Stat label="原生币余额" value={`${wallet.nativeBalance} ETH`} />
                <Stat label="当前挂单" value={String(wallet.openOrders)} />
                <Stat label="资金状态" value={zhLabel(wallet.readiness)} />
              </Grid>

              {isLive && (
                <LayerCard className="shrink-0 p-4">
                  {/* Kumo Collapsible: the trigger is a button named "Balances (N)"; the panel UNMOUNTS
                      when closed (default — never keepMounted), which the e2e relies on. */}
                  <Collapsible.Root open={balancesOpen} onOpenChange={setBalancesOpen}>
                    <Collapsible.DefaultTrigger>余额{sortedBalances.length ? `（${sortedBalances.length}）` : ""}</Collapsible.DefaultTrigger>
                    <Collapsible.Panel className="mt-3">
                      {sortedBalances.length > 0 ? (
                        <ul className="flex flex-col gap-1 font-mono text-sm">
                          {sortedBalances.map((b, i) => (
                            <li key={`${b.asset}-${b.scope ?? ""}-${i}`} className="flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate">
                                {b.symbol || b.asset}{b.scope ? <span className="text-kumo-subtle"> · {zhLabel(b.scope)}</span> : null}
                              </span>
                              <span className="shrink-0 tabular-nums">
                                {b.total}
                                {b.available !== b.total ? <span className="text-kumo-subtle"> · 可用 {b.available}</span> : null}
                                {b.usdValue ? <span className="text-kumo-subtle"> · ${b.usdValue}</span> : null}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <Text variant="secondary" size="xs">暂无抵押品余额，请充值{net.isTestnet ? "或领取测试币" : ""} USDT0，为此钱包的子账户入金。</Text>
                      )}
                    </Collapsible.Panel>
                  </Collapsible.Root>
                </LayerCard>
              )}

              {isLive && positions && positions.length > 0 && (
                <Section title={`持仓（${positions.length}）`}>
                  <ul className="flex flex-col gap-1 font-mono">
                    {positions.map((p, i) => (
                      <li key={`${p.market}-${i}`} className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate">
                          {mkt(p.market)} · <span className={p.side === "long" ? "text-kumo-success" : p.side === "short" ? "text-kumo-danger" : "text-kumo-subtle"}>{zhLabel(p.side)}</span> {p.size}
                        </span>
                        <span className="shrink-0 text-kumo-subtle">标记价格 {p.markPrice}{p.liquidationPrice ? ` · 清算价格 ${p.liquidationPrice}` : ""}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {isLive && openOrders && openOrders.length > 0 && (
                <Section title={`当前挂单（${openOrders.length}）`}>
                  <ul className="flex flex-col gap-1 font-mono">
                    {openOrders.map((o, i) => (
                      <li key={o.venueId || o.clientId || i} className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate">
                          {mkt(o.market)} · <span className={o.side === "buy" ? "text-kumo-success" : "text-kumo-danger"}>{zhLabel(o.side)}</span> {o.remaining}/{o.size}
                        </span>
                        <span className="shrink-0 text-kumo-subtle">@ {o.price ?? "市价"} · {zhLabel(o.status)}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              <Section title="下单">
                <Select
                  label={`交易市场${isLive ? `（在线 · ${marketOptions.length}）` : ""}`}
                  hideLabel={false}
                  value={market}
                  onValueChange={(v) => { if (v) setMarket(String(v)); }}
                >
                  {marketOptions.map((m) => (
                    <Select.Option key={m.id} value={m.id}>{isLive ? m.id.split(":").pop() : `${m.base}-${m.quote}`}（{zhLabel(m.product)}）</Select.Option>
                  ))}
                </Select>
                <div className="flex flex-wrap gap-2">
                  <ButtonGroup aria-label="买卖方向">
                    {(["buy", "sell"] as const).map((s) => (
                      <Button key={s} size="sm" variant={side === s ? "primary" : "secondary"} aria-pressed={side === s} className="capitalize" onClick={() => setSide(s)}>{zhLabel(s)}</Button>
                    ))}
                  </ButtonGroup>
                  <ButtonGroup aria-label="订单类型">
                    {(["limit", "market"] as const).map((k) => (
                      <Button key={k} size="sm" variant={kind === k ? "primary" : "secondary"} aria-pressed={kind === k} className="capitalize" onClick={() => setKind(k)}>{zhLabel(k)}</Button>
                    ))}
                  </ButtonGroup>
                </div>
                <Grid variant="side-by-side" gap="sm">
                  {/* w-full min-w-0: fill the grid track instead of the input's intrinsic size=20 width. */}
                  <Input label="数量" className="w-full min-w-0" value={size} onChange={(e) => setSize(e.target.value)} />
                  {kind === "limit" && <Input label="价格" className="w-full min-w-0" value={price} onChange={(e) => setPrice(e.target.value)} />}
                </Grid>
                {isLive && <Text variant="secondary" size="xs">在线下单使用输入的价格，须在预言机价格的 80–120% 范围内；数量会按市场最小值调整。仅在希望根据订单簿确定价格时留空。</Text>}
                <div className="flex flex-wrap gap-2">
                  <ChineseButton variant="primary" loading={busy} onClick={submit}>签名并提交</ChineseButton>
                  <Button variant="secondary-destructive" onClick={doCancel} disabled={busy}>撤销当前市场订单</Button>
                  {isLive && <Button onClick={() => setPending("taker")} disabled={busy}>吃单（立即成交或撤销）</Button>}
                  {isLive && <Button variant="secondary-destructive" onClick={() => setPending("close")} disabled={busy}>平仓</Button>}
                </div>
              </Section>

              {isLive && (
                <Section title={`订单簿 · ${mkt(market)}`}>
                  {/* A FIXED-HEIGHT slot, mounted as soon as the live drawer opens: the book lands ~200ms
                      after open (debounce + metered relay read), and a section popping in here pushed the
                      Funding / Gas-refuel controls below it down mid-click — a press that straddled the
                      insert lost its click (the refuel-cap e2e flake). So the ladder always renders
                      BOOK_DEPTH rows per side and a pending / stale-market / empty book overlays the same
                      box: no book state ever changes this section's height. Bid/ask ladder (Kumo has no
                      order-book primitive): token-coloured columns; each price sits alone in its element
                      (the e2e matches a price exactly). */}
                  <div className="relative">
                    <Grid variant="side-by-side" gap="sm" className="font-mono" aria-hidden={!bookLevels || undefined}>
                      <BookSide label="买盘" levels={bookLevels?.bids ?? []} tone="text-kumo-success" />
                      <BookSide label="卖盘" levels={bookLevels?.asks ?? []} tone="text-kumo-danger" />
                    </Grid>
                    {!bookLevels && (
                      <div className="absolute inset-0 flex items-center justify-center gap-2 text-kumo-subtle">
                        {shownBook ? "当前市场暂无挂单流动性。" : <><Loader size="sm" aria-label="正在加载" /> 正在加载订单簿……</>}
                      </div>
                    )}
                  </div>
                </Section>
              )}

              {isLive && (
                <Section title="资金管理（USDT0 抵押品）">
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="min-w-0 flex-1 basis-32"><Input label="金额" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
                    <Button onClick={() => setPending("deposit")} disabled={busy}>充值</Button>
                    <Button onClick={() => setPending("withdraw")} disabled={busy}>提现</Button>
                  </div>
                  {net.isTestnet && (
                    <div className="flex items-center justify-between gap-2">
                      <Text variant="secondary" size="xs">测试网水龙头：由资金钱包向此钱包发放 USDT0（6 位小数）。</Text>
                      <Button onClick={() => setPending("mint")} disabled={busy}>领取测试币 {amount}</Button>
                    </div>
                  )}
                  <Text variant="secondary" size="xs">充值需要链上授权并存入抵押品；提现在浏览器内签名后提交至 Nado。服务器不持有密钥。</Text>
                </Section>
              )}

              {isLive && (
                <Section title="补充手续费（原生 ETH）">
                  {isTreasury ? (
                    <Text variant="secondary">这是支付手续费的{em("资金钱包")}（{TREASURY_WALLET_ID}），用于向其他钱包转入 ETH。请从外部转入资金，它不能为自身补充余额。</Text>
                  ) : (
                    <>
                      <div className="flex items-end gap-2">
                        <div className="min-w-0 flex-1"><Input label="ETH 金额" value={gasAmount} onChange={(e) => setGasAmount(e.target.value)} /></div>
                        <Button onClick={() => setPending("refuel")} disabled={busy}>补充手续费</Button>
                      </div>
                      <Text variant="secondary" size="xs">从资金钱包（{TREASURY_WALLET_ID}）向此钱包转入原生 ETH，用于链上授权和充值的手续费。交易由资金钱包在此标签页签名并按顺序发送。</Text>
                    </>
                  )}
                </Section>
              )}

              {isLive && (
                <Section title={<span className="flex items-center gap-1.5"><span aria-hidden className="size-1.5 animate-pulse rounded-full bg-kumo-brand" />实时事件</span>}>
                  {walletEvents.length === 0 ? (
                    <Text variant="secondary" size="xs">此处显示该子账户的成交和仓位变动，并刷新钱包状态。挂单和撤单状态通过订单更新连接在后台刷新。</Text>
                  ) : (
                    <ul className="flex flex-col gap-1 font-mono">
                      {/* Each row's text starts with the event type (the e2e anchors on it). */}
                      {walletEvents.slice(0, 8).map((e, i) => (
                        <li key={i}>{zhLabel(e.type, "状态更新")}{e.reason ? ` · ${zhLabel(e.reason, "其他原因")}` : ""}{e.digest ? ` · ${e.digest.slice(0, 12)}…` : ""}</li>
                      ))}
                    </ul>
                  )}
                </Section>
              )}

              {isLive && (
                <Section title="浏览器内签名测试（新建测试钱包）">
                  <Text variant="secondary" size="xs">在浏览器内新建测试钱包，并对符合 Nado 格式的订单进行签名验证。密钥保留在浏览器内，不使用现有钱包的资金。</Text>
                  <div><ChineseButton loading={labBusy} onClick={runLab}>新建测试钱包并验证签名</ChineseButton></div>
                  {labErr && <Banner variant="error" size="sm" icon={<XCircleIcon weight="fill" />} description={labErr} />}
                  {lab && (
                    <ul className="flex flex-col gap-1 font-mono">
                      <li>地址 <span className="text-kumo-subtle">{lab.address.slice(0, 10)}…{lab.address.slice(-6)}</span></li>
                      <li>签名 <span className="text-kumo-subtle">{lab.signature.slice(0, 18)}…</span></li>
                      <li className={cn("flex items-center gap-1.5", lab.match ? "text-kumo-success" : "text-kumo-danger")}>
                        {lab.match ? <CheckCircleIcon className="shrink-0" /> : <XCircleIcon className="shrink-0" />}
                        {lab.match ? "签名恢复地址一致，浏览器内验证通过" : "签名恢复地址不一致"}
                      </li>
                    </ul>
                  )}
                </Section>
              )}

              <Section title="操作记录">
                {log.length === 0 ? (
                  <Text variant="secondary" size="xs">{isLive ? "在线订单在此浏览器标签页签名后提交至实际交易服务，服务器不持有密钥。" : "暂无操作。当前使用模拟交易环境。"}</Text>
                ) : (
                  <ul className="flex flex-col gap-1 font-mono">
                    {/* The ✓/✗ prefixes are part of the e2e contract (refuel / cap-reject match them). */}
                    {log.map((l, i) => (
                      <li key={i} className={l.startsWith("✓") ? "text-kumo-success" : "text-kumo-danger"}>{l}</li>
                    ))}
                  </ul>
                )}
              </Section>

              {isLive && (
                <Section title="充值地址（Nado 专属地址）">
                  {dda ? (
                    <div className="flex flex-col items-center gap-2">
                      <div data-testid="dda-qr" className="rounded-lg bg-kumo-base p-2 ring ring-kumo-hairline"><QRCodeSVG value={dda} size={132} /></div>
                      <InlineCopyText value={dda} truncate={false} className="w-full break-all text-left" labels={{ copyAction: "复制充值地址", copied: "充值地址已复制" }}>
                        {dda}
                      </InlineCopyText>
                      <Text variant="secondary" size="xs">向此地址转入所选 Ink 网络上的 USDT0，即可为此钱包的子账户入金。</Text>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-kumo-subtle"><Loader size="sm" aria-label="正在加载" /> 正在获取充值地址……</div>
                  )}
                </Section>
              )}

              <div className="mt-auto flex shrink-0 flex-wrap gap-1">
                {wallet.cohorts.map((c) => <Badge key={c} variant="secondary">{zhLabel(c)}</Badge>)}
              </div>
            </div>
          </>
        )}
      </aside>

      <ConfirmDialog
        open={pending !== null}
        title={
          pending === "deposit" ? "充值抵押品（链上交易）"
            : pending === "withdraw" ? "提取抵押品"
            : pending === "taker" ? "吃单（立即成交或撤销）"
            : pending === "refuel" ? "补充手续费（原生 ETH 转账）"
            : pending === "mint" ? "领取 USDT0 测试币"
            : "平仓"
        }
        body={<>
          {pending === "deposit" && <>在链上授权并向 Nado 合约充值 {em(amount)} USDT0。这是实际{net.isTestnet ? "测试网" : "主网"}交易，需要手续费，并在此标签页签名。</>}
          {pending === "withdraw" && <>提取 {em(amount)} USDT0 抵押品，在此标签页签名后提交至 Nado。</>}
          {pending === "taker" && <>在 {market.split(":").pop()} 提交{em(zhLabel(side))}的{em("立即成交或撤销")}订单，成交部分将建立仓位，剩余部分自动撤销。</>}
          {pending === "refuel" && <>从资金钱包（{em(TREASURY_WALLET_ID)}）向此钱包（{em(`#${wallet?.index}`)}）转入 {em(`${gasAmount} ETH`)}。这是不可撤销的实际{net.isTestnet ? "测试网" : "主网"}转账，由资金钱包在此标签页签名。</>}
          {pending === "mint" && <>由资金钱包（{em(TREASURY_WALLET_ID)}）向此钱包（{em(`#${wallet?.index}`)}）发放 {em(`${amount} USDT0`)}。这是需要手续费的实际{em("测试网")}水龙头交易，在此标签页签名。主网 USDT0 需通过跨链转入，无法通过此方式领取。</>}
          {pending === "close" && <>使用方向相反的{em("立即成交或撤销")}订单，平掉 {market.split(":").pop()} 的当前仓位。</>}
        </>}
        danger={<>将提交实际{net.isTestnet ? "测试网" : "主网"}订单或移动资金。签名在此标签页完成，密钥保留在浏览器内。</>}
        onConfirm={runPending}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
