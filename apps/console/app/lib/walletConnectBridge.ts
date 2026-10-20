import type { WalletKit, WalletKitTypes } from "@reown/walletkit";
import { hashTypedData } from "viem";
import { cohortWallets, isUnlocked } from "./custody";
import { INK_CHAIN_ID, NADO_ORIGIN, SUPPORTED_METHODS, WalletConnectPolicyError, validateRequest } from "./walletConnectPolicy";
import type { PreparedRequest } from "./walletConnectPolicy";
import { executeApprovedRequest, prepareTransaction } from "./walletConnectSigning";
import type { ReadyTransactionRequest } from "./walletConnectSigning";
import { getUsernamePayloadHash, matchesUsernameAuthorization } from "./nadoUsernameAuthorization";

export interface BridgeWallet { walletId: string; address: string }
export type BridgeStatus = "idle" | "connecting" | "proposal" | "connected" | "preparing" | "request" | "executing" | "disconnected" | "error";
export interface BridgeSnapshot {
  status: BridgeStatus;
  wallet: BridgeWallet;
  proposal: { name: string; url: string; address: string; chains: string[]; methods: string[] } | null;
  request: { id: number; kind: string; title: string; details: string; caution?: string; address: string; method: string } | null;
  outcome: { title: string; transactionHash?: string } | null;
  usernameAuthorization: string | null;
  error: string | null;
}
export interface NadoBridge {
  getSnapshot(): BridgeSnapshot;
  pair(uri: string): Promise<void>;
  approveProposal(): Promise<void>;
  rejectProposal(): Promise<void>;
  approveRequest(expectedRequestId: number): Promise<void>;
  rejectRequest(): Promise<void>;
  setUsernameAuthorization(username: string | null): void;
  disconnect(): Promise<void>;
  dispose(): Promise<void>;
}
export interface BridgeOptions {
  projectId: string;
  wallet: BridgeWallet;
  onChange(snapshot: BridgeSnapshot): void;
  signal?: AbortSignal;
}
type WalletKitInstance = InstanceType<typeof WalletKit>;
export type BridgeKit = Pick<WalletKitInstance, "on" | "off" | "pair" | "approveSession" | "rejectSession" | "respondSessionRequest" | "disconnectSession" | "getActiveSessions" | "rejectSessionAuthenticate" | "emitSessionEvent">;
export interface BridgeSdkHandle { kit: BridgeKit; cleanup(): Promise<void> }
// Dependencies are injected by isolated tests; production never exposes a global test hook.
export interface BridgeDependencies {
  createSdk(projectId: string, signal?: AbortSignal): Promise<BridgeSdkHandle>;
  prepareTransaction: typeof prepareTransaction;
  executeApprovedRequest: typeof executeApprovedRequest;
  isWalletAvailable(wallet: BridgeWallet): boolean;
}

const CHAIN = `eip155:${INK_CHAIN_ID}`;
const REJECTED = { code: 4001, message: "用户拒绝或请求已失效。" };
const UNSUPPORTED = { code: 4100, message: "此请求未获授权。" };
const BUSY = { code: -32002, message: "请先处理当前请求。" };
let activeBridge: NadoBridge | null = null;

function within<T>(promise: Promise<T>, milliseconds = 12_000, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  let onAbort: (() => void) | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("连接操作超时。")), milliseconds);
      onAbort = () => reject(new Error("连接操作已取消。"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    }),
  ]).finally(() => { clearTimeout(timer); if (onAbort) signal?.removeEventListener("abort", onAbort); });
}

function sameOfficialOrigin(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.origin === NADO_ORIGIN && !url.username && !url.password;
  } catch { return false; }
}

function verifiedOfficial(context: WalletKitTypes.SessionProposal["verifyContext"], metadataUrl: unknown): boolean {
  const verified = context?.verified;
  return verified?.validation === "VALID" && verified.isScam !== true
    && verified.origin === NADO_ORIGIN && sameOfficialOrigin(metadataUrl);
}

