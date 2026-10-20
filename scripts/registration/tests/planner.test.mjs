import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlan,
  getStatus,
  mergeProgress,
  normalizeConfig,
  validateWalletManifest,
} from '../planner.mjs';

// Synthetic public addresses only; no private key, browser, vault, or network access.
const address = number => `0x${BigInt(number).toString(16).padStart(40, '0')}`;
const manifest = (min, max) => Array.from({ length: max - min + 1 }, (_, offset) => ({
  walletNumber: min + offset,
  address: address(min + offset),
}));
const numbers = plan => plan.items.map(item => item.walletNumber);
const verified = (walletNumber, extra = {}) => ({
  walletNumber,
  address: address(walletNumber),
  status: 'verified_login_and_ink',
  loginComplete: true,
  ...extra,
});

test('default plan includes every wallet exactly once, descending from 10000 to 1', () => {
  const wallets = manifest(1, 10000);
  const plan = createPlan({}, wallets);
  assert.deepEqual(plan.config, {
    bounds: { min: 1, max: 10000 },
    start: 10000,
    end: 1,
    direction: 'desc',
    laneCount: 1,
    laneIndex: 0,
  });
  assert.equal(plan.total, 10000);
  assert.equal(plan.completed, 0);
  assert.equal(plan.remaining, 10000);
  assert.deepEqual(numbers(plan), Array.from({ length: 10000 }, (_, index) => 10000 - index));
  assert.deepEqual(plan.items[0], { walletNumber: 10000, address: address(10000) });
  assert.deepEqual(plan.items.at(-1), { walletNumber: 1, address: address(1) });
});

test('ascending and custom bounds preserve inclusive endpoints', () => {
  const config = { bounds: { min: 5, max: 9 }, direction: 'asc' };
  const plan = createPlan(config, manifest(5, 9));
  assert.deepEqual(numbers(plan), [5, 6, 7, 8, 9]);
  assert.equal(plan.config.start, 5);
  assert.equal(plan.config.end, 9);
  assert.deepEqual(numbers(createPlan({ ...config, start: 6, end: 8 }, manifest(5, 9))), [6, 7, 8]);
  assert.deepEqual(numbers(createPlan({ bounds: { min: 7, max: 7 } }, manifest(7, 7))), [7]);
});

test('invalid bounds, contradictory ranges, and invalid lanes fail instead of silently coercing', () => {
  const invalid = [
    null, [], { unknown: true },
    { bounds: { min: 0, max: 5 } },
    { bounds: { min: 9, max: 5 } },
    { bounds: { min: 1, max: 1000001 } },
    { bounds: { min: 1.5, max: 5 } },
    { bounds: { min: 1, max: Infinity } },
    { bounds: { min: 1, max: 5, extra: 1 } },
    { start: 0 }, { end: 10001 }, { start: '10' },
    { start: 1, end: 10, direction: 'desc' },
    { start: 10, end: 1, direction: 'asc' },
    { direction: 'reverse' },
    { laneCount: 0 }, { laneCount: 1.5 }, { laneCount: 10001 },
    { laneCount: 3, laneIndex: -1 }, { laneCount: 3, laneIndex: 3 },
  ];
  for (const config of invalid) assert.throws(() => normalizeConfig(config));
});

