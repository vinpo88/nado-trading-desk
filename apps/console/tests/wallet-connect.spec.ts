// Disposable browser wallets and in-memory SDK doubles only. Never connects to a live relay.
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { INK_CHAIN_ID, MAX_TRANSACTION_VALUE, SUPPORTED_METHODS, validateRequest } from "../app/lib/walletConnectPolicy";
import { createNadoBridge } from "../app/lib/walletConnectBridge";
import type { BridgeDependencies, BridgeKit, BridgeOptions, BridgeSdkHandle } from "../app/lib/walletConnectBridge";
import { getUsernamePayloadHash } from "../app/lib/nadoUsernameAuthorization";

test.use({ trace: "off", screenshot: "off", video: "off", serviceWorkers: "block" });

const FAKE_PROJECT_ID = "0123456789abcdef0123456789abcdef";
const CONNECT_WALLET_LABEL = "钱包编号（从 1 开始）";
const ADDRESS = `0x${"11".repeat(20)}`;
const OTHER_ADDRESS = `0x${"22".repeat(20)}`;
const CONTRACT = `0x${"33".repeat(20)}`;

function loginMessage(overrides: Partial<Record<"domain" | "address" | "uri" | "chain" | "nonce" | "issued", string>> = {}) {
  return [
    `${overrides.domain ?? "app.nado.xyz"} wants you to sign in with your Ethereum account:`,
    overrides.address ?? ADDRESS, "", "Sign in to Nado.", "",
    `URI: ${overrides.uri ?? "https://app.nado.xyz/perpetuals"}`,
    "Version: 1", `Chain ID: ${overrides.chain ?? INK_CHAIN_ID}`,
    `Nonce: ${overrides.nonce ?? "testNonce123"}`,
    `Issued At: ${overrides.issued ?? new Date().toISOString()}`,
  ].join("\n");
}

const messageHex = (text: string) => `0x${Buffer.from(text, "utf8").toString("hex")}`;

function orderData() {
  return {
    domain: { name: "Nado", version: "1", chainId: INK_CHAIN_ID, verifyingContract: CONTRACT },
    types: { Order: [{ name: "sender", type: "bytes32" }, { name: "amount", type: "int128" }] },
    primaryType: "Order", message: { sender: `${ADDRESS}${"00".repeat(12)}`, amount: "1000000000000000000" },
  };
}

function usernameData(username = "ybtl6") {
  return {
    domain: { name: "Nado", version: "0.0.1", chainId: INK_CHAIN_ID, verifyingContract: "0x05ec92D78ED421f3D3Ada77FFdE167106565974E" },
    types: { NadoAuthentication: [
      { name: "method", type: "string" }, { name: "sender", type: "bytes32" },
      { name: "payloadHash", type: "bytes32" }, { name: "nonce", type: "uint64" },
    ] },
    primaryType: "NadoAuthentication",
    message: {
      method: "mobile:execute_set_username", sender: `${ADDRESS}64656661756c740000000000`,
      payloadHash: getUsernamePayloadHash(username),
      nonce: ((BigInt(Date.now()) + 30_000n) * 1_000_000n + 123n).toString(),
    },
  };
}

test("policy: only fresh official SIWE login for the selected mainnet address is accepted", () => {
  const message = loginMessage();
  const review = validateRequest("personal_sign", [messageHex(message), ADDRESS], ADDRESS);
  expect(review.kind).toBe("login");
  expect(review.details).toContain(message);
  expect(Object.isFrozen(review)).toBe(true);
  expect(Object.isFrozen(review.payload)).toBe(true);
  for (const invalid of [
    loginMessage({ domain: "app.nado.xyz.evil.example" }),
    loginMessage({ uri: "https://app.nado.xyz.evil.example" }),
    loginMessage({ uri: "https://user@app.nado.xyz" }), // allow-pii: synthetic URL userinfo rejection fixture, not an email.
    loginMessage({ uri: "http://app.nado.xyz" }),
    loginMessage({ address: OTHER_ADDRESS }),
    loginMessage({ chain: "1" }),
    loginMessage({ nonce: "short" }),
    loginMessage({ issued: new Date(Date.now() - 360_000).toISOString() }),
    loginMessage({ issued: new Date(Date.now() + 120_000).toISOString() }),
    `${message}\nExpiration Time: ${new Date(Date.now() - 1_000).toISOString()}`,
    `${message}\nResources:\n- https://evil.example`,
    `${message}\nChain ID: 1`,
    "Please sign this arbitrary message.",
  ]) expect(() => validateRequest("personal_sign", [messageHex(invalid), ADDRESS], ADDRESS)).toThrow();
  expect(() => validateRequest("personal_sign", [messageHex(message), OTHER_ADDRESS], ADDRESS)).toThrow();
  expect(() => validateRequest("personal_sign", [ADDRESS, messageHex(message)], ADDRESS)).toThrow();
  expect(() => validateRequest("personal_sign", ["0xff", ADDRESS], ADDRESS)).toThrow();
});

