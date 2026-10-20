import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  normalizeWorkerConfig, validateWorkerGroup, withWorkerGroupLease,
  recoverWorkerGroupLocks, recoverWorkerLocks, runWorker, readPublicJson, atomicWriteJson,
} from '../runtime.mjs';
import { parseProgress } from '../cli.mjs';

const address = number => `0x${number.toString(16).padStart(40, '0')}`;
const manifest = [1, 2, 3, 4].map(walletNumber => ({ walletNumber, address: address(walletNumber) }));
const verified = walletNumber => ({
  walletNumber, address: address(walletNumber), username: `ybtl${walletNumber}`,
  status: 'verified_login_and_ink', loginComplete: true, websiteSignedIn: true,
  websiteNetwork: 'Ink', approvedChainId: 57073, agentTransactionsSent: 0,
});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nado-group-runtime-test-'));
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(root));
    assert.equal(isAbsolute(rel) || rel.startsWith('..'), false);
    assert.match(rel, /^nado-group-runtime-test-[^/\\]+$/);
    await rm(root, { recursive: true, force: true });
  });
  const configs = ['edge', 'chrome'].map((browser, index) => {
    const config = normalizeWorkerConfig({
      bounds: { min: 1, max: 4 }, start: index ? 3 : 1, end: index ? 4 : 2,
      direction: 'asc', browser, profileName: `fixture-${browser}`,
      walletsPath: 'wallets.json', progressPath: `${browser}.ndjson`,
      progressPaths: ['history.ndjson'], pollIntervalMs: 50,
    }, { configPath: join(root, `${browser}.json`), repoDir: root });
    // Always override the real OS-user lock before calling any runtime operation.
    config.globalLockPath = join(root, 'isolated-lock', 'worker.lock');
    return config;
  });
  await writeFile(configs[0].walletsPath, JSON.stringify(manifest));
  await writeFile(join(root, 'history.ndjson'), '');
  const calls = [[], []];
  const closes = [0, 0];
  const dependencies = configs.map((config, index) => ({
    launch: async () => {
      assert.notEqual(await readPublicJson(config.globalLockPath, { optional: true }), null);
      return { localPage: {}, nadoPage: {}, isClosed: () => false, close: async () => { closes[index]++; } };
    },
    createRunner: options => ({
      runWallet: async number => {
        assert.deepEqual(options.walletManifest, manifest);
        calls[index].push(number);
        await options.onEvent({ stage: 'save_pending', walletNumber: number, address: address(number),
          username: `ybtl${number}`, saveAttempted: true });
        const attempt = await readPublicJson(config.attemptPath);
        assert.equal(attempt.walletNumber, number);
        assert.equal(attempt.address, address(number));
        return verified(number);
      },
      cleanup: async () => {},
    }),
  }));
  return { root, configs, calls, closes, dependencies };
}

test('group validates non-overlapping ranges and refuses profile or output reuse', async t => {
  const { configs } = await fixture(t);
  assert.equal(validateWorkerGroup(configs), configs);
  for (const patch of [
    { plan: configs[0].plan },
    { profileDir: configs[0].profileDir },
    { stateDir: configs[0].stateDir },
    { progressPath: configs[0].progressPath },
    { walletsPath: join(configs[1].repoDir, 'different.json') },
  ]) assert.throws(() => validateWorkerGroup([configs[0], { ...configs[1], ...patch }]), { code: 'CONFIG_INVALID' });
  const sharded = configs.map((config, laneIndex) => ({ ...config, plan: {
    bounds: { min: 1, max: 4 }, start: 4, end: 1, direction: 'desc', laneCount: 2, laneIndex,
  } }));
  assert.equal(validateWorkerGroup(sharded), sharded);
});

