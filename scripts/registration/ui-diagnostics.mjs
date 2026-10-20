// Only these fixed public classifications may leave the UI runner.
// Never retain raw DOM text, URLs, request payloads, or exception messages.
const ENUMS = {
  siteStage: new Set([
    'unknown', 'terms', 'introduction', 'username', 'username_ready',
    'username_conflict', 'username_checking', 'complete', 'pairing',
    'login_methods', 'signed_out', 'connected_unnamed', 'unavailable',
  ]),
  localStatus: new Set([
    'idle', 'connecting', 'proposal', 'connected', 'request', 'executing',
    'preparing', 'disconnected', 'error', 'unknown', 'unavailable',
  ]),
  fault: new Set(['ui_timeout', 'ui_state', 'origin_mismatch', 'aborted']),
  disconnectReason: new Set(['pair_timeout', 'pair_failed', 'proposal_expired', 'unknown']),
};
const BOOLEANS = [
  'walletMatches', 'usernameMatches', 'authorizationArmed', 'siteProfileMatches',
];

function ownDataValue(raw, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function sanitizeUiObservation(raw) {
  const result = {};
  if (raw === null || typeof raw !== 'object') return result;
  try {
    if (Array.isArray(raw)) return result;
  } catch {
    return result;
  }
  for (const [key, allowed] of Object.entries(ENUMS)) {
    const value = ownDataValue(raw, key);
    if (typeof value === 'string' && allowed.has(value)) result[key] = value;
  }
  for (const key of BOOLEANS) {
    const value = ownDataValue(raw, key);
    if (typeof value === 'boolean') result[key] = value;
  }
  return result;
}