test("policy: typed requests bind chain, contract and owner and freeze the reviewed payload", () => {
  const original = orderData();
  const review = validateRequest("eth_signTypedData_v4", [ADDRESS, original], ADDRESS);
  expect(review.kind).toBe("typedData");
  expect(review.title).toBe("签署 Nado 订单");
  expect(review.caution).toContain("真实订单");
  if (review.kind !== "typedData") throw new Error("Expected typed review");
  expect(Object.isFrozen(review.payload.typedData.message)).toBe(true);
  original.message.amount = "9";
  expect(review.payload.typedData.message?.amount).toBe("1000000000000000000");
  for (const mutation of [
    (value: Record<string, any>) => { value.domain.chainId = 1; },
    (value: Record<string, any>) => { delete value.domain.chainId; },
    (value: Record<string, any>) => { value.domain.verifyingContract = `0x${"00".repeat(20)}`; },
    (value: Record<string, any>) => { value.message.sender = `${OTHER_ADDRESS}${"00".repeat(12)}`; },
    (value: Record<string, any>) => { value.message.owner = OTHER_ADDRESS; },
    (value: Record<string, any>) => { value.message.amount = Number.MAX_SAFE_INTEGER + 1; },
    (value: Record<string, any>) => { value.types.Order.push({ name: "amount", type: "uint256" }); },
  ]) {
    const invalid = orderData(); mutation(invalid);
    expect(() => validateRequest("eth_signTypedData_v4", [ADDRESS, invalid], ADDRESS)).toThrow();
  }
  expect(() => validateRequest("eth_signTypedData_v4", [OTHER_ADDRESS, orderData()], ADDRESS)).toThrow();
  expect(() => validateRequest("eth_signTypedData_v4", [ADDRESS, "{"], ADDRESS)).toThrow();
  expect(() => validateRequest("eth_signTypedData_v4", [ADDRESS, '{"__proto__":{}}'], ADDRESS)).toThrow();
});

test("policy: transactions display authorization scope and reject unsafe or ambiguous fields", () => {
  const allowance = `0x095ea7b3${"00".repeat(12)}${OTHER_ADDRESS.slice(2)}${"ff".repeat(32)}`;
  const tx = { from: ADDRESS, to: CONTRACT, chainId: INK_CHAIN_ID, data: allowance, value: "0x0" };
  const review = validateRequest("eth_sendTransaction", [tx], ADDRESS);
  expect(review.kind).toBe("transaction");
  expect(review.title).toBe("授权代币支出额度");
  expect(review.details).toContain("无限额度");
  expect(review.details).toContain(OTHER_ADDRESS);
  for (const mutation of [
    { from: OTHER_ADDRESS }, { to: `0x${"00".repeat(20)}` }, { chainId: 1 },
    { value: `0x${(MAX_TRANSACTION_VALUE + 1n).toString(16)}` },
    { data: "0x0" }, { input: "0x" }, { type: "0x4" },
    { gasPrice: "0x1", maxFeePerGas: "0x2" }, { value: "0x00" },
    { nonce: "0x20000000000000" }, { authorizationList: [] },
  ]) expect(() => validateRequest("eth_sendTransaction", [{ ...tx, ...mutation }], ADDRESS)).toThrow();
  const missingChain: Record<string, unknown> = { ...tx }; delete missingChain.chainId;
  const inferredChain = validateRequest("eth_sendTransaction", [missingChain], ADDRESS);
  expect(inferredChain.kind === "transaction" && inferredChain.payload.chainId).toBe(INK_CHAIN_ID);
  for (const method of ["eth_sign", "eth_sendRawTransaction", "wallet_addEthereumChain", "wallet_grantPermissions"]) {
    expect(() => validateRequest(method, [], ADDRESS)).toThrow();
  }
  expect(validateRequest("wallet_switchEthereumChain", [{ chainId: "0xdef1" }], ADDRESS).kind).toBe("switchChain");
  expect(() => validateRequest("wallet_switchEthereumChain", [{ chainId: "0x1" }], ADDRESS)).toThrow();
});

type FakeNamespace = { accounts: string[]; methods: string[]; events: string[]; chains?: string[] };
type FakeSession = { topic: string; expiry: number; namespaces: Record<string, FakeNamespace>; peer: { metadata: { url: string } } };
type FakeResponse = { topic: string; response: { id: number; error?: { code: number }; result?: unknown } };
class FakeKit {
  listeners = new Map<string, Set<(event: any) => void>>();
  active: Record<string, FakeSession> = {};
  responses: FakeResponse[] = [];
  rejected: number[] = [];
  approved = 0;
  paired = 0;
  on(event: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener); this.listeners.set(event, listeners);
  }
  off(event: string, listener: (event: any) => void) { this.listeners.get(event)?.delete(listener); }
  emit(event: string, value: unknown) { for (const listener of this.listeners.get(event) ?? []) listener(value); }
  async pair() { this.paired++; }
  async approveSession(options: { namespaces: Record<string, FakeNamespace> }) {
    this.approved++;
    const session = { topic: "disposable-session", expiry: Math.floor(Date.now() / 1000) + 600, namespaces: structuredClone(options.namespaces), peer: { metadata: { url: "https://app.nado.xyz" } } };
    this.active[session.topic] = session;
    return structuredClone(session);
  }
  async rejectSession(options: { id: number }) { this.rejected.push(options.id); }
  async respondSessionRequest(response: FakeResponse) { this.responses.push(structuredClone(response)); }
  async disconnectSession(options: { topic: string }) { delete this.active[options.topic]; }
  getActiveSessions() { return this.active; }
  async rejectSessionAuthenticate() {}
  async emitSessionEvent() {}
}

function officialProposal(methods = ["personal_sign", "eth_chainId"]) {
  return {
    id: 1,
    params: {
      id: 1, expiryTimestamp: Math.floor(Date.now() / 1000) + 300,
      relays: [{ protocol: "irn" }], pairingTopic: "disposable-pairing",
      proposer: { publicKey: "44".repeat(32), metadata: { name: "Nado", description: "Test only", url: "https://app.nado.xyz", icons: [] } },
      requiredNamespaces: { eip155: { chains: ["eip155:57073"], methods, events: [] } },
      optionalNamespaces: {},
    },
    verifyContext: { verified: { origin: "https://app.nado.xyz", validation: "VALID", isScam: false } },
  };
}

function officialRequest(id: number, method = "personal_sign", params: unknown = [messageHex(loginMessage()), ADDRESS]) {
  return {
    id, topic: "disposable-session",
    params: { chainId: "eip155:57073", request: { method, params, expiryTimestamp: Math.floor(Date.now() / 1000) + 120 } },
    verifyContext: { verified: { origin: "https://app.nado.xyz", validation: "VALID", isScam: false } },
  };
}