test('lane ownership covers the whole descending range without overlap', () => {
  const wallets = manifest(1, 11);
  const config = { bounds: { min: 1, max: 11 }, start: 11, end: 2, laneCount: 3 };
  const lanes = [0, 1, 2].map(laneIndex => createPlan({ ...config, laneIndex }, wallets));
  assert.deepEqual(lanes.map(numbers), [[11, 8, 5, 2], [10, 7, 4], [9, 6, 3]]);
  const combined = lanes.flatMap(numbers);
  assert.equal(combined.length, new Set(combined).size);
  assert.deepEqual(combined.sort((a, b) => b - a), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  assert.equal(lanes.reduce((total, lane) => total + lane.total, 0), 10);
});

test('ascending lanes and empty lanes retain their original sequence offsets', () => {
  const wallets = manifest(3, 7);
  const config = { bounds: { min: 3, max: 7 }, direction: 'asc', laneCount: 2 };
  assert.deepEqual(numbers(createPlan({ ...config, laneIndex: 0 }, wallets)), [3, 5, 7]);
  assert.deepEqual(numbers(createPlan({ ...config, laneIndex: 1 }, wallets)), [4, 6]);
  const empty = createPlan({ ...config, laneCount: 10, laneIndex: 9 }, wallets);
  assert.equal(empty.total, 0);
  assert.equal(empty.completed, 0);
  assert.equal(empty.remaining, 0);
  assert.deepEqual(empty.items, []);
});

test('completion never moves another wallet into a different lane', () => {
  const wallets = manifest(1, 10);
  const config = { bounds: { min: 1, max: 10 }, laneCount: 3 };
  const records = [verified(10), verified(9), verified(7), verified(3)];
  const original = [0, 1, 2].map(laneIndex => createPlan({ ...config, laneIndex }, wallets));
  const resumed = [0, 1, 2].map(laneIndex => createPlan({ ...config, laneIndex }, wallets, records));
  assert.deepEqual(resumed.map(numbers), [[4, 1], [6], [8, 5, 2]]);
  assert.deepEqual(resumed.map(plan => plan.total), [4, 3, 3]);
  assert.deepEqual(resumed.map(plan => plan.completed), [2, 2, 0]);
  for (let lane = 0; lane < resumed.length; lane++) {
    assert.ok(numbers(resumed[lane]).every(number => numbers(original[lane]).includes(number)));
  }
});

test('every address in the requested range is mandatory, including other lanes', () => {
  const wallets = manifest(1, 8).filter(wallet => wallet.walletNumber !== 7);
  assert.throws(() => createPlan({ bounds: { min: 1, max: 8 }, laneCount: 2, laneIndex: 0 }, wallets), /7/);
  assert.doesNotThrow(() => createPlan({ bounds: { min: 1, max: 8 }, start: 6, end: 2 }, wallets));
});

test('manifest normalizes address case without changing the caller input', () => {
  const original = [{ walletNumber: 1, address: `0x${'Ab'.repeat(20)}` }];
  Object.freeze(original[0]);
  Object.freeze(original);
  assert.deepEqual(validateWalletManifest(original), [{ walletNumber: 1, address: `0x${'ab'.repeat(20)}` }]);
  assert.equal(original[0].address, `0x${'Ab'.repeat(20)}`);
});

test('manifest rejects duplicate numbers, case-insensitive duplicate addresses, and unexpected fields', () => {
  assert.throws(() => validateWalletManifest([
    { walletNumber: 1, address: address(1) }, { walletNumber: 1, address: address(2) },
  ]));
  assert.throws(() => validateWalletManifest([
    { walletNumber: 1, address: `0x${'Ab'.repeat(20)}` }, { walletNumber: 2, address: `0x${'ab'.repeat(20)}` },
  ]));
  for (const invalid of [
    [], null, [{ walletNumber: 0, address: address(1) }],
    [{ walletNumber: 1, address: '0x1234' }],
    [{ walletNumber: 1, address: address(1), privateKey: 'forbidden-field' }],
  ]) assert.throws(() => validateWalletManifest(invalid));
});

test('only exact verified status with boolean loginComplete true skips work', () => {
  const wallets = manifest(1, 6);
  const records = [
    verified(6),
    verified(5, { loginComplete: false }),
    { walletNumber: 4, address: address(4), status: 'verified_login_and_ink' },
    verified(3, { status: 'username_saved' }),
    verified(2, { status: 'verified_login' }),
  ];
  const plan = createPlan({ bounds: { min: 1, max: 6 } }, wallets, records);
  assert.deepEqual(numbers(plan), [5, 4, 3, 2, 1]);
  assert.equal(plan.completed, 1);
  assert.equal(plan.remaining, 5);
  assert.throws(() => createPlan({ bounds: { min: 1, max: 6 } }, wallets, [verified(6, { loginComplete: 'true' })]));
});

test('progress cannot substitute another address or an unlisted wallet number', () => {
  const wallets = manifest(1, 4);
  assert.throws(() => mergeProgress([[verified(2, { address: address(3) })]], wallets));
  assert.throws(() => mergeProgress([[verified(5)]], wallets));
  assert.throws(() => createPlan({ bounds: { min: 1, max: 4 } }, wallets, [verified(2, { address: address(3) })]));
});

test('verified completion beats later incomplete records, independent of merge order', () => {
  const wallets = manifest(1, 3);
  const complete = verified(2, { username: 'account2', checkedAt: '2026-01-01T00:00:00Z' });
  const incomplete = verified(2, { loginComplete: false, status: 'waiting_for_login', checkedAt: '2026-02-01T00:00:00Z' });
  const expected = mergeProgress([[complete], [incomplete]], wallets);
  assert.deepEqual(mergeProgress([[incomplete], [complete]], wallets), expected);
  assert.equal(expected[0].status, 'verified_login_and_ink');
  assert.equal(expected[0].username, 'account2');
  assert.equal(expected[0].loginComplete, true);
});

test('merged output is descending and deterministic across files, rows, and tied timestamps', () => {
  const wallets = manifest(1, 4);
  const earlier = verified(2, { loginComplete: false, status: 'waiting_for_login', checkedAt: '2026-01-01T00:00:00Z' });
  const later = verified(2, { loginComplete: false, status: 'waiting_for_username', checkedAt: '2026-01-02T00:00:00Z' });
  const tied = { ...later, status: 'waiting_for_terms' };
  const files = [[earlier, verified(1)], [later, verified(4)], [tied]];
  const merged = mergeProgress(files, wallets);
  assert.deepEqual(merged.map(record => record.walletNumber), [4, 2, 1]);
  assert.deepEqual(mergeProgress([...files].reverse().map(file => [...file].reverse()), wallets), merged);
  assert.deepEqual(mergeProgress([files.flat().reverse()], wallets), merged);
  assert.notEqual(merged.find(record => record.walletNumber === 2).checkedAt, earlier.checkedAt);
});

test('conflicting successful usernames reject regardless of order', () => {
  const wallets = manifest(1, 1);
  const first = verified(1, { username: 'first_name' });
  const second = verified(1, { username: 'second_name' });
  assert.throws(() => mergeProgress([[first], [second]], wallets), /用户名/);
  assert.throws(() => mergeProgress([[second], [first]], wallets), /用户名/);
});

test('a newer successful row without a username cannot hide conflicts between two named successes', () => {
  const wallets = manifest(1, 1);
  const first = verified(1, { username: 'first_name', checkedAt: '2026-01-01T00:00:00Z' });
  const unnamed = verified(1, { checkedAt: '2026-01-03T00:00:00Z' });
  const second = verified(1, { username: 'second_name', checkedAt: '2026-01-02T00:00:00Z' });
  for (const records of [
    [first, unnamed, second], [unnamed, first, second], [second, unnamed, first],
    [first, second, unnamed], [unnamed, second, first], [second, first, unnamed],
  ]) assert.throws(() => mergeProgress([records], wallets), /用户名/);
});

test('merging intermediate results preserves successful username conflicts across later merges', () => {
  const wallets = manifest(1, 1);
  const named = verified(1, { username: 'first_name', checkedAt: '2026-01-01T00:00:00Z' });
  const unnamed = verified(1, { checkedAt: '2026-01-03T00:00:00Z' });
  const conflicting = verified(1, { username: 'second_name', checkedAt: '2026-01-02T00:00:00Z' });
  const intermediate = mergeProgress([[named], [unnamed]], wallets);
  assert.equal(intermediate.length, 1);
  assert.throws(() => mergeProgress([intermediate, [conflicting]], wallets), /用户名/);
  assert.throws(() => mergeProgress([[conflicting], intermediate], wallets), /用户名/);
  assert.deepEqual(mergeProgress([intermediate, [named]], wallets), intermediate);
});

test('public progress rejects extra secret fields and contradictory network or transaction state', () => {
  const wallets = manifest(1, 1);
  for (const changes of [
    { privateKey: 'forbidden-field' }, { uri: 'forbidden-field' },
    { approvedChainId: 1 }, { websiteNetwork: 'Ethereum' },
    { agentTransactionsSent: 1 }, { formatVersion: 2 },
    { checkedAt: 'invalid' }, { username: 'bad name' },
  ]) assert.throws(() => mergeProgress([[verified(1, changes)]], wallets));
});

test('status equals the plan summary and contains no wallet items', () => {
  const config = { bounds: { min: 1, max: 5 }, laneCount: 2, laneIndex: 0 };
  const wallets = manifest(1, 5);
  const records = [verified(5), verified(2)];
  const { items, ...expected } = createPlan(config, wallets, records);
  assert.deepEqual(getStatus(config, wallets, records), expected);
  assert.deepEqual(numbers({ items }), [3, 1]);
  assert.equal(expected.total, 3);
  assert.equal(expected.completed, 1);
  assert.equal(expected.remaining, 2);
});
