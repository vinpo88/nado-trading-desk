import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, createPlan, getStatus } from '../planner.mjs';

const address = number => `0x${number.toString(16).padStart(40, '0')}`;
const manifest = numbers => numbers.map(walletNumber => ({ walletNumber, address: address(walletNumber) }));
const numbers = (start, end) => Array.from({ length: end - start + 1 }, (_, index) => start + index);
const verified = walletNumber => ({
  walletNumber, address: address(walletNumber), username: `demo${walletNumber}`,
  status: 'verified_login_and_ink', loginComplete: true,
});
const itemNumbers = plan => plan.items.map(item => item.walletNumber);

test('legacy range defaults and normalized shape remain compatible', () => {
  assert.deepEqual(normalizeConfig({}), {
    bounds: { min: 1, max: 10000 }, start: 10000, end: 1,
    direction: 'desc', laneCount: 1, laneIndex: 0,
  });
  assert.deepEqual(normalizeConfig({ bounds: { min: 3, max: 7 }, direction: 'asc' }), {
    bounds: { min: 3, max: 7 }, start: 3, end: 7,
    direction: 'asc', laneCount: 1, laneIndex: 0,
  });
});

test('ranges normalize without introducing a covering range or retaining mutable input arrays', () => {
  const input = { bounds: { min: 1, max: 20 }, ranges: [[2, 4], [11, 12]], direction: 'asc' };
  const config = normalizeConfig(input);
  assert.deepEqual(config, {
    bounds: { min: 1, max: 20 }, ranges: [[2, 4], [11, 12]],
    direction: 'asc', laneCount: 1, laneIndex: 0,
  });
  assert.equal(Object.hasOwn(config, 'start'), false);
  assert.equal(Object.hasOwn(config, 'end'), false);
  input.ranges[0][0] = 1;
  input.ranges.push([15, 16]);
  assert.deepEqual(config.ranges, [[2, 4], [11, 12]]);
  assert.deepEqual(normalizeConfig(config), config);
});

test('ascending and descending plans visit only their explicit ranges, including singleton ranges', () => {
  const wallets = manifest([2, 3, 4, 10, 13, 14]);
  const asc = createPlan({ ranges: [[2, 4], [10, 10], [13, 14]], direction: 'asc' }, wallets);
  assert.deepEqual(itemNumbers(asc), [2, 3, 4, 10, 13, 14]);
  assert.equal(asc.total, 6);
  const desc = createPlan({ ranges: [[14, 13], [10, 10], [4, 2]], direction: 'desc' }, wallets);
  assert.deepEqual(itemNumbers(desc), [14, 13, 10, 4, 3, 2]);
  assert.equal(desc.remaining, 6);
});

test('range schema rejects malformed, ambiguous, overlapping, unordered and out-of-bounds plans', () => {
  const invalid = [
    { ranges: undefined }, { ranges: null }, { ranges: [] }, { ranges: {} }, { ranges: new Array(1) },
    { ranges: [1, 2] }, { ranges: [[1]] }, { ranges: [[1, 2, 3]] },
    { ranges: [{ start: 1, end: 2 }] }, { ranges: [[1.5, 2]] },
    { ranges: [['1', 2]] }, { ranges: [[true, 2]] }, { ranges: [[NaN, 2]] },
    { ranges: [[1, Infinity]] }, { ranges: [[0, 2]] }, { ranges: [[1, 10001]] },
    { ranges: [[4, 3]] }, { ranges: [[1, 3], [3, 5]] },
    { ranges: [[1, 4], [2, 3]] }, { ranges: [[2, 3], [1, 4]] },
    { ranges: [[1, 2], [1, 2]] }, { ranges: [[4, 5], [1, 2]] },
    { ranges: [[1, 2]], start: 1 }, { ranges: [[1, 2]], end: 2 },
    { ranges: [[1, 2]], start: undefined }, { ranges: [[1, 2]], end: undefined },
    { ranges: [[2, 4]], bounds: { min: 3, max: 5 } },
    { ranges: [[3, 6]], bounds: { min: 3, max: 5 } },
    { ranges: [[1, 2]], walletNumbers: [1, 2] },
    { direction: 'desc', ranges: [[1, 2]] },
    { direction: 'desc', ranges: [[5, 3], [3, 1]] },
    { direction: 'desc', ranges: [[3, 2], [6, 5]] },
  ];
  for (const input of invalid) assert.throws(() => normalizeConfig({ direction: 'asc', ...input }));
  assert.deepEqual(normalizeConfig({ ranges: [[1, 2], [3, 4]], direction: 'asc' }).ranges, [[1, 2], [3, 4]]);
});

