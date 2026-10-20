import { describe, expect, it } from "vitest";
import { stringToHex } from "viem";
import { getUsernamePayloadHash, matchesUsernameAuthorization } from "../../../../apps/console/app/lib/nadoUsernameAuthorization";
import { validateRequest, type PreparedRequest } from "../../../../apps/console/app/lib/walletConnectPolicy";

const NOW = 1_792_500_000_000;
const ADDRESS = "0x1111111111111111111111111111111111111111";
const HASH = "0x50a1cf0cf0a6578c6b13ff65a8a042cb0313882780918cef0a12fdbbc9a5fe9c";
function fixture(): any {
  return {
    kind: "typedData", method: "eth_signTypedData_v4", address: ADDRESS, title: "irrelevant", details: "irrelevant", createdAt: NOW,
    payload: { typedData: {
      primaryType: "NadoAuthentication",
      domain: { name: "Nado", version: "0.0.1", chainId: 57073, verifyingContract: "0x05ec92D78ED421f3D3Ada77FFdE167106565974E" },
      types: { NadoAuthentication: [
        { name: "method", type: "string" }, { name: "sender", type: "bytes32" },
        { name: "payloadHash", type: "bytes32" }, { name: "nonce", type: "uint64" },
      ] },
      message: { method: "mobile:execute_set_username", sender: `${ADDRESS}64656661756c740000000000`, payloadHash: HASH, nonce: (BigInt(NOW + 30_000) * 1_000_000n + 123n).toString() },
    } },
  };
}
const domainSchema = [
  { name: "name", type: "string" }, { name: "version", type: "string" },
  { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
];
describe("strict Nado username authorization", () => {
  it("reproduces the official canonical MessagePack hash for public username ybtl6", () => {
    expect(getUsernamePayloadHash("ybtl6")).toBe(HASH);
    expect(getUsernamePayloadHash("YBTL6")).not.toBe(HASH);
    expect(matchesUsernameAuthorization(fixture(), "ybtl6", NOW)).toBe(true);
  });
  it("matches the independent 12-byte default encoding and a real policy-validated request", () => {
    const raw = fixture();
    expect(raw.payload.typedData.message.sender).toBe(ADDRESS + stringToHex("default", { size: 12 }).slice(2));
    expect(raw.payload.typedData.message.sender).toHaveLength(66);
    const prepared = validateRequest("eth_signTypedData_v4", [ADDRESS, raw.payload.typedData], ADDRESS);
    expect(matchesUsernameAuthorization(prepared, "ybtl6", NOW)).toBe(true);
  });
  it("allows the exact optional EIP712Domain schema and equivalent chain encodings", () => {
    const request = fixture(); request.payload.typedData.types.EIP712Domain = domainSchema;
    for (const chainId of [57073, "57073", "0xdef1"]) {
      request.payload.typedData.domain.chainId = chainId;
      expect(matchesUsernameAuthorization(request, "ybtl6", NOW)).toBe(true);
    }
  });
  it.each(["", "yb", "ybtl6 ", "ybtl6\n", "a".repeat(21), "钱包6"])("rejects invalid expected username %s", name => {
    expect(matchesUsernameAuthorization(fixture(), name, NOW)).toBe(false);
    expect(() => getUsernamePayloadHash(name)).toThrow();
  });
  it.each(["mobile:execute_set_bio", "mobile:execute_set_private_mode", "mobile:execute_set_follow", "link_signer", "place_order", "mobile:execute_set_username "])("rejects another operation %s", method => {
    const request = fixture(); request.payload.typedData.message.method = method;
    expect(matchesUsernameAuthorization(request, "ybtl6", NOW)).toBe(false);
  });
  it.each(["LinkSigner", "Order", "Permit", "Withdraw", "NadoAuthentication "])("never authorizes primaryType %s", type => {
    const request = fixture(); request.payload.typedData.primaryType = type;
    expect(matchesUsernameAuthorization(request, "ybtl6", NOW)).toBe(false);
  });
  it.each(["transaction", "login", "read", "switchChain"])("never authorizes request kind %s", kind => {
    const request = fixture(); request.kind = kind;
    expect(matchesUsernameAuthorization(request, "ybtl6", NOW)).toBe(false);
  });
  it("rejects hashes for any other username, wrong signer and other subaccount", () => {
    expect(matchesUsernameAuthorization(fixture(), "ybtl7", NOW)).toBe(false);
    for (const mutate of [
      (r: any) => { r.payload.typedData.message.payloadHash = `0x${"0".repeat(64)}`; },
      (r: any) => { r.address = "0x2222222222222222222222222222222222222222"; },
      (r: any) => { r.payload.typedData.message.sender = `${ADDRESS}${"0".repeat(24)}`; },
      (r: any) => { r.method = "eth_sendTransaction"; },
    ]) { const request = fixture(); mutate(request); expect(matchesUsernameAuthorization(request, "ybtl6", NOW)).toBe(false); }
  });
  it("rejects wrong domain fields, missing fields and any salt", () => {
    for (const mutate of [
      (d: any) => { d.name = "Other"; }, (d: any) => { d.version = "1"; },
      (d: any) => { d.chainId = 1; }, (d: any) => { d.verifyingContract = ADDRESS; },
      (d: any) => { delete d.chainId; }, (d: any) => { d.salt = `0x${"0".repeat(64)}`; },
    ]) { const request = fixture(); mutate(request.payload.typedData.domain); expect(matchesUsernameAuthorization(request, "ybtl6", NOW)).toBe(false); }
  });
  it("rejects altered types, reordered/extra fields, and unused extra type definitions", () => {
    for (const mutate of [
      (t: any) => { t.NadoAuthentication[3].type = "uint256"; },
      (t: any) => { t.NadoAuthentication.reverse(); },
      (t: any) => { t.NadoAuthentication.push({ name: "spender", type: "address" }); },
      (t: any) => { t.NadoAuthentication[0].extra = true; },
      (t: any) => { delete t.NadoAuthentication[1]; },
      (t: any) => { t.NadoAuthentication.extra = true; },
      (t: any) => { t.LinkSigner = []; },
      (t: any) => { t.EIP712Domain = [...domainSchema].reverse(); },
      (t: any) => { t.EIP712Domain = [...domainSchema, { name: "salt", type: "bytes32" }]; },
    ]) { const request = fixture(); mutate(request.payload.typedData.types); expect(matchesUsernameAuthorization(request, "ybtl6", NOW)).toBe(false); }
  });
  it("rejects extras at every signed data level and missing authentication fields", () => {
    for (const mutate of [
      (r: any) => { r.payload.extra = true; },
      (r: any) => { r.payload.typedData.extra = true; },
      (r: any) => { r.payload.typedData.message.spender = ADDRESS; },
      (r: any) => { r.payload.typedData.message.display_name = "ybtl6"; },
      (r: any) => { delete r.payload.typedData.message.nonce; },
    ]) { const request = fixture(); mutate(request); expect(matchesUsernameAuthorization(request, "ybtl6", NOW)).toBe(false); }
  });
  it("enforces uint64 and strictly future deadlines no more than 100 seconds ahead", () => {
    for (const offset of [-1, 0, 100_001]) {
      const request = fixture(); request.payload.typedData.message.nonce = (BigInt(NOW + offset) * 1_000_000n + 999_999n).toString();
      expect(matchesUsernameAuthorization(request, "ybtl6", NOW)).toBe(false);
    }
    for (const nonce of ["-1", "18446744073709551616", "123x", 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const request = fixture(); request.payload.typedData.message.nonce = nonce;
      expect(matchesUsernameAuthorization(request, "ybtl6", NOW)).toBe(false);
    }
    const request = fixture(); request.payload.typedData.message.nonce = (BigInt(NOW + 100_000) * 1_000_000n + 999_999n).toString();
    expect(matchesUsernameAuthorization(request, "ybtl6", NOW)).toBe(true);
  });
  it("returns false for malformed input and invalid clocks without throwing", () => {
    for (const request of [null, undefined, {}, { kind: "typedData", method: "eth_signTypedData_v4" }]) {
      expect(matchesUsernameAuthorization(request as PreparedRequest, "ybtl6", NOW)).toBe(false);
    }
    for (const now of [NaN, Infinity, -1, 1.5]) expect(matchesUsernameAuthorization(fixture(), "ybtl6", now)).toBe(false);
  });
});
