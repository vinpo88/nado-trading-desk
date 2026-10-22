/** Durable, bounded public-orderbook tests. All monetary values are integer X18 strings. */
import type { TestFundingState } from "./funding";
export interface TestWallet { id: string; address: `0x${string}`; label: string; }
export interface TestSettings {
  symbols: string[];
  leverage: number;
  targetNotionalX18: string;
  marginX18: string;
  quoteWaitMs: number;
  closeWaitMs: number;
  maxCloseAttempts: number;
  maxSpreadBps: number;
  maxSlippageBps: number;
  maxQuoteAgeMs: number;
  /** null explicitly means the operator selected no cumulative loss stop. */
  lossLimitX18: string | null;
}
export interface TestMarket {
  symbol: string; productId: number; observedAt: number; isOpen: boolean;
  isolatedOnly: boolean; maxLeverage: number;
  minNotionalX18: string; sizeIncrementX18: string; priceIncrementX18: string;
  bidX18: string; askX18: string; oracleX18: string;
  makerFeeRateX18: string; takerFeeRateX18: string;
}
export interface TestPosition {
  sender: string; productId: number; amountX18: string; quoteX18: string;
}
export interface TestOpenOrder {
  digest: string; sender: string; productId: number; amountX18: string; priceX18: string;
}
export interface AccountSnapshot {
  observedAt: number; parentSender: string; quoteBalanceX18: string;
  /** USDT0 plus marked perp quote/base value; reject non-USDT collateral for this pilot. */
  equityX18: string;
  /** Conservative fixed execution-fee balance reserve, not an estimate of charged fees. */
  fixedFeeReserveX18?: string;
  positions: TestPosition[]; openOrders: TestOpenOrder[];
  hasOtherCollateral: boolean; hasCrossPosition: boolean;
}
export interface OrderRequest {
  wallet: TestWallet; market: TestMarket; side: "buy" | "sell";
  amountX18: string; priceX18: string; marginX18?: string;
  sender?: string; reduceOnly: boolean; expiresAt: number;
}
export interface PreparedTestOrder {
  digest: string; sender: string; productId: number; side: "buy" | "sell";
  amountX18: string; priceX18: string; reduceOnly: boolean; marginX18?: string;
  expiresAt: number;
  /** Signed, replayable request: persisted locally, NEVER included in exports. */
  payload: Record<string, unknown>;
}
export interface TestOrderRecord {
  prepared: PreparedTestOrder; preparedAt: number;
  marketObservedAt?: number; accountObservedAt?: number;
  broadcastStartedAt?: number; acknowledgedAt?: number; error?: string;
}
export interface TestOrderReport {
  digest: string; indexed: boolean; volumeX18: string; feeX18: string;
  /** Durable journal proves no broadcast was started; distinct from an indexed zero fill. */
  notBroadcast?: boolean;
  realizedPnlX18: string; firstFillAt?: number; lastFillAt?: number;
}
export interface WalletTest {
  wallet: TestWallet; side: "buy" | "sell";
  status: "pending" | "opening" | "closing" | "completed" | "unfilled" | "attention";
  market?: TestMarket; before?: AccountSnapshot; after?: AccountSnapshot;
  orders: TestOrderRecord[]; reports: TestOrderReport[];
  startedAt?: number; finishedAt?: number; message?: string;
}
/** Display-only execution evidence. Never contains signatures or replayable requests. */
export interface TradeTestProgress {
  phase: string; message: string; at: number; walletId?: string; current?: number; total?: number;
}
export interface TradeTestEvent extends TradeTestProgress {
  id: string; kind: "progress" | "transition" | "error"; txHash?: string; orderDigest?: string;
}
export interface TradeTestRun {
  id: string; batchKey: string; chainId: number; createdAt: number; updatedAt: number; revision: number;
  mode: "live" | "simulation";
  settings: TestSettings; wallets: WalletTest[];
  status: "ready" | "running" | "paused" | "attention" | "completed";
  stopRequested: boolean; message?: string;
  /** Optional treasury funding; missing on older, pre-funded-only runs. */
  funding?: TestFundingState;
  /** Optional for backwards compatibility with runs saved before the live monitor. */
  progress?: TradeTestProgress;
  events?: TradeTestEvent[];
  /** Internal report label only; venue-side statistics/reward exclusion is managed by Nado. */
  classification: "internal-test";
}
export interface TradeTestStore {
  create(run: TradeTestRun): Promise<TradeTestRun>;
  get(id: string): Promise<TradeTestRun | undefined>;
  list(): Promise<TradeTestRun[]>;
  update(id: string, change: (run: TradeTestRun) => void): Promise<TradeTestRun>;
  withLock<T>(chainId: number, task: () => Promise<T>): Promise<T>;
}
export interface TradeTestAdapter {
  readonly mode: "live" | "simulation";
  assertIdentity(wallet: TestWallet, chainId: number): Promise<void>;
  market(symbol: string): Promise<TestMarket>;
  snapshot(wallet: TestWallet): Promise<AccountSnapshot>;
  /** Lightweight credit observation only. Never substitutes for a complete trading preflight.
   * Preserve upstream observedAt; callers must reject/retry stale observations before use. */
  fundingBalance?(wallet: TestWallet): Promise<{ parentSender: string; quoteBalanceX18: string; observedAt: number }>;
  /** Does not broadcast. Signs only after the operator starts the saved run. */
  prepare(request: OrderRequest): Promise<PreparedTestOrder>;
  /** Live adapter invokes beforeSend after its final asynchronous identity read. */
  broadcast(order: PreparedTestOrder, beforeSend?: () => void | Promise<void>): Promise<void>;
  /** Cancellation can be repeated for the SAME digest; it never creates a new order. */
  cancel(wallet: TestWallet, order: PreparedTestOrder): Promise<void>;
  reports(wallet: TestWallet, orders: PreparedTestOrder[]): Promise<TestOrderReport[]>;
}