test('lanes use the cumulative range offset before skipping duplicate verified progress', () => {
  const all = [1, 2, 3, 8, 9, 10, 11];
  const wallets = manifest(all);
  const input = { ranges: [[1, 3], [8, 11]], direction: 'asc', laneCount: 3 };
  const before = [0, 1, 2].map(laneIndex => createPlan({ ...input, laneIndex }, wallets));
  assert.deepEqual(before.map(itemNumbers), [[1, 8, 11], [2, 9], [3, 10]]);
  assert.equal(new Set(before.flatMap(itemNumbers)).size, all.length);
  const progress = [verified(1), verified(9), verified(3), verified(1)];
  const after = [0, 1, 2].map(laneIndex => createPlan({ ...input, laneIndex }, wallets, progress));
  assert.deepEqual(after.map(itemNumbers), [[8, 11], [2], [10]]);
  assert.deepEqual(after.map(plan => plan.total), [3, 2, 2]);
  assert.deepEqual(after.map(plan => plan.completed), [1, 1, 1]);
  assert.deepEqual(after.map(plan => plan.remaining), [2, 1, 1]);
});

test('gaps may be absent from the manifest but every explicitly planned wallet must exist', () => {
  const config = { ranges: [[1, 2], [8, 9]], direction: 'asc' };
  assert.deepEqual(itemNumbers(createPlan(config, manifest([1, 2, 8, 9]))), [1, 2, 8, 9]);
  assert.throws(() => createPlan(config, manifest([1, 2, 9])), /编号 8/);
  assert.throws(() => createPlan({ ...config, laneCount: 2, laneIndex: 0 }, manifest([1, 8, 9])), /编号 2/);
});

test('unverified records remain pending and status preserves the explicit range configuration', () => {
  const config = { ranges: [[1, 2], [5, 6]], direction: 'asc' };
  const wallets = manifest([1, 2, 5, 6]);
  const records = [verified(1), { ...verified(2), loginComplete: false }, { ...verified(5), status: 'pending' }];
  const plan = createPlan(config, wallets, records);
  assert.deepEqual(itemNumbers(plan), [2, 5, 6]);
  const status = getStatus(config, wallets, records);
  assert.equal(Object.hasOwn(status, 'items'), false);
  assert.deepEqual(status.config.ranges, config.ranges);
  assert.deepEqual([status.total, status.completed, status.remaining], [4, 1, 3]);
});

test('six synthetic multi-range assignments cover every runnable wallet exactly once', () => {
  const assignments = [
    [[2, 5]],
    [[6, 7], [12, 13]],
    [[14, 17]],
    [[18, 21]],
    [[22, 25]],
    [[26, 29]],
  ];
  const expected = [...numbers(2, 7), ...numbers(12, 29)];
  const wallets = manifest([...expected, 1, 11]);
  const plans = assignments.map(ranges => createPlan({ bounds: { min: 1, max: 30 }, ranges, direction: 'asc' }, wallets));
  assert.deepEqual(plans.map(plan => plan.remaining), Array(6).fill(4));
  const actual = plans.flatMap(itemNumbers);
  assert.equal(actual.length, 24);
  assert.equal(new Set(actual).size, 24);
  assert.deepEqual(actual.toSorted((a, b) => a - b), expected);
  assert.equal(actual.includes(1), false);
  assert.equal(actual.includes(11), false);
  assert.equal(actual.some(number => number >= 8 && number <= 11), false);
  const resumed = assignments.map(ranges => createPlan({ bounds: { min: 1, max: 30 }, ranges, direction: 'asc' }, wallets,
    [verified(2), verified(6), verified(6), verified(29)]));
  assert.deepEqual(resumed.map(plan => plan.remaining), [3, 3, 4, 4, 4, 3]);
  assert.equal(resumed.reduce((sum, plan) => sum + plan.completed, 0), 3);
});