async function fakeBridge(overrides: Partial<BridgeDependencies> = {}, onChange: BridgeOptions["onChange"] = () => {}) {
  const kit = new FakeKit();
  const counts = { executions: 0, preparations: 0, cleanup: 0, available: true };
  const bridge = await createNadoBridge({ projectId: FAKE_PROJECT_ID, wallet: { walletId: "disposable-wallet", address: ADDRESS }, onChange }, {
    createSdk: async () => ({ kit: kit as unknown as BridgeKit, cleanup: async () => { counts.cleanup++; } }),
    isWalletAvailable: () => counts.available,
    executeApprovedRequest: async () => { counts.executions++; return "0x" + "ab".repeat(65); },
    prepareTransaction: async () => { counts.preparations++; throw new Error("Unexpected transaction preparation"); },
    ...overrides,
  });
  return { kit, counts, bridge };
}

async function pairFake(fixture: Awaited<ReturnType<typeof fakeBridge>>, methods?: string[]) {
  await fixture.bridge.pair(`wc:${"ab".repeat(32)}@2?relay-protocol=irn&symKey=${"cd".repeat(32)}`);
  fixture.kit.emit("session_proposal", officialProposal(methods));
  await expect.poll(() => fixture.bridge.getSnapshot().status).toBe("proposal");
}