test('group public files cannot overlap another member private state or profile directory', async t => {
  const { configs } = await fixture(t);
  for (const privatePath of [configs[1].statusPath, configs[1].attemptPath, join(configs[1].profileDir, 'data.json')]) {
    for (const patch of [{ progressPath: privatePath }, { progressPaths: [...configs[0].progressPaths, privatePath] }]) {
      assert.throws(() => validateWorkerGroup([{ ...configs[0], ...patch }, configs[1]]), { code: 'CONFIG_INVALID' });
    }
  }
});

test('group snapshots public inputs before either browser runs and preserves separate attempts and outputs', async t => {
  const { root, configs, dependencies, calls, closes } = await fixture(t);
  await writeFile(configs[0].progressPath, JSON.stringify(verified(2)) + '\n');
  const runId = randomUUID();
  let usedLease;
  await withWorkerGroupLease(configs, async lease => {
    usedLease = lease;
    // Changes after the snapshot must not reshuffle either member's ownership.
    await writeFile(configs[0].walletsPath, 'not a new valid manifest');
    await writeFile(join(root, 'history.ndjson'), JSON.stringify(verified(3)) + '\n');
    const states = await Promise.all(configs.map((config, index) => runWorker(config, dependencies[index], { lease, runId })));
    assert.deepEqual(states.map(state => state.phase), ['completed', 'completed']);
    assert.equal((await readPublicJson(configs[0].globalLockPath)).runId, runId);
    await assert.rejects(runWorker(configs[0], dependencies[0], { lease, runId }), { code: 'CONFIG_INVALID' });
  }, { runId });
  assert.deepEqual(calls, [[1], [3, 4]]);
  assert.deepEqual(closes, [1, 1]);
  assert.deepEqual(parseProgress(await readFile(configs[0].progressPath, 'utf8')).map(record => record.walletNumber), [2, 1]);
  assert.deepEqual(parseProgress(await readFile(configs[1].progressPath, 'utf8')).map(record => record.walletNumber), [3, 4]);
  for (const config of configs) {
    assert.equal(await readPublicJson(config.profileLockPath, { optional: true }), null);
    assert.equal(await readPublicJson(config.attemptPath, { optional: true }), null);
  }
  assert.equal(await readPublicJson(configs[0].globalLockPath, { optional: true }), null);
  await assert.rejects(runWorker(configs[0], dependencies[0], { lease: usedLease, runId }), { code: 'CONFIG_INVALID' });
});

test('a group blocks standalone execution and recovery while its global owner is alive', async t => {
  const { configs, dependencies, calls } = await fixture(t);
  await withWorkerGroupLease(configs, async () => {
    await assert.rejects(runWorker(configs[0], dependencies[0]), { code: 'WORKER_ALREADY_RUNNING' });
    await assert.rejects(recoverWorkerGroupLocks(configs, true), { code: 'WORKER_ALREADY_RUNNING' });
    assert.notEqual(await readPublicJson(configs[0].globalLockPath, { optional: true }), null);
  });
  assert.deepEqual(calls, [[], []]);
});

test('public input failure and callback failure both release the group global lock', async t => {
  const { configs } = await fixture(t);
  await writeFile(configs[0].walletsPath, '{}');
  await assert.rejects(withWorkerGroupLease(configs, () => assert.fail('invalid snapshot must not start')), { code: 'PUBLIC_FILE_INVALID' });
  assert.equal(await readPublicJson(configs[0].globalLockPath, { optional: true }), null);
  await writeFile(configs[0].walletsPath, JSON.stringify(manifest));
  const expected = new Error('synthetic group callback failure');
  await assert.rejects(withWorkerGroupLease(configs, () => { throw expected; }), error => error === expected);
  assert.equal(await readPublicJson(configs[0].globalLockPath, { optional: true }), null);
});

test('forged leases and setup mode cannot bypass the global worker lock', async t => {
  const { configs, dependencies } = await fixture(t);
  await assert.rejects(runWorker(configs[0], dependencies[0], { lease: {} }), { code: 'CONFIG_INVALID' });
  await withWorkerGroupLease(configs, async lease => {
    await assert.rejects(runWorker(configs[0], dependencies[0], { lease, setup: true }), { code: 'CONFIG_INVALID' });
  });
});