function verificationError(context: WalletKitTypes.SessionProposal["verifyContext"], metadataUrl: unknown): string {
  if (context?.verified?.isScam) return "已拒绝连接：该来源被标记为风险网站。请直接打开 Nado 官网重新连接。";
  if (context?.verified?.validation === "UNKNOWN" || !context?.verified) return "无法验证官网来源（UNKNOWN），已拒绝请求。请从 Nado 官网重新生成 WalletConnect 链接后重试。";
  if (!sameOfficialOrigin(metadataUrl) || context.verified.origin !== NADO_ORIGIN) return "请求来源不是允许的 Nado 官方域名，已拒绝。请从 app.nado.xyz 重新连接。";
  return "请求来源验证不匹配，已拒绝。请关闭其他连接页面后从 Nado 官网重试。";
}

function walletAvailable(wallet: BridgeWallet): boolean {
  return isUnlocked() && cohortWallets().some((item) => item.walletId === wallet.walletId && item.address.toLowerCase() === wallet.address.toLowerCase());
}

async function createSdk(projectId: string, signal?: AbortSignal): Promise<BridgeSdkHandle> {
  const [{ Core }, { WalletKit }] = await Promise.all([import("@walletconnect/core"), import("@reown/walletkit")]);
  if (signal?.aborted) throw new Error("连接初始化已取消。");
  const entries = new Map<string, unknown>();
  let storageClosed = false;
  const storage = {
    async getKeys() { return [...entries.keys()]; },
    async getEntries<T>() { return [...entries.entries()].map(([key, value]) => [key, structuredClone(value) as T] as [string, T]); },
    async getItem<T>(key: string): Promise<T | undefined> { return structuredClone(entries.get(key)) as T | undefined; },
    async setItem<T>(key: string, value: T) { if (!storageClosed) entries.set(key, structuredClone(value)); },
    async removeItem(key: string) { entries.delete(key); },
  };
  // No SDK payload, URI, session key or signature may reach the console/logger.
  const noop = () => undefined;
  const quietLogger = {
    level: "silent", trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
    child: () => quietLogger, bindings: () => ({}), setBindings: noop, flush: noop,
  } as unknown as InstanceType<typeof Core>["logger"];
  const prefix = `nado-ephemeral-${crypto.randomUUID()}`;
  const core = new Core({ projectId, storage, customStoragePrefix: prefix, telemetryEnabled: false, logger: quietLogger });
  let cleaned = false;
  const cleanup = async () => {
    signal?.removeEventListener("abort", onAbort);
    storageClosed = true;
    core.heartbeat.stop();
    // Immediately revoke local secrets even if the remote peer cannot acknowledge a disconnect.
    core.crypto.keychain.keychain.clear();
    entries.clear();
    if (cleaned) return;
    cleaned = true;
    await within(core.relayer.transportClose(), 3_000).catch(noop);
    // Core keeps a global instance by prefix; never let a disposed ephemeral instance be reused.
    const globals = globalThis as unknown as Record<string, unknown>;
    const key = `_walletConnectCore_${prefix}`;
    if (globals[key] === core) delete globals[key];
    delete globals[`${key}_count`];
  };
  const onAbort = () => { void cleanup(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const kit = await WalletKit.init({
      core,
      metadata: { name: "Nado 本地钱包", description: "由用户逐次确认连接、签名和交易", url: "http://127.0.0.1:18270", icons: [] },
    });
    if (signal?.aborted) { await cleanup(); throw new Error("连接初始化已取消。"); }
    // After initialization, controller shutdown sends best-effort refusals before erasing keys.
    signal?.removeEventListener("abort", onAbort);
    return { kit, cleanup };
  } catch {
    await cleanup();
    throw new Error("无法初始化官网连接，请检查项目 ID 和网络后重试。");
  }
}

type PendingProposal = { event: WalletKitTypes.SessionProposal; namespaces: Parameters<WalletKitInstance["approveSession"]>[0]["namespaces"] };
type Review = PreparedRequest | ReadyTransactionRequest;
type PendingRequest = { event: WalletKitTypes.SessionRequest; review: Review | null; abort: AbortController; executing: boolean };

/** An ephemeral wallet session; only a separately authorized, exact username may sign once automatically. */
export async function createNadoBridge(options: BridgeOptions, overrides: Partial<BridgeDependencies> = {}): Promise<NadoBridge> {
  if (!/^[a-fA-F0-9]{32}$/.test(options.projectId.trim())) throw new Error("请填写本项目自己的有效 WalletConnect 项目 ID。");
  const dependencies: BridgeDependencies = { createSdk, prepareTransaction, executeApprovedRequest, isWalletAvailable: walletAvailable, ...overrides };
  const wallet = { ...options.wallet };
  if (!dependencies.isWalletAvailable(wallet)) throw new Error("请先解锁保险库并选择有效钱包。");
  const previous = activeBridge;
  let handle: BridgeSdkHandle | null = null;
  let stopped = false;
  let disposing: Promise<void> | null = null;
  let pairing = false;
  let proposal: PendingProposal | null = null;
  let proposalApproving = false;
  let pending: PendingRequest | null = null;
  let usernameAuthorization: string | null = null;
  const executedRequestIds = new Set<number>();
  const automaticSignatureHashes = new Set<string>();
  let topic: string | null = null;
  let monitor: ReturnType<typeof setInterval> | undefined;
  let pairTimer: ReturnType<typeof setTimeout> | undefined;
  const lifecycle = new AbortController();
  let snapshot: BridgeSnapshot = { status: "connecting", wallet, proposal: null, request: null, outcome: null, usernameAuthorization: null, error: null };

  function publish(change: Partial<BridgeSnapshot>) {
    snapshot = { ...snapshot, ...change };
    try { options.onChange(structuredClone(snapshot)); } catch { /* Consumer errors must not alter signing authority. */ }
  }
  function available(): boolean { return !stopped && dependencies.isWalletAvailable(wallet); }
  function ensureAvailable(): boolean {
    if (available()) return true;
    if (!stopped) void shutdown("保险库已锁定或钱包已变化，连接已关闭。");
    return false;
  }
  function requestTrusted(event: WalletKitTypes.SessionRequest): boolean {
    if (!handle || !topic || event.topic !== topic || event.params.chainId !== CHAIN) return false;
    const session = handle.kit.getActiveSessions()[topic];
    const expiry = event.params.request.expiryTimestamp;
    return Boolean(session && session.expiry * 1000 > Date.now() && (expiry === undefined || expiry * 1000 > Date.now())
      && verifiedOfficial(event.verifyContext, session.peer.metadata.url)
      && Object.values(session.namespaces).some((namespace) => namespace.methods.includes(event.params.request.method)
        && namespace.accounts.some((account) => account.toLowerCase() === `${CHAIN}:${wallet.address}`.toLowerCase())));
  }
  async function rejectEvent(event: WalletKitTypes.SessionRequest, error = REJECTED): Promise<void> {
    if (!handle) return;
    await within(handle.kit.respondSessionRequest({ topic: event.topic, response: { id: event.id, jsonrpc: "2.0", error } }), 3_000).catch(() => undefined);
  }
  async function rejectProposalEvent(event: WalletKitTypes.SessionProposal): Promise<void> {
    if (handle) await within(handle.kit.rejectSession({ id: event.id, reason: UNSUPPORTED }), 3_000).catch(() => undefined);
  }
  const onProposal = (event: WalletKitTypes.SessionProposal) => { void receiveProposal(event).catch(() => shutdown("无法读取连接申请，请从官网重新连接。")); };
  async function receiveProposal(event: WalletKitTypes.SessionProposal) {
    if (!ensureAvailable() || !pairing || topic || proposal || proposalApproving) {
      await rejectProposalEvent(event);
      return;
    }
    if (!verifiedOfficial(event.verifyContext, event.params.proposer.metadata.url)) {
      await rejectProposalEvent(event);
      await shutdown(verificationError(event.verifyContext, event.params.proposer.metadata.url));
      return;
    }
    if (event.params.expiryTimestamp * 1000 <= Date.now()) { await rejectProposalEvent(event); await shutdown("连接申请已过期，请从官网重新生成链接。"); return; }
    try {
      const { buildApprovedNamespaces } = await import("@walletconnect/utils");
      if (!ensureAvailable() || !pairing || topic || proposal) { await rejectProposalEvent(event); return; }
      const namespaces = buildApprovedNamespaces({
        proposal: event.params,
        supportedNamespaces: { eip155: { chains: [CHAIN], accounts: [`${CHAIN}:${wallet.address}`], methods: [...SUPPORTED_METHODS], events: ["accountsChanged", "chainChanged"] } },
      });
      proposal = { event: structuredClone(event), namespaces };
      clearTimeout(pairTimer);
      publish({ status: "proposal", error: null, proposal: {
        name: "Nado", url: NADO_ORIGIN, address: wallet.address,
        chains: [...new Set(Object.values(namespaces).flatMap((namespace) => namespace.chains ?? [CHAIN]))],
        methods: [...new Set(Object.values(namespaces).flatMap((namespace) => namespace.methods))],
      } });
    } catch {
      await rejectProposalEvent(event);
      if (!stopped) await shutdown("官网请求了此连接器不支持的网络或权限，请重新连接。");
    }
  }
  const onRequest = (event: WalletKitTypes.SessionRequest) => { void receiveRequest(event).catch(() => shutdown("无法读取官网请求，连接已关闭。请重新连接后重试。")); };
  async function receiveRequest(event: WalletKitTypes.SessionRequest) {
    if (!ensureAvailable()) { await rejectEvent(event, UNSUPPORTED); return; }
    if (!requestTrusted(event)) {
      await rejectEvent(event, UNSUPPORTED);
      if (!stopped && topic === event.topic) publish({ error: "请求未通过来源、网络、账户或权限检查，已拒绝。请在官网重新发起连接。" });
      return;
    }
    if (pending) { await rejectEvent(event, BUSY); return; }
    if (executedRequestIds.has(event.id)) { await rejectEvent(event, UNSUPPORTED); return; }
    const item: PendingRequest = { event: structuredClone(event), review: null, abort: new AbortController(), executing: false };
    pending = item;
    publish({ status: "preparing", request: null, outcome: null, error: null });
    try {
      const validated = validateRequest(event.params.request.method, event.params.request.params, wallet.address);
      item.review = validated.kind === "transaction"
        ? await dependencies.prepareTransaction(validated, wallet.walletId, wallet.address, { signal: item.abort.signal })
        : validated;
      if (!ensureAvailable() || pending !== item || item.abort.signal.aborted) return;
      if (!requestTrusted(item.event)) { await shutdown("准备期间会话或请求已失效，请重新连接。"); return; }
      const { kind, title, details, caution, address, method } = item.review;
      publish({ status: "request", request: { id: item.event.id, kind, title, details, caution, address, method }, error: null });
      await tryUsernameAuthorization(item);
    } catch (error) {
      if (pending !== item || stopped) return;
      item.abort.abort();
      await rejectEvent(event, UNSUPPORTED);
      if (!stopped && pending === item) {
        pending = null;
        publish({ status: "connected", request: null, error: error instanceof WalletConnectPolicyError ? error.message : "无法准备此请求，或请求内容不符合允许的操作。请在官网重新发起。" });
      }
    }
  }
  const onDelete = (event: WalletKitTypes.SessionDelete) => { if (event.topic === topic) void shutdown("官网已断开钱包连接。"); };
  const onProposalExpire = (event: WalletKitTypes.ProposalExpire) => {
    if (proposal?.event.id === event.id) void shutdown("连接申请已过期，请在官网重新连接。");
  };
  const onRequestExpire = (event: WalletKitTypes.SessionRequestExpire) => {
    if (pending?.event.id !== event.id) return;
    pending.abort.abort();
    pending = null;
    publish({ status: "connected", request: null, error: "请求已过期，请在官网重新发起。" });
  };
  const onAuthenticate = (event: WalletKitTypes.SessionAuthenticate) => {
    if (handle) void within(handle.kit.rejectSessionAuthenticate({ id: event.id, reason: UNSUPPORTED }), 3_000).catch(() => undefined);
    if (!stopped) publish({ error: "暂不支持此快捷登录流程，请使用普通钱包连接。" });
  };
  function removeListeners(kit: BridgeKit) {
    kit.off("session_proposal", onProposal);
    kit.off("session_request", onRequest);
    kit.off("session_delete", onDelete);
    kit.off("proposal_expire", onProposalExpire);
    kit.off("session_request_expire", onRequestExpire);
    kit.off("session_authenticate", onAuthenticate);
  }
  function shutdown(message: string | null = null): Promise<void> {
    if (disposing) return disposing;
    stopped = true; // Revoke authority synchronously, before any network cleanup.
    usernameAuthorization = null;
    lifecycle.abort();
    pairing = false;
    clearInterval(monitor);
    clearTimeout(pairTimer);
    const oldPending = pending;
    const oldProposal = proposal;
    const oldTopic = topic;
    oldPending?.abort.abort();
    pending = null; proposal = null; topic = null;
    if (activeBridge === bridge) activeBridge = null;
    options.signal?.removeEventListener("abort", onExternalAbort);
    if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
    publish({ status: "disconnected", proposal: null, request: null, usernameAuthorization: null, error: message });
    disposing = (async () => {
      if (!handle) return;
      const sdk = handle;
      removeListeners(sdk.kit);
      const tasks: Promise<unknown>[] = [];
      if (oldPending && !oldPending.executing) tasks.push(rejectEvent(oldPending.event));
      if (oldProposal && !proposalApproving) tasks.push(rejectProposalEvent(oldProposal.event));
      if (oldTopic) tasks.push(within(sdk.kit.disconnectSession({ topic: oldTopic, reason: { code: 6000, message: "用户已断开连接。" } }), 3_000));
      await Promise.allSettled(tasks);
      await sdk.cleanup().catch(() => undefined);
      handle = null;
    })();
    return disposing;
  }
  const onPageHide = () => { void shutdown(); };
  const onExternalAbort = () => { void shutdown(); };

  async function tryUsernameAuthorization(item: PendingRequest): Promise<void> {
    const allowedName = usernameAuthorization;
    if (!allowedName || !item.review || pending !== item || item.executing || item.abort.signal.aborted) return;
    if (!matchesUsernameAuthorization(item.review, allowedName)) return;
    await executeRequest(item, allowedName);
  }
  async function executeRequest(selected: PendingRequest, automaticUsername?: string): Promise<void> {
    if (!ensureAvailable() || !handle || pending !== selected || !selected.review || selected.executing || selected.abort.signal.aborted) return;
    if (automaticUsername !== undefined && (usernameAuthorization !== automaticUsername || !matchesUsernameAuthorization(selected.review, automaticUsername))) return;
    if (executedRequestIds.has(selected.event.id)) return;
    if (!requestTrusted(selected.event)) { await shutdown("请求来源或会话已变化，连接已关闭。"); return; }
    if (automaticUsername !== undefined) {
      if (selected.review.kind !== "typedData") return;
      const signatureHash = hashTypedData(selected.review.payload.typedData);
      if (automaticSignatureHashes.has(signatureHash)) return;
      automaticSignatureHashes.add(signatureHash);
      usernameAuthorization = null; // Consume before any callback or await.
    }
    selected.executing = true;
    executedRequestIds.add(selected.event.id);
    publish({ status: "executing", usernameAuthorization, error: null });
    let executed = false;
    try {
      if (!ensureAvailable() || pending !== selected || selected.abort.signal.aborted) return;
      if (!requestTrusted(selected.event)) { await shutdown("请求来源或会话已变化，连接已关闭。"); return; }
      if (automaticUsername !== undefined && !matchesUsernameAuthorization(selected.review!, automaticUsername)) throw new WalletConnectPolicyError("用户名签名已过期或内容已变化，请在官网重新保存。");
      const result = await dependencies.executeApprovedRequest(selected.review!, wallet.walletId, wallet.address, { signal: selected.abort.signal });
      executed = true;
      if (!stopped && selected.review!.kind === "transaction" && typeof result === "string" && /^0x[0-9a-fA-F]{64}$/.test(result)) {
        publish({ outcome: { title: "交易已提交，请核对链上结果", transactionHash: result } });
      }
      if (!ensureAvailable() || pending !== selected || selected.abort.signal.aborted) return;
      if (!requestTrusted(selected.event)) { await shutdown("请求已处理，但会话或请求已失效；请核对官网或链上结果后重新连接。"); return; }
      await within(handle.kit.respondSessionRequest({ topic: selected.event.topic, response: { id: selected.event.id, jsonrpc: "2.0", result } }));
      if (!available() || pending !== selected) return;
      if (selected.review!.kind === "switchChain" && Object.values(handle.kit.getActiveSessions()[selected.event.topic]?.namespaces ?? {}).some((namespace) => namespace.events.includes("chainChanged"))) {
        await within(handle.kit.emitSessionEvent({ topic: selected.event.topic, chainId: CHAIN, event: { name: "chainChanged", data: INK_CHAIN_ID } }));
      }
      if (!available() || pending !== selected) return;
      pending = null;
      publish({ status: "connected", request: null, error: null,
        ...(automaticUsername !== undefined ? { outcome: { title: `已按本次授权签署用户名：${automaticUsername}，请在官网核对保存结果。` } } : {}),
      });
    } catch (error) {
      if (stopped || pending !== selected) return;
      if (executed) {
        await shutdown(selected.review!.kind === "transaction"
          ? "交易已提交，但结果未送达官网；请先按哈希查询，勿重复提交。连接已关闭。"
          : "请求已处理，但官网未确认收到结果。连接已关闭；请先在官网核对结果，再决定是否重试。");
        return;
      }
      selected.abort.abort();
      await rejectEvent(selected.event);
      if (!stopped && pending === selected) {
        pending = null;
        publish({ status: "connected", request: null, error: error instanceof WalletConnectPolicyError ? error.message : "请求处理失败或确认已过期。请先在官网核对结果，再决定是否重新发起。" });
      }
    }
  }

  const bridge: NadoBridge = {
    getSnapshot: () => structuredClone(snapshot),
    async pair(uri) {
      if (!ensureAvailable() || !handle) return;
      if (pairing || topic || proposal || pending) { publish({ error: "请先断开当前连接，再连接其他钱包或官网会话。" }); return; }
      const value = uri.trim();
      if (value.length > 4_096 || !/^wc:[a-fA-F0-9]{64}@2\?/.test(value)) { publish({ error: "请粘贴官网生成的有效 WalletConnect 连接链接。" }); return; }
      pairing = true;
      publish({ status: "connecting", error: null });
      pairTimer = setTimeout(() => { if (!topic && !proposal) void shutdown("等待官网连接超时，请重新生成连接链接。"); }, 60_000);
      try { await within(handle.kit.pair({ uri: value })); }
      catch { await shutdown("连接失败，请检查项目 ID、网络和官网连接链接后重试。"); }
    },
    async approveProposal() {
      if (!ensureAvailable() || !handle || !proposal || proposalApproving || topic) return;
      const selected = proposal;
      if (!verifiedOfficial(selected.event.verifyContext, selected.event.params.proposer.metadata.url) || selected.event.params.expiryTimestamp * 1000 <= Date.now()) { await shutdown("官网来源验证失效或连接申请已过期，请重新连接。"); return; }
      proposalApproving = true;
      publish({ status: "connecting", error: null });
      try {
        const session = await within(handle.kit.approveSession({ id: selected.event.id, namespaces: selected.namespaces }));
        if (!ensureAvailable() || proposal !== selected) { await handle?.cleanup(); return; }
        if (!sameOfficialOrigin(session.peer.metadata.url)) { await shutdown("官网来源验证失效，连接已关闭。"); return; }
        topic = session.topic;
        proposal = null; pairing = false;
        publish({ status: "connected", proposal: null, error: null });
      } catch { await shutdown("无法确认连接，请在官网重新发起。"); }
      finally { proposalApproving = false; }
    },
    async rejectProposal() { await shutdown(); },
    async approveRequest(expectedRequestId) {
      if (!pending) return;
      if (pending.event.id !== expectedRequestId) {
        publish({ error: "待确认请求已变化，请重新核对当前请求后再确认。" });
        return;
      }
      await executeRequest(pending);
    },
    setUsernameAuthorization(username) {
      if (!ensureAvailable()) return;
      if (pending?.executing && username !== null) throw new Error("请等待当前请求处理完毕。");
      if (username !== null) getUsernamePayloadHash(username); // Validate the exact name before arming.
      usernameAuthorization = username;
      publish({ usernameAuthorization });
      const selected = pending;
      if (selected && username !== null) void tryUsernameAuthorization(selected).catch(() => shutdown("无法处理用户名签名，请在官网核对结果。"));
    },
    async rejectRequest() {
      if (!pending || stopped || pending.abort.signal.aborted) return;
      if (pending.executing) return;
      const selected = pending;
      selected.abort.abort();
      await rejectEvent(selected.event);
      if (!stopped && pending === selected) {
        pending = null;
        publish({ status: "connected", request: null, error: null });
      }
    },
    disconnect: () => shutdown(),
    dispose: () => shutdown(),
  };
  activeBridge = bridge;
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  monitor = setInterval(() => { ensureAvailable(); }, 500);
  if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide);
  if (options.signal?.aborted) await shutdown();
  await previous?.dispose();
  try {
    if (!ensureAvailable()) throw new Error("连接初始化已取消。");
    const initialization = dependencies.createSdk(options.projectId.trim(), lifecycle.signal);
    // A timed-out SDK initialization can finish later. It must never resurrect authority.
    void initialization.then((sdk) => { if (stopped) return sdk.cleanup(); }).catch(() => undefined);
    const initialized = await within(initialization, 20_000, lifecycle.signal);
    if (stopped || activeBridge !== bridge || !dependencies.isWalletAvailable(wallet)) {
      await initialized.cleanup();
      await shutdown();
      throw new Error("连接初始化已取消。");
    }
    handle = initialized;
    // Empty, isolated storage is mandatory; never restore a previous wallet's authority.
    if (Object.keys(handle.kit.getActiveSessions()).length) throw new Error("不允许恢复旧会话。");
    handle.kit.on("session_proposal", onProposal);
    handle.kit.on("session_request", onRequest);
    handle.kit.on("session_delete", onDelete);
    handle.kit.on("proposal_expire", onProposalExpire);
    handle.kit.on("session_request_expire", onRequestExpire);
    handle.kit.on("session_authenticate", onAuthenticate);
    publish({ status: "idle", error: null });
    return bridge;
  } catch {
    await shutdown("无法初始化官网连接，请检查项目 ID 和网络后重试。");
    throw new Error("无法初始化官网连接，请检查项目 ID 和网络后重试。");
  }
}
