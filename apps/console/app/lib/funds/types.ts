export const INK_CHAIN_ID = 57073 as const;
export const USDT0_ADDRESS = "0x0200C29006150606B650577BBE7B6248F58470c1" as const;
export type Hex = `0x${string}`;
export type Decimal = string;
export interface FundsWallet { id: string; address: Hex; label?: string }
export interface FundsLimits {
  maxFeePerLegWei: Decimal;
  maxTotalFeeWei: Decimal;
  authorizationTtlSeconds: number;
}
export interface TradingCompletion {
  /** Durable business event identifier. An order submission is not completion. */
  eventId: string;
  batchId: string;
  completedAt: string;
  sourceWalletIds: string[];
}
export interface FundsPlan {
  id: string;
  dedupeKey: string;
  kind: "test-cycle" | "batch-handoff" | "nado-deposit";
  chainId: typeof INK_CHAIN_ID;
  token: typeof USDT0_ADDRESS;
  treasury: FundsWallet;
  legs: FundsLeg[];
  limits: FundsLimits;
  completion?: TradingCompletion;
  createdAt: string;
}
export interface FundsAuthorization {
  from: Hex;
  to: Hex;
  value: Decimal;
  validAfter: Decimal;
  validBefore: Decimal;
  nonce: Hex;
  signature?: Hex;
}
export interface FundsPreparedTransaction {
  hash: Hex;
  rawTransaction: Hex;
  nonce: Decimal;
  /** Maximum transaction execution fee plus a conservative L1 fee allowance. */
  feeCeilingWei: Decimal;
}
export interface FundsTransfer { token: Hex; from: Hex; to: Hex; value: Decimal }
export interface FundsReceipt {
  hash: Hex;
  status: "success" | "reverted";
  blockNumber: Decimal;
  blockTimestampMs: number;
  gasUsed: Decimal;
  effectiveGasPrice: Decimal;
  l1FeeWei: Decimal;
  transfers: FundsTransfer[];
  /** Contract AuthorizationUsed events belonging to this receipt. */
  authorizations: { authorizer: Hex; nonce: Hex }[];
}
export type FundsLegStatus = "pending" | "authorized" | "prepared" | "broadcast" | "confirmed" | "needs-attention";
export interface FundsLeg {
  id: string;
  from: FundsWallet;
  to: FundsWallet;
  amount: { kind: "fixed"; units: Decimal } | { kind: "all" };
  status: FundsLegStatus;
  authorization?: FundsAuthorization;
  transaction?: FundsPreparedTransaction;
  receipt?: FundsReceipt;
  /** Matching authorization relayed by a different transaction; requires reconciliation. */
  externalReceipt?: FundsReceipt;
  sourceEthBeforeWei?: Decimal;
  targetEthBeforeWei?: Decimal;
  sourceEthAfterWei?: Decimal;
  targetEthAfterWei?: Decimal;
  targetTokenBeforeUnits?: Decimal;
  targetTokenAfterUnits?: Decimal;
  createdAt?: string;
  submittedAt?: string;
  confirmedAt?: string;
  actualFeeWei?: Decimal;
  error?: string;
}
export interface FundsRun {
  version: 1;
  revision: number;
  plan: FundsPlan;
  status: "ready" | "running" | "paused" | "completed" | "needs-attention";
  updatedAt: string;
  stopRequested: boolean;
  message?: string;
}
export interface FundsWalletBalance { tokenUnits: Decimal; ethWei: Decimal }
export interface FundsAdapter {
  getChainId(): Promise<number>;
  assertIdentity(wallet: FundsWallet): Promise<void>;
  readWallet(wallet: FundsWallet): Promise<FundsWalletBalance>;
  /** Verify durable completion event, zero open orders/positions, and funds returned on-chain. */
  assertTradingReady(plan: FundsPlan): Promise<void>;
  signAuthorization(plan: FundsPlan, leg: FundsLeg, authorization: FundsAuthorization): Promise<Hex>;
  /** Simulates and signs only. MUST NOT broadcast. */
  prepareTransaction(plan: FundsPlan, leg: FundsLeg, authorization: FundsAuthorization): Promise<FundsPreparedTransaction>;
  validatePreparedTransaction(plan: FundsPlan, leg: FundsLeg, authorization: FundsAuthorization, transaction: FundsPreparedTransaction): Promise<void>;
  broadcast(rawTransaction: Hex): Promise<Hex>;
  getReceipt(hash: Hex): Promise<FundsReceipt | null>;
  authorizationUsed(authorization: FundsAuthorization): Promise<boolean>;
  /** Return a verified receipt or null; never infer success from authorizationState alone. */
  findAuthorizationReceipt(authorization: FundsAuthorization, sinceMs: number): Promise<FundsReceipt | null>;
}
export interface FundsStore {
  create(run: FundsRun): Promise<FundsRun>;
  get(id: string): Promise<FundsRun | undefined>;
  list(): Promise<FundsRun[]>;
  update(id: string, change: (current: FundsRun) => FundsRun): Promise<FundsRun>;
  /** Cross-tab exclusive lock for the same treasury address. Fail closed if unavailable. */
  withTreasuryLock<T>(treasuryAddress: string, task: () => Promise<T>): Promise<T>;
}
