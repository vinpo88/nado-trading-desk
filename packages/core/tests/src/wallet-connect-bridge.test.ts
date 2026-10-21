import { afterEach, describe, expect, it, vi } from "vitest";
import { createNadoBridge } from "../../../../apps/console/app/lib/walletConnectBridge";
import type { BridgeKit, NadoBridge } from "../../../../apps/console/app/lib/walletConnectBridge";

vi.mock("../../../../apps/console/app/lib/custody", () => ({
  isUnlocked: () => { throw new Error("Unexpected real custody access"); },
  cohortWallets: () => { throw new Error("Unexpected real custody access"); },
}));
vi.mock("../../../../apps/console/app/lib/walletConnectSigning", () => ({
  prepareTransaction: () => { throw new Error("Unexpected real transaction preparation"); },
  executeApprovedRequest: () => { throw new Error("Unexpected real signing"); },
}));

const ADDRESS = `0x${"11".repeat(20)}`;
const CHAIN = "eip155:57073";
const bridges: NadoBridge[] = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map(bridge => bridge.dispose())); });

function proposal(validation = "VALID", origin = "https://app.nado.xyz") {
  return {
    id: 7,
    params: {
      id: 7, expiryTimestamp: Math.floor(Date.now() / 1000) + 300,
      relays: [{ protocol: "irn" }], pairingTopic: "synthetic-pairing",
      proposer: { publicKey: "22".repeat(32), metadata: { name: "Synthetic Nado", description: "Test", url: origin, icons: [] } },
      requiredNamespaces: {},
      optionalNamespaces: { eip155: { chains: [CHAIN], methods: ["personal_sign", "eth_chainId"], events: [] } },
    },
    verifyContext: { verified: { origin, validation, isScam: false } },
  };
}

async function fixture() {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const active: Record<string, any> = {};
  const rejected: number[] = [];
  const approved: unknown[] = [];
  const authenticateRejected = vi.fn();
  const execute = vi.fn(async () => { throw new Error("Authentication must never sign"); });
  const cleanup = vi.fn(async () => {});
  const kit = {
    on(name: string, listener: (event: any) => void) {
      const group = listeners.get(name) ?? new Set();
      group.add(listener); listeners.set(name, group);
    },
    off(name: string, listener: (event: any) => void) { listeners.get(name)?.delete(listener); },
    async pair() {},
    getActiveSessions: () => active,
    async approveSession(input: { namespaces: unknown }) {
      approved.push(input);
      const session = {
        topic: "synthetic-session", expiry: Math.floor(Date.now() / 1000) + 600,
        namespaces: input.namespaces, peer: { metadata: { url: "https://app.nado.xyz" } },
      };
      active[session.topic] = session;
      return session;
    },
    async rejectSession({ id }: { id: number }) { rejected.push(id); },
    async respondSessionRequest() {},
    async disconnectSession({ topic }: { topic: string }) { delete active[topic]; },
    rejectSessionAuthenticate: authenticateRejected,
    async emitSessionEvent() {},
  };
  const bridge = await createNadoBridge({
    projectId: "0123456789abcdef0123456789abcdef",
    wallet: { walletId: "synthetic-wallet", address: ADDRESS },
    onChange() {},
  }, {
    createSdk: async () => ({ kit: kit as unknown as BridgeKit, cleanup }),
    isWalletAvailable: () => true,
    executeApprovedRequest: execute,
  });
  bridges.push(bridge);
  const emit = (name: string, event: unknown) => {
    for (const listener of listeners.get(name) ?? []) listener(event);
  };
  // SignClient 2.25 shouldIgnorePairingRequest suppresses a fallback proposal
  // when the URI expects authentication and an authentication listener exists.
  const emitFallback = (event: ReturnType<typeof proposal>) => {
    if ((listeners.get("session_authenticate")?.size ?? 0) === 0) emit("session_proposal", event);
  };
  await bridge.pair(`wc:${"ab".repeat(32)}@2?symKey=${"cd".repeat(32)}&methods=wc_sessionAuthenticate`);
  return { bridge, listeners, emit, emitFallback, rejected, approved, authenticateRejected, execute, cleanup };
}

describe("WalletConnect authentication fallback without added signing authority", () => {
  it("leaves authentication unhandled and requires explicit approval of the ordinary verified proposal", async () => {
    const f = await fixture();
    f.bridge.setUsernameAuthorization("demo2");
    expect(f.listeners.get("session_authenticate")?.size ?? 0).toBe(0);
    f.emit("session_authenticate", { id: 8, topic: "synthetic-pairing", params: {} });
    expect(f.bridge.getSnapshot().status).toBe("connecting");
    expect(f.bridge.getSnapshot().error).toBeNull();
    expect(f.authenticateRejected).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    f.emitFallback(proposal());
    await vi.waitFor(() => expect(f.bridge.getSnapshot().status).toBe("proposal"));
    expect(f.bridge.getSnapshot().proposal?.address).toBe(ADDRESS);
    expect(f.approved).toHaveLength(0);
    await f.bridge.approveProposal();
    expect(f.bridge.getSnapshot().status).toBe("connected");
    expect(f.approved).toHaveLength(1);
    expect(f.execute).not.toHaveBeenCalled();
    f.emit("session_authenticate", { id: 9, topic: "synthetic-pairing", params: {} });
    expect(f.bridge.getSnapshot().error).toBeNull();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["UNKNOWN", "https://app.nado.xyz"],
    ["VALID", "https://untrusted.example"],
  ])("rejects fallback with verification %s and origin %s", async (validation, origin) => {
    const f = await fixture();
    f.emitFallback(proposal(validation, origin));
    await vi.waitFor(() => expect(f.bridge.getSnapshot().status).toBe("disconnected"));
    expect(f.rejected).toEqual([7]);
    expect(f.approved).toHaveLength(0);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.bridge.getSnapshot().proposal).toBeNull();
    expect(f.bridge.getSnapshot().error).toBeTruthy();
  });

  it("does not let disposed SDK events alter the next wallet connection", async () => {
    const old = await fixture();
    const next = await fixture();
    expect(old.bridge.getSnapshot().status).toBe("disconnected");
    expect([...old.listeners.values()].every(group => group.size === 0)).toBe(true);
    old.emit("session_authenticate", { id: 10, params: {} });
    old.emit("session_proposal", proposal());
    expect(next.bridge.getSnapshot().status).toBe("connecting");
    expect(next.bridge.getSnapshot().error).toBeNull();
    next.emitFallback(proposal());
    await vi.waitFor(() => expect(next.bridge.getSnapshot().status).toBe("proposal"));
    expect(old.execute).not.toHaveBeenCalled();
    expect(next.execute).not.toHaveBeenCalled();
  });
});