test("bridge: connection, login and even reads wait for explicit approval; duplicate clicks execute once", async () => {
  const fixture = await fakeBridge();
  try {
    await pairFake(fixture);
    expect(fixture.kit.approved).toBe(0);
    expect(fixture.counts.executions).toBe(0);
    await fixture.bridge.approveProposal();
    expect(fixture.bridge.getSnapshot().status).toBe("connected");
    expect(fixture.kit.approved).toBe(1);
    fixture.kit.emit("session_request", officialRequest(2));
    await expect.poll(() => fixture.bridge.getSnapshot().status).toBe("request");
    expect(fixture.counts.executions).toBe(0);
    expect(fixture.kit.responses).toHaveLength(0);
    await fixture.bridge.rejectRequest();
    expect(fixture.kit.responses[0]?.response.error?.code).toBe(4001);
    expect(fixture.counts.executions).toBe(0);
    fixture.kit.emit("session_request", officialRequest(3));
    await expect.poll(() => fixture.bridge.getSnapshot().status).toBe("request");
    await Promise.all([fixture.bridge.approveRequest(3), fixture.bridge.approveRequest(3)]);
    expect(fixture.counts.executions).toBe(1);
    expect(fixture.kit.responses.filter((response) => response.response.id === 3)).toHaveLength(1);
    expect(JSON.stringify(fixture.bridge.getSnapshot()).includes("ab".repeat(65)), "signature bytes must not be exposed by the UI snapshot").toBe(false);
    fixture.kit.emit("session_request", officialRequest(4, "eth_chainId", []));
    await expect.poll(() => fixture.bridge.getSnapshot().status).toBe("request");
    expect(fixture.counts.executions).toBe(1);
    await fixture.bridge.rejectRequest();
    expect(fixture.counts.executions).toBe(1);
  } finally { await fixture.bridge.dispose(); }
  expect(fixture.counts.cleanup).toBe(1);
  expect([...fixture.kit.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
});

test("bridge: a stale manual approval cannot sign the request that replaces an expired review", async () => {
  const fixture = await fakeBridge();
  try {
    await pairFake(fixture, ["personal_sign", "eth_signTypedData_v4"]);
    await fixture.bridge.approveProposal();
    fixture.kit.emit("session_request", officialRequest(600));
    await expect.poll(() => fixture.bridge.getSnapshot().request?.id).toBe(600);
    const originallyReviewedId = fixture.bridge.getSnapshot().request!.id;
    fixture.kit.emit("session_request_expire", { id: originallyReviewedId });
    expect(fixture.bridge.getSnapshot().request).toBeNull();
    fixture.kit.emit("session_request", officialRequest(601, "eth_signTypedData_v4", [ADDRESS, orderData()]));
    await expect.poll(() => fixture.bridge.getSnapshot().request?.id).toBe(601);
    expect(fixture.bridge.getSnapshot().request?.title).toBe("签署 Nado 订单");

    await fixture.bridge.approveRequest(originallyReviewedId);
    expect(fixture.counts.executions).toBe(0);
    expect(fixture.bridge.getSnapshot().request?.id).toBe(601);
    expect(fixture.bridge.getSnapshot().error).toBeTruthy();
    expect(fixture.kit.responses.filter((response) => response.response.result !== undefined)).toHaveLength(0);

    const newlyReviewedId = fixture.bridge.getSnapshot().request!.id;
    await fixture.bridge.approveRequest(newlyReviewedId);
    expect(fixture.counts.executions).toBe(1);
    expect(fixture.kit.responses.filter((response) => response.response.id === 601 && response.response.result !== undefined)).toHaveLength(1);
    expect(fixture.kit.responses.some((response) => response.response.id === originallyReviewedId && response.response.result !== undefined)).toBe(false);
  } finally { await fixture.bridge.dispose(); }
});

test("bridge: username authorization defaults off and signs only the exact pending name once", async () => {
  const fixture = await fakeBridge();
  try {
    await pairFake(fixture, ["eth_signTypedData_v4"]);
    await fixture.bridge.approveProposal();
    expect(fixture.bridge.getSnapshot().usernameAuthorization).toBeNull();
    const signedData = usernameData();
    fixture.kit.emit("session_request", officialRequest(500, "eth_signTypedData_v4", [ADDRESS, signedData]));
    await expect.poll(() => fixture.bridge.getSnapshot().status).toBe("request");
    expect(fixture.counts.executions).toBe(0);
    fixture.bridge.setUsernameAuthorization("ybtl6");
    await Promise.all([fixture.bridge.approveRequest(500), fixture.bridge.approveRequest(500)]);
    await expect.poll(() => fixture.bridge.getSnapshot().status).toBe("connected");
    expect(fixture.counts.executions).toBe(1);
    expect(fixture.bridge.getSnapshot().usernameAuthorization).toBeNull();
    expect(fixture.kit.responses.filter((response) => response.response.id === 500 && response.response.result !== undefined)).toHaveLength(1);

    // A fresh request cannot inherit the already consumed permission.
    fixture.kit.emit("session_request", officialRequest(501, "eth_signTypedData_v4", [ADDRESS, usernameData()]));
    await expect.poll(() => fixture.bridge.getSnapshot().status).toBe("request");
    expect(fixture.counts.executions).toBe(1);
    await fixture.bridge.rejectRequest();

    // Explicitly re-arming must still never execute an already processed request ID.
    fixture.bridge.setUsernameAuthorization("ybtl6");
    fixture.kit.emit("session_request", officialRequest(500, "eth_signTypedData_v4", [ADDRESS, usernameData()]));
    await expect.poll(() => fixture.kit.responses.filter((response) => response.response.id === 500).length).toBe(2);
    expect(fixture.counts.executions).toBe(1);
    expect(fixture.kit.responses.at(-1)?.response.error).toBeDefined();
    // A different JSON-RPC ID cannot replay the same signed bytes automatically.
    fixture.kit.emit("session_request", officialRequest(502, "eth_signTypedData_v4", [ADDRESS, signedData]));
    await expect.poll(() => fixture.bridge.getSnapshot().status).toBe("request");
    expect(fixture.counts.executions).toBe(1);
    expect(fixture.kit.responses.some((response) => response.response.id === 502 && response.response.result !== undefined)).toBe(false);
  } finally { await fixture.bridge.dispose(); }
});

test("bridge: armed username permission ignores other names, methods and altered payloads", async () => {
  const fixture = await fakeBridge();
  try {
    await pairFake(fixture, [...SUPPORTED_METHODS]);
    await fixture.bridge.approveProposal();
    fixture.bridge.setUsernameAuthorization("ybtl6");
    const wrongMethod = usernameData(); wrongMethod.message.method = "mobile:execute_set_bio";
    const wrongHash = usernameData(); wrongHash.message.payloadHash = `0x${"00".repeat(32)}`;
    const wrongContract = usernameData(); wrongContract.domain.verifyingContract = CONTRACT;
    const expired = usernameData(); expired.message.nonce = ((BigInt(Date.now()) - 1_000n) * 1_000_000n).toString();
    const delegation = {
      domain: usernameData().domain, primaryType: "LinkSigner",
      types: { LinkSigner: [{ name: "sender", type: "bytes32" }, { name: "signer", type: "bytes32" }, { name: "nonce", type: "uint64" }] },
      message: { sender: usernameData().message.sender, signer: `0x${"22".repeat(32)}`, nonce: "1" },
    };
    const requests = [
      officialRequest(510, "eth_signTypedData_v4", [ADDRESS, usernameData("ybtl7")]),
      officialRequest(511, "eth_signTypedData_v4", [ADDRESS, wrongMethod]),
      officialRequest(512, "eth_signTypedData_v4", [ADDRESS, wrongHash]),
      officialRequest(513, "eth_signTypedData_v4", [ADDRESS, wrongContract]),
      officialRequest(514, "eth_signTypedData_v4", [ADDRESS, expired]),
      officialRequest(515, "eth_signTypedData_v4", [ADDRESS, orderData()]),
      officialRequest(516),
      officialRequest(517, "eth_chainId", []),
      officialRequest(519, "eth_signTypedData_v4", [ADDRESS, delegation]),
    ];
    for (const request of requests) {
      fixture.kit.emit("session_request", request);
      await expect.poll(() => fixture.bridge.getSnapshot().status).toBe("request");
      expect(fixture.counts.executions).toBe(0);
      expect(fixture.bridge.getSnapshot().usernameAuthorization).toBe("ybtl6");
      await fixture.bridge.rejectRequest();
    }
    fixture.kit.emit("session_request", officialRequest(518, "eth_signTypedData_v4", [ADDRESS, usernameData()]));
    await expect.poll(() => fixture.counts.executions).toBe(1);
    await expect.poll(() => fixture.bridge.getSnapshot().status).toBe("connected");
    expect(fixture.bridge.getSnapshot().usernameAuthorization).toBeNull();
    expect(fixture.counts.preparations).toBe(0);
  } finally { await fixture.bridge.dispose(); }
});

test("bridge: username authorization can be revoked and never crosses a disconnected session", async () => {
  const fixture = await fakeBridge();
  try {
    await pairFake(fixture, ["eth_signTypedData_v4"]);
    await fixture.bridge.approveProposal();
    fixture.bridge.setUsernameAuthorization("ybtl6");
    fixture.bridge.setUsernameAuthorization(null);
    fixture.kit.emit("session_request", officialRequest(520, "eth_signTypedData_v4", [ADDRESS, usernameData()]));
    await expect.poll(() => fixture.bridge.getSnapshot().status).toBe("request");
    expect(fixture.counts.executions).toBe(0);
    await fixture.bridge.rejectRequest();
    fixture.bridge.setUsernameAuthorization("ybtl6");
    await fixture.bridge.disconnect();
    expect(fixture.bridge.getSnapshot().usernameAuthorization).toBeNull();
    fixture.kit.emit("session_request", officialRequest(521, "eth_signTypedData_v4", [ADDRESS, usernameData()]));
    await fixture.bridge.approveRequest(521);
    expect(fixture.counts.executions).toBe(0);
  } finally { await fixture.bridge.dispose(); }
  const next = await fakeBridge();
  try { expect(next.bridge.getSnapshot().usernameAuthorization).toBeNull(); }
  finally { await next.bridge.dispose(); }
});

test("bridge: username permission is consumed before execution and cannot retry a failed attempt", async () => {
  let calls = 0;
  const fixture = await fakeBridge({
    executeApprovedRequest: async () => {
      calls++;
      expect(fixture.bridge.getSnapshot().usernameAuthorization).toBeNull();
      throw new Error("Disposable signer failure");
    },
  });
  try {
    await pairFake(fixture, ["eth_signTypedData_v4"]);
    await fixture.bridge.approveProposal();
    fixture.bridge.setUsernameAuthorization("ybtl6");
    fixture.kit.emit("session_request", officialRequest(530, "eth_signTypedData_v4", [ADDRESS, usernameData()]));
    await expect.poll(() => fixture.kit.responses.some((response) => response.response.id === 530 && response.response.error)).toBeTruthy();
    expect(calls).toBe(1);
    expect(fixture.bridge.getSnapshot().usernameAuthorization).toBeNull();
    fixture.kit.emit("session_request", officialRequest(531, "eth_signTypedData_v4", [ADDRESS, usernameData()]));
    await expect.poll(() => fixture.bridge.getSnapshot().status).toBe("request");
    expect(calls).toBe(1);
  } finally { await fixture.bridge.dispose(); }
});

test("bridge: username auto-approval stays bound to the reviewed request when its callback revokes permission", async () => {
  let revoke: (() => void) | undefined;
  const fixture = await fakeBridge({}, (snapshot) => {
    if (snapshot.status === "request" && revoke) { const action = revoke; revoke = undefined; action(); }
  });
  try {
    await pairFake(fixture, ["eth_signTypedData_v4"]);
    await fixture.bridge.approveProposal();
    fixture.bridge.setUsernameAuthorization("ybtl6");
    revoke = () => fixture.bridge.setUsernameAuthorization(null);
    fixture.kit.emit("session_request", officialRequest(540, "eth_signTypedData_v4", [ADDRESS, usernameData()]));
    await expect.poll(() => fixture.bridge.getSnapshot().status).toBe("request");
    expect(fixture.bridge.getSnapshot().usernameAuthorization).toBeNull();
    expect(fixture.counts.executions).toBe(0);
    expect(fixture.kit.responses).toHaveLength(0);
  } finally { await fixture.bridge.dispose(); }
});

test("bridge: username auto-approval never approves a replacement pending request", async () => {
  let replace: (() => void) | undefined;
  let replacement: Promise<void> | undefined;
  const fixture = await fakeBridge({}, (snapshot) => {
    if (snapshot.status === "request" && replace) { const action = replace; replace = undefined; action(); }
  });
  try {
    await pairFake(fixture, ["eth_signTypedData_v4"]);
    await fixture.bridge.approveProposal();
    fixture.bridge.setUsernameAuthorization("ybtl6");
    replace = () => {
      replacement = fixture.bridge.rejectRequest().then(() => {
        fixture.kit.emit("session_request", officialRequest(551, "eth_signTypedData_v4", [ADDRESS, orderData()]));
      });
    };
    fixture.kit.emit("session_request", officialRequest(550, "eth_signTypedData_v4", [ADDRESS, usernameData()]));
    await replacement;
    await expect.poll(() => fixture.bridge.getSnapshot().request?.title).toBe("签署 Nado 订单");
    expect(fixture.counts.executions).toBe(0);
    expect(fixture.bridge.getSnapshot().usernameAuthorization).toBe("ybtl6");
    expect(fixture.kit.responses.filter((response) => response.response.result !== undefined)).toHaveLength(0);
  } finally { await fixture.bridge.dispose(); }
});

test("bridge: unverified, spoofed, expired or unsupported proposals never grant authority", async () => {
  const mutations: Array<(proposal: ReturnType<typeof officialProposal>) => void> = [
    (proposal) => { proposal.params.proposer.metadata.url = "https://app.nado.xyz.evil.example"; },
    (proposal) => { proposal.params.proposer.metadata.url = "https://user@app.nado.xyz"; }, // allow-pii: synthetic URL userinfo rejection fixture.
    (proposal) => { proposal.verifyContext.verified.validation = "INVALID"; },
    (proposal) => { proposal.verifyContext.verified.validation = "UNKNOWN"; },
    (proposal) => { proposal.verifyContext.verified.isScam = true; },
    (proposal) => { proposal.verifyContext.verified.origin = "https://evil.example"; },
    (proposal) => { proposal.params.expiryTimestamp = Math.floor(Date.now() / 1000) - 1; },
    (proposal) => { proposal.params.requiredNamespaces.eip155.chains = ["eip155:1"]; },
    (proposal) => { proposal.params.requiredNamespaces.eip155.methods = ["eth_sign"]; },
  ];
  for (const mutate of mutations) {
    const fixture = await fakeBridge();
    try {
      await fixture.bridge.pair(`wc:${"ab".repeat(32)}@2?relay-protocol=irn&symKey=${"cd".repeat(32)}`);
      const proposal = officialProposal(); mutate(proposal);
      fixture.kit.emit("session_proposal", proposal);
      await expect.poll(() => fixture.kit.rejected.length).toBe(1);
      await fixture.bridge.approveProposal();
      expect(fixture.kit.approved).toBe(0);
      expect(fixture.counts.executions).toBe(0);
    } finally { await fixture.bridge.dispose(); }
  }
});

test("bridge: Nado optional multi-chain proposal grants only Ink and the single selected address", async () => {
  const fixture = await fakeBridge();
  try {
    await fixture.bridge.pair(`wc:${"ab".repeat(32)}@2?relay-protocol=irn&symKey=${"cd".repeat(32)}`);
    const proposal = officialProposal();
    const observedShape = {
      ...proposal,
      params: {
        ...proposal.params,
        requiredNamespaces: {},
        optionalNamespaces: {
          eip155: {
            chains: ["eip155:57073", "eip155:1", "eip155:42161", "eip155:8453"],
            methods: [...SUPPORTED_METHODS, "wallet_addEthereumChain", "eth_signTypedData"],
            events: ["accountsChanged", "chainChanged"],
          },
        },
      },
    };
    fixture.kit.emit("session_proposal", observedShape);
    await expect.poll(() => fixture.bridge.getSnapshot().status).toBe("proposal");
    expect(fixture.kit.approved).toBe(0);
    await fixture.bridge.approveProposal();
    const approved = fixture.kit.active["disposable-session"]!.namespaces.eip155!;
    expect(approved.chains).toEqual(["eip155:57073"]);
    expect(approved.accounts).toEqual([`eip155:57073:${ADDRESS}`]);
    expect(approved.methods).toContain("personal_sign");
    expect(approved.methods.every((method) => (SUPPORTED_METHODS as readonly string[]).includes(method))).toBe(true);
    expect(approved.methods).not.toContain("wallet_addEthereumChain");
    expect(fixture.counts.executions).toBe(0);
  } finally { await fixture.bridge.dispose(); }
});

test("bridge: request origin, topic, chain, negotiated methods, expiry and wallet state are rechecked", async () => {
  const fixture = await fakeBridge();
  try {
    await pairFake(fixture, ["personal_sign"]);
    await fixture.bridge.approveProposal();
    const mutations: Array<(request: ReturnType<typeof officialRequest>) => void> = [
      (request) => { request.topic = "another-session"; },
      (request) => { request.params.chainId = "eip155:1"; },
      (request) => { request.verifyContext.verified.validation = "UNKNOWN"; },
      (request) => { request.verifyContext.verified.origin = "https://evil.example"; },
      (request) => { request.params.request.method = "eth_chainId"; request.params.request.params = []; },
      (request) => { request.params.request.expiryTimestamp = Math.floor(Date.now() / 1000) - 1; },
      (request) => { request.params.request.params = [messageHex(loginMessage()), OTHER_ADDRESS]; },
    ];
    let id = 10;
    for (const mutate of mutations) {
      const request = officialRequest(id++); mutate(request);
      fixture.kit.emit("session_request", request);
      await expect.poll(() => fixture.kit.responses.some((response) => response.response.id === request.id && response.response.error?.code === 4100)).toBe(true);
      await fixture.bridge.approveRequest(request.id);
      expect(fixture.counts.executions).toBe(0);
      expect(fixture.counts.preparations).toBe(0);
    }
    fixture.kit.emit("session_request", officialRequest(100));
    await expect.poll(() => fixture.bridge.getSnapshot().status).toBe("request");
    fixture.kit.emit("session_request", officialRequest(101));
    await expect.poll(() => fixture.kit.responses.find((response) => response.response.id === 101)?.response.error?.code).toBe(-32002);
    fixture.kit.emit("session_request_expire", { id: 100 });
    await fixture.bridge.approveRequest(100);
    expect(fixture.counts.executions).toBe(0);
    expect(fixture.bridge.getSnapshot().request).toBeNull();
    fixture.kit.emit("session_request", officialRequest(102));
    await expect.poll(() => fixture.bridge.getSnapshot().status).toBe("request");
    fixture.counts.available = false;
    await fixture.bridge.approveRequest(102);
    expect(fixture.counts.executions).toBe(0);
    expect(fixture.bridge.getSnapshot().status).toBe("disconnected");
  } finally { await fixture.bridge.dispose(); }
});

test("bridge: locking during SDK initialization cancels promptly and cleans a late SDK result", async () => {
  let available = true;
  let initialize!: (handle: BridgeSdkHandle) => void;
  let signal: AbortSignal | undefined;
  let cleanup = 0;
  const kit = new FakeKit();
  const result = createNadoBridge({ projectId: FAKE_PROJECT_ID, wallet: { walletId: "disposable-wallet", address: ADDRESS }, onChange() {} }, {
    isWalletAvailable: () => available,
    createSdk: async (_projectId, requestedSignal) => { signal = requestedSignal; return new Promise<BridgeSdkHandle>((resolve) => { initialize = resolve; }); },
  }).then((bridge) => ({ bridge, rejected: false }), () => ({ bridge: null, rejected: true }));
  await expect.poll(() => Boolean(initialize)).toBe(true);
  available = false;
  await expect.poll(() => signal?.aborted, { timeout: 3_000 }).toBe(true);
  expect((await result).rejected).toBe(true);
  initialize({ kit: kit as unknown as BridgeKit, cleanup: async () => { cleanup++; } });
  await expect.poll(() => cleanup).toBe(1);
  expect(kit.listeners.size).toBe(0);
});

test("bridge: expiration aborts an approved in-flight request and suppresses its late response", async () => {
  let finish!: (result: string) => void;
  let signal: AbortSignal | undefined;
  let executed = 0;
  const fixture = await fakeBridge({ executeApprovedRequest: async (_review, _walletId, _address, options) => {
    executed++; signal = options?.signal;
    return new Promise<string>((resolve) => { finish = resolve; });
  } });
  try {
    await pairFake(fixture);
    await fixture.bridge.approveProposal();
    fixture.kit.emit("session_request", officialRequest(200));
    await expect.poll(() => fixture.bridge.getSnapshot().status).toBe("request");
    const approval = fixture.bridge.approveRequest(200);
    await expect.poll(() => executed).toBe(1);
    fixture.kit.emit("session_request_expire", { id: 200 });
    expect(signal?.aborted).toBe(true);
    finish("disposable-simulated-result");
    await approval;
    expect(fixture.kit.responses.filter((response) => response.response.result !== undefined)).toHaveLength(0);
    expect(fixture.bridge.getSnapshot().request).toBeNull();
  } finally { await fixture.bridge.dispose(); }
});

test("bridge: explicit cancellation stops initialization and cannot resurrect a late SDK", async () => {
  const canceled = new AbortController(); canceled.abort();
  let created = 0;
  await expect(createNadoBridge({ projectId: FAKE_PROJECT_ID, wallet: { walletId: "disposable-wallet", address: ADDRESS }, signal: canceled.signal, onChange() {} }, {
    isWalletAvailable: () => true,
    createSdk: async () => { created++; throw new Error("Canceled initialization must not run"); },
  })).rejects.toThrow();
  expect(created).toBe(0);

  const controller = new AbortController();
  let initialize!: (handle: BridgeSdkHandle) => void;
  let innerSignal: AbortSignal | undefined;
  let cleanup = 0;
  const result = createNadoBridge({ projectId: FAKE_PROJECT_ID, wallet: { walletId: "disposable-wallet", address: ADDRESS }, signal: controller.signal, onChange() {} }, {
    isWalletAvailable: () => true,
    createSdk: async (_projectId, signal) => { innerSignal = signal; return new Promise<BridgeSdkHandle>((resolve) => { initialize = resolve; }); },
  }).then((bridge) => ({ bridge, rejected: false }), () => ({ bridge: null, rejected: true }));
  await expect.poll(() => Boolean(initialize)).toBe(true);
  controller.abort();
  expect((await result).rejected).toBe(true);
  expect(innerSignal?.aborted).toBe(true);
  const kit = new FakeKit();
  initialize({ kit: kit as unknown as BridgeKit, cleanup: async () => { cleanup++; } });
  await expect.poll(() => cleanup).toBe(1);
  expect(kit.listeners.size).toBe(0);
});

async function guardBrowser(page: Page, baseURL: string | undefined, holdExternal = false) {
  const origin = new URL(baseURL ?? "http://127.0.0.1:18271").origin;
  const record = { external: 0, sockets: 0, apiWrites: 0, apiReads: 0, pageErrors: 0 };
  const release: Array<() => void> = [];
  page.on("pageerror", () => record.pageErrors++);
  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      record.external++;
      if (holdExternal) await new Promise<void>((resolve) => release.push(resolve));
      await route.abort().catch(() => {});
      return;
    }
    if (url.pathname === "/api/nado/state") {
      await route.fulfill({ contentType: "application/json", body: '{"enabled":false}' });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (request.method() === "GET") record.apiReads++; else record.apiWrites++;
      await route.abort();
      return;
    }
    if (request.method() !== "GET") { record.apiWrites++; await route.abort(); return; }
    await route.continue();
  });
  await page.context().routeWebSocket(/.*/, () => {
    // A routed socket has no server connection unless connectToServer() is called.
    // Keep it unanswered so SDK initialization remains pending in the busy-state test.
    record.sockets++;
  });
  return { record, release: () => { for (const done of release.splice(0)) done(); } };
}