test('leased workers inherit the group run ID and reject a conflicting run ID before launch', async t => {
  const { configs, dependencies, calls } = await fixture(t);
  const runId = randomUUID();
  await withWorkerGroupLease(configs, async lease => {
    await assert.rejects(runWorker(configs[0], dependencies[0], { lease, runId: randomUUID() }), { code: 'CONFIG_INVALID' });
    assert.deepEqual(calls, [[], []]);
    const state = await runWorker(configs[0], dependencies[0], { lease });
    assert.equal(state.runId, runId);
    assert.equal(state.phase, 'completed');
  }, { runId });
});

test('early callback failure retains the global lease until an active browser closes', { timeout: 3000 }, async t => {
  const { configs } = await fixture(t);
  const entered = deferred();
  const finishWallet = deferred();
  const closing = deferred();
  const finishClose = deferred();
  const callbackExiting = deferred();
  const expected = new Error('synthetic early callback exit');
  let member;
  const task = withWorkerGroupLease(configs, async lease => {
    member = runWorker(configs[0], {
      launch: async () => ({
        localPage: {}, nadoPage: {}, isClosed: () => false,
        close: async () => { closing.resolve(); await finishClose.promise; },
      }),
      createRunner: () => ({
        runWallet: async number => { entered.resolve(); await finishWallet.promise; return verified(number); },
        cleanup: async () => {},
      }),
    }, { lease });
    member.catch(() => {});
    await entered.promise;
    callbackExiting.resolve();
    throw expected;
  });
  const rejected = assert.rejects(task, error => error === expected);
  await callbackExiting.promise;
  assert.notEqual(await readPublicJson(configs[0].globalLockPath, { optional: true }), null);
  finishWallet.resolve();
  await closing.promise;
  assert.notEqual(await readPublicJson(configs[0].globalLockPath, { optional: true }), null);
  finishClose.resolve();
  await rejected;
  assert.equal((await member).phase, 'completed');
  assert.equal(await readPublicJson(configs[0].globalLockPath, { optional: true }), null);
});

test('recovery requires confirmation and exact stale group membership and run IDs', async t => {
  const { configs } = await fixture(t);
  const runId = randomUUID();
  const members = configs.map(config => config.profileLockPath);
  const owner = { pid: 0, runId, token: 'synthetic-dead-owner', members };
  await mkdir(join(configs[0].repoDir, 'isolated-lock'));
  for (const config of configs) await mkdir(config.stateDir, { recursive: true });
  await atomicWriteJson(configs[0].globalLockPath, owner);
  for (const config of configs) await atomicWriteJson(config.profileLockPath, { pid: 0, runId, token: config.profileName });
  await assert.rejects(recoverWorkerGroupLocks(configs, false), { code: 'CONFIRMATION_INVALID' });
  await assert.rejects(recoverWorkerLocks(configs[0], true), { code: 'WORKER_LOCK_STALE' });
  assert.deepEqual((await readPublicJson(configs[0].globalLockPath)).members, members);
  await atomicWriteJson(configs[0].globalLockPath, { ...owner, members: members.slice(0, 1) });
  await assert.rejects(recoverWorkerGroupLocks(configs, true), { code: 'WORKER_LOCK_STALE' });
  await atomicWriteJson(configs[0].globalLockPath, owner);
  await atomicWriteJson(configs[1].profileLockPath, { pid: 0, runId: randomUUID(), token: 'wrong-run' });
  await assert.rejects(recoverWorkerGroupLocks(configs, true), { code: 'WORKER_LOCK_STALE' });
  await atomicWriteJson(configs[1].profileLockPath, { pid: 0, runId, token: 'same-run' });
  assert.equal((await recoverWorkerGroupLocks(configs, true)).phase, 'locks_recovered');
  for (const path of [configs[0].globalLockPath, ...members]) assert.equal(await readPublicJson(path, { optional: true }), null);
});
