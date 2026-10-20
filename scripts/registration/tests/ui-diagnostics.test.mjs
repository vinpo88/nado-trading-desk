import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeUiObservation } from '../ui-diagnostics.mjs';

test('preserves every explicitly allowed classification', () => {
  const fields = {
    siteStage: [
      'unknown', 'terms', 'introduction', 'username', 'username_ready',
      'username_conflict', 'username_checking', 'complete', 'pairing',
      'login_methods', 'signed_out', 'connected_unnamed', 'unavailable',
    ],
    localStatus: [
      'idle', 'connecting', 'proposal', 'connected', 'request', 'executing',
      'preparing', 'disconnected', 'error', 'unknown', 'unavailable',
    ],
    fault: ['ui_timeout', 'ui_state', 'origin_mismatch', 'aborted'],
    disconnectReason: ['pair_timeout', 'pair_failed', 'proposal_expired', 'unknown'],
  };
  for (const [key, values] of Object.entries(fields)) {
    for (const value of values) assert.deepEqual(sanitizeUiObservation({ [key]: value }), { [key]: value });
  }
});

test('preserves only exact booleans, including false', () => {
  const expected = {
    walletMatches: true, usernameMatches: false,
    authorizationArmed: false, siteProfileMatches: true,
  };
  assert.deepEqual(sanitizeUiObservation(expected), expected);
  for (const value of ['true', 'false', 0, 1, null, {}, new Boolean(false)]) {
    assert.deepEqual(sanitizeUiObservation({
      walletMatches: value, usernameMatches: value,
      authorizationArmed: value, siteProfileMatches: value,
    }), {});
  }
});

test('discards raw secrets and unknown fields without retaining any nested data', () => {
  const secret = 'SYNTHETIC_PRIVATE_SENTINEL';
  const raw = {
    siteStage: 'pairing', localStatus: 'idle', fault: 'ui_timeout',
    walletMatches: true, authorizationArmed: false,
    uri: `wc:fixture@2?symKey=${secret}`, message: secret,
    stack: secret, password: secret, mnemonic: secret, privateKey: secret,
    address: secret, username: secret, url: `https://example.invalid/${secret}`,
    details: { siteStage: 'terms', raw: secret }, children: [secret],
  };
  const result = sanitizeUiObservation(raw);
  assert.deepEqual(result, {
    siteStage: 'pairing', localStatus: 'idle', fault: 'ui_timeout',
    walletMatches: true, authorizationArmed: false,
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(raw.password, secret);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
});

test('unknown enum values and coercible objects are not accepted', () => {
  for (const value of ['PRIVATE_SENTINEL', 'Terms', 'terms ', ' connected', '', 1, true, [], {}, new String('terms')]) {
    assert.deepEqual(sanitizeUiObservation({ siteStage: value, localStatus: value, fault: value, disconnectReason: value }), {});
  }
  assert.deepEqual(sanitizeUiObservation({ siteStage: 'connected', localStatus: 'terms', fault: 'unknown' }), {});
});

test('invalid inputs return a fresh plain empty object', () => {
  for (const raw of [null, undefined, '', 'PRIVATE_SENTINEL', 0, true, [], () => {}]) {
    const result = sanitizeUiObservation(raw);
    assert.deepEqual(result, {});
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
  }
  assert.notEqual(sanitizeUiObservation(null), sanitizeUiObservation(null));
});

test('ignores inherited fields and getters without executing them', () => {
  let getterCalls = 0;
  const raw = Object.create({ localStatus: 'connected', walletMatches: true });
  Object.defineProperty(raw, 'siteStage', { get() { getterCalls++; throw new Error('PRIVATE_SENTINEL'); } });
  Object.defineProperty(raw, 'fault', { value: 'ui_state' });
  assert.deepEqual(sanitizeUiObservation(raw), { fault: 'ui_state' });
  assert.equal(getterCalls, 0);
});

test('descriptor failures and prototype-looking input do not escape into the output', () => {
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('PRIVATE_SENTINEL'); } });
  assert.deepEqual(sanitizeUiObservation(hostile), {});
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.deepEqual(sanitizeUiObservation(revoked.proxy), {});
  const raw = JSON.parse('{"__proto__":{"privateKey":"PRIVATE_SENTINEL"},"constructor":"PRIVATE_SENTINEL","siteStage":"terms"}');
  const result = sanitizeUiObservation(raw);
  assert.deepEqual(result, { siteStage: 'terms' });
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.deepEqual(sanitizeUiObservation(result), result);
});
