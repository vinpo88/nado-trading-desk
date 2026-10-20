import { canonicalizeMobileInner, getMobilePayloadHash, MOBILE_DISPLAY_NAME_PATTERN, subaccountToHex } from "@nadohq/client";
import type { Hex } from "viem";
import type { PreparedRequest } from "./walletConnectPolicy";

const INK_CHAIN_ID = 57073n;
const NADO_ENDPOINT = "0x05ec92d78ed421f3d3ada77ffde167106565974e";
const UINT64_MAX = (1n << 64n) - 1n;
const AUTHENTICATION_FIELDS = [
  { name: "method", type: "string" },
  { name: "sender", type: "bytes32" },
  { name: "payloadHash", type: "bytes32" },
  { name: "nonce", type: "uint64" },
] as const;
const DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function keysExactly(value: RecordValue, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every(key => typeof key === "string" && expected.includes(key));
}
function schemaEquals(value: unknown, expected: readonly { name: string; type: string }[]): boolean {
  return Array.isArray(value) && value.length === expected.length && Reflect.ownKeys(value).length === expected.length + 1
    && expected.every((definition, index) => {
      const field: unknown = value[index];
      return Object.hasOwn(value, index) && record(field) && keysExactly(field, ["name", "type"])
        && field.name === definition.name && field.type === definition.type;
    });
}
function unsignedInteger(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value !== "string" || value.length > 80 || !/^(?:0|[1-9][0-9]*|0x(?:0|[1-9a-fA-F][0-9a-fA-F]*))$/.test(value)) return null;
  return BigInt(value);
}

/** Public data only: the SDK's canonical MessagePack encoding, never JSON-string hashing. */
export function getUsernamePayloadHash(username: string): Hex {
  if (typeof username !== "string" || !MOBILE_DISPLAY_NAME_PATTERN.test(username)) {
    throw new Error("用户名不符合 Nado 的公开格式要求。");
  }
  return getMobilePayloadHash(canonicalizeMobileInner({ type: "set_username", display_name: username }));
}

/**
 * Authorizes only the explicitly chosen username for this prepared request's pinned wallet.
 * The caller must still enforce verified origin, current custody address, and explicit batch consent.
 * This predicate neither signs nor performs I/O; every malformed or unsupported request fails closed.
 */
export function matchesUsernameAuthorization(request: PreparedRequest, expectedUsername: string, now = Date.now()): boolean {
  try {
    if (!request || request.kind !== "typedData" || request.method !== "eth_signTypedData_v4") return false;
    if (!Number.isSafeInteger(now) || now < 0 || typeof request.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(request.address)) return false;
    const address = request.address.toLowerCase();
    if (address === `0x${"0".repeat(40)}`) return false;
    if (!record(request.payload) || !keysExactly(request.payload, ["typedData"])) return false;
    const data: unknown = request.payload.typedData;
    if (!record(data) || !keysExactly(data, ["primaryType", "domain", "types", "message"]) || data.primaryType !== "NadoAuthentication") return false;
    const { domain, types, message } = data;
    if (!record(domain) || !keysExactly(domain, ["name", "version", "chainId", "verifyingContract"])) return false;
    if (domain.name !== "Nado" || domain.version !== "0.0.1" || unsignedInteger(domain.chainId) !== INK_CHAIN_ID
      || typeof domain.verifyingContract !== "string" || domain.verifyingContract.toLowerCase() !== NADO_ENDPOINT) return false;
    if (!record(types)) return false;
    const withDomain = Object.hasOwn(types, "EIP712Domain");
    if (!keysExactly(types, withDomain ? ["NadoAuthentication", "EIP712Domain"] : ["NadoAuthentication"])) return false;
    if (!schemaEquals(types.NadoAuthentication, AUTHENTICATION_FIELDS) || withDomain && !schemaEquals(types.EIP712Domain, DOMAIN_FIELDS)) return false;
    if (!record(message) || !keysExactly(message, ["method", "sender", "payloadHash", "nonce"])) return false;
    const sender = subaccountToHex({ subaccountOwner: address, subaccountName: "default" });
    if (message.method !== "mobile:execute_set_username" || typeof message.sender !== "string"
      || message.sender.toLowerCase() !== sender) return false;
    if (typeof message.payloadHash !== "string" || message.payloadHash.toLowerCase() !== getUsernamePayloadHash(expectedUsername)) return false;
    const nonce = unsignedInteger(message.nonce);
    if (nonce === null || nonce > UINT64_MAX) return false;
    const deadlineMs = nonce / 1_000_000n;
    return deadlineMs > BigInt(now) && deadlineMs <= BigInt(now) + 100_000n;
  } catch {
    return false;
  }
}