async function fillSecret(input: Locator, value: string) {
  await input.fill(value).catch(() => { throw new Error("Unable to enter disposable test secret"); });
}

async function createBrowserWallets(page: Page, password: string, count: number): Promise<string[]> {
  await page.goto("/accounts");
  await fillSecret(page.getByPlaceholder("输入保险库密码", { exact: true }), password);
  await fillSecret(page.getByPlaceholder("再次输入保险库密码", { exact: true }), password);
  await page.getByRole("button", { name: "创建保险库", exact: true }).click();
  await expect(page.getByText("暂无账户", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByPlaceholder("例如：批量钱包").fill("connect-test");
  await fillSecret(page.getByPlaceholder("输入保险库密码", { exact: true }), password);
  await page.getByLabel("派生钱包数量", { exact: true }).fill(String(count));
  await page.getByRole("button", { name: "创建账户", exact: true }).click();
  const account = page.getByTestId("account-block");
  await expect(account.getByText(`${count} 个钱包`, { exact: true })).toBeVisible({ timeout: 180_000 });
  const pendingDownload = page.waitForEvent("download");
  await account.getByRole("button", { name: "导出地址", exact: true }).click();
  const download = await pendingDownload;
  const addresses = (await readFile((await download.path())!, "utf8")).trim().split(/\r?\n/);
  await download.delete();
  expect(addresses).toHaveLength(count);
  expect(new Set(addresses.map((address) => address.toLowerCase())).size).toBe(count);
  return addresses;
}

async function openConnect(page: Page, password: string) {
  await page.goto("/connect");
  await expect(page.getByRole("button", { name: "解锁", exact: true })).toBeVisible();
  await fillSecret(page.getByPlaceholder("输入保险库密码", { exact: true }), password);
  await page.getByRole("button", { name: "解锁", exact: true }).click();
  await expect(page.getByRole("heading", { name: "连接 Nado 官网", exact: true })).toBeVisible();
}

async function setProjectId(page: Page, value: string) {
  await page.locator("summary").filter({ hasText: "WalletConnect 项目配置" }).click();
  await page.getByLabel("Project ID", { exact: true }).fill(value);
}

test("connect page stays local, uses one indexed wallet and explains missing Project ID in Chinese", async ({ page, baseURL }) => {
  const guard = await guardBrowser(page, baseURL);
  const password = `connect-test-${randomBytes(24).toString("base64url")}`;
  const addresses = await createBrowserWallets(page, password, 3);
  await openConnect(page, password);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByText("保险库共有 3 个钱包", { exact: true })).toBeVisible();
  await expect(page.getByTestId("connect-wallet-address")).toHaveText(addresses[2]!);
  await expect(page.getByTestId("connect-status")).toHaveText("尚未连接");
  await expect(page.getByRole("link", { name: "Nado 官网", exact: true })).toHaveAttribute("href", "https://app.nado.xyz/perpetuals?market=BTC");
  await expect(page.getByRole("button", { name: "下一个钱包", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "上一个钱包", exact: true }).click();
  await expect(page.getByTestId("connect-wallet-address")).toHaveText(addresses[1]!);
  await page.getByLabel(CONNECT_WALLET_LABEL).fill("3");
  await expect(page.getByTestId("connect-wallet-address")).toHaveText(addresses[2]!);
  await expect(page.getByRole("button", { name: "下一个钱包", exact: true })).toBeDisabled();
  for (const invalid of ["0", "4", "1.5"]) {
    await page.getByLabel(CONNECT_WALLET_LABEL).fill(invalid);
    await expect(page.getByText("请输入有效的钱包编号。", { exact: true })).toBeVisible();
    await expect(page.getByTestId("connect-wallet-address")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "接收官网连接请求", exact: true })).toBeDisabled();
  }
  await page.getByLabel(CONNECT_WALLET_LABEL).fill("1");
  await setProjectId(page, "");
  await expect(page.getByText("请填写自己的 32 位 Project ID 后连接。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "接收官网连接请求", exact: true })).toBeDisabled();
  await expect(page.getByRole("link", { name: "WalletConnect 控制台", exact: true })).toHaveAttribute("href", "https://dashboard.walletconnect.com");
  await page.screenshot({ path: test.info().outputPath("connect-chinese-unconfigured.png"), fullPage: true });
  expect(guard.record).toEqual({ external: 0, sockets: 0, apiWrites: 0, apiReads: 0, pageErrors: 0 });
});

test("connect page freezes wallet selection during pending initialization and can disconnect", async ({ page, baseURL }) => {
  const guard = await guardBrowser(page, baseURL, true);
  const password = `connect-busy-${randomBytes(24).toString("base64url")}`;
  try {
    const addresses = await createBrowserWallets(page, password, 3);
    await openConnect(page, password);
    await setProjectId(page, FAKE_PROJECT_ID);
    await page.getByLabel(CONNECT_WALLET_LABEL).fill("2");
    const uri = `wc:${randomBytes(32).toString("hex")}@2?relay-protocol=irn&symKey=${randomBytes(32).toString("hex")}`;
    await fillSecret(page.getByLabel("WalletConnect 连接码", { exact: true }), uri);
    await page.getByRole("button", { name: "接收官网连接请求", exact: true }).click();
    await expect(page.getByLabel(CONNECT_WALLET_LABEL)).toBeDisabled();
    await expect(page.getByRole("button", { name: "上一个钱包", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "下一个钱包", exact: true })).toBeDisabled();
    await expect(page.getByLabel("Project ID", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("WalletConnect 连接码", { exact: true })).toBeDisabled();
    await expect(page.getByTestId("connect-wallet-address")).toHaveText(addresses[1]!);
    await expect(page.getByRole("button", { name: /^(确认本次签名|确认签名并发送交易)$/ })).toHaveCount(0);
    await page.getByRole("button", { name: "断开连接", exact: true }).click();
    await expect(page.getByLabel(CONNECT_WALLET_LABEL)).toBeEnabled();
    await expect(page.getByLabel("Project ID", { exact: true })).toBeEnabled();
    await expect(page.getByTestId("connect-status")).toHaveText("尚未连接");
    await page.getByRole("button", { name: "下一个钱包", exact: true }).click();
    await expect(page.getByTestId("connect-wallet-address")).toHaveText(addresses[2]!);
    expect(guard.record.apiWrites).toBe(0);
    expect(guard.record.apiReads).toBe(0);
    expect(guard.record.pageErrors).toBe(0);
  } finally { guard.release(); }
});

test("10000 connect wallets navigate by index without a large address DOM or network initialization", async ({ page, baseURL }) => {
  test.skip(process.env.NADO_CONNECT_10000 !== "1", "Opt-in 10000-wallet local connect-page QA");
  test.setTimeout(300_000);
  const guard = await guardBrowser(page, baseURL);
  const password = `connect-large-${randomBytes(24).toString("base64url")}`;
  const started = Date.now();
  console.log(JSON.stringify({ stage: "connect-10000-deriving", count: 10000 }));
  const addresses = await createBrowserWallets(page, password, 10000);
  await openConnect(page, password);
  await expect(page.getByText("保险库共有 10,000 个钱包", { exact: true })).toBeVisible();
  await expect(page.getByLabel(CONNECT_WALLET_LABEL)).toHaveValue("10000");
  await expect(page.getByTestId("connect-wallet-address")).toHaveText(addresses[9999]!);
  await page.getByRole("button", { name: "上一个钱包", exact: true }).click();
  await expect(page.getByTestId("connect-wallet-address")).toHaveText(addresses[9998]!);
  await page.getByRole("button", { name: "下一个钱包", exact: true }).click();
  await expect(page.getByTestId("connect-wallet-address")).toHaveText(addresses[9999]!);
  await expect(page.getByTestId("connect-wallet-address")).toHaveCount(1);
  const renderedElements = await page.locator("main *").count();
  expect(renderedElements).toBeLessThan(300);
  await expect(page.getByTestId("connect-status")).toHaveText("尚未连接");
  expect(guard.record).toEqual({ external: 0, sockets: 0, apiWrites: 0, apiReads: 0, pageErrors: 0 });
  const report = { passed: true, wallets: 10000, renderedElements, elapsedMs: Date.now() - started, ...guard.record };
  await writeFile(test.info().outputPath("connect-10000-summary.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ stage: "connect-10000-complete", ...report }));
});
