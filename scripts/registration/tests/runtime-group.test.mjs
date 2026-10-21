import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  normalizeWorkerConfig, validateWorkerGroup, withWorkerGroupLease,
  recoverWorkerGroupLocks, recoverWorkerLocks, runWorker, readPublicJson, atomicWriteJson,
  rearmWorkerGroupMember, requestWorkerStop, acceptWorkerTerms, termsCandidate, WorkerError,
} from '../runtime.mjs';
import { parseProgress } from '../cli.mjs';
import { launchDedicatedBrowser } from '../worker.mjs';

const address = number => `0x${number.toString(16).padStart(40, '0')}`;
const manifest = [1, 2, 3, 4].map(walletNumber => ({ walletNumber, address: address(walletNumber) }));
const verified = walletNumber => ({
  walletNumber, address: address(walletNumber), username: `demo${walletNumber}`,
  status: 'verified_login_and_ink', loginComplete: true, websiteSignedIn: true,
  websiteNetwork: 'Ink', approvedChainId: 57073, agentTransactionsSent: 0,
});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const terms = {
  declarations: Array.from({ length: 6 }, (_, index) => `Reviewed synthetic declaration ${index + 1}`),
  links: ['https://nado.xyz/legal-docs/terms-of-use', 'https://nado.xyz/legal-docs/privacy-policy'],
  termsUrl: 'https://nado.xyz/legal-docs/terms-of-use',
  privacyUrl: 'https://nado.xyz/legal-docs/privacy-policy',
};
function stopAfterWallet(config, dependencies) {
  return { ...dependencies, createRunner: options => {
    const runner = dependencies.createRunner(options);
    return { ...runner, runWallet: async number => {
      const record = await runner.runWallet(number);
      await requestWorkerStop(config);
      return record;
    } };
  } };
}

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
          username: `demo${number}`, saveAttempted: true });
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

test('runtime accepts six independent profiles of one browser and rejects a seventh or overlap', async t => {
  const { root } = await fixture(t);
  const configs = Array.from({ length: 7 }, (_, index) => {
    const config = normalizeWorkerConfig({
      bounds: { min: 1, max: 14 }, start: index * 2 + 1, end: index * 2 + 2,
      direction: 'asc', browser: 'chrome', profileName: `six-member-${index}`,
      walletsPath: 'wallets.json', progressPath: `six-member-${index}.ndjson`,
    }, { configPath: join(root, `six-member-${index}.json`), repoDir: root });
    config.globalLockPath = join(root, 'isolated-lock', 'worker.lock');
    return config;
  });
  const six = configs.slice(0, 6);
  assert.equal(validateWorkerGroup(six), six);
  assert.throws(() => validateWorkerGroup(configs), { code: 'CONFIG_INVALID' });
  assert.throws(() => validateWorkerGroup([...six.slice(0, 5), { ...six[5], plan: six[0].plan }]),
    { code: 'CONFIG_INVALID' });
  assert.throws(() => validateWorkerGroup([...six.slice(0, 5), { ...six[5], profileDir: six[0].profileDir }]),
    { code: 'CONFIG_INVALID' });
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

test('explicit member rearm refreshes only its ledger and isolates old control markers with a new run ID', async t => {
  const { configs, dependencies, calls, closes } = await fixture(t);
  const config = configs[0], groupRunId = randomUUID();
  await withWorkerGroupLease(configs, async lease => {
    const first = await runWorker(config, stopAfterWallet(config, dependencies[0]), { lease });
    assert.equal(first.phase, 'stopped');
    assert.equal(first.completed, 1);
    assert.equal(first.runId, groupRunId);
    const oldCandidate = termsCandidate(terms, first.runId);
    await atomicWriteJson(config.consentPath, { runId: first.runId, digest: oldCandidate.digest });
    await atomicWriteJson(config.resumePath, { runId: first.runId, requestId: randomUUID() });
    // Neither a changed manifest file nor a peer's in-progress append can
    // change the original group ownership or break this member's restart.
    await writeFile(config.walletsPath, 'not a replacement manifest');
    await writeFile(configs[1].progressPath, '{"incomplete-peer-append":');
    const nextRunId = await rearmWorkerGroupMember(config, lease, first.runId);
    assert.notEqual(nextRunId, first.runId);
    assert.equal((await readPublicJson(config.globalLockPath)).runId, groupRunId);
    await assert.rejects(rearmWorkerGroupMember(config, lease, first.runId), { code: 'CONFIRMATION_INVALID' });
    await assert.rejects(rearmWorkerGroupMember(config, lease, nextRunId), { code: 'CONFIRMATION_INVALID' });
    let termsWaits = 0;
    const second = await runWorker(config, {
      ...dependencies[0],
      createRunner: options => {
        const runner = dependencies[0].createRunner(options);
        return { ...runner,
          runWallet: (number, confirmation) => {
            if (!confirmation) throw new WorkerError('TERMS_CONFIRMATION_REQUIRED');
            return runner.runWallet(number);
          },
          readTermsCandidate: async () => terms,
        };
      },
      sleep: async () => {
        termsWaits++;
        const owner = await readPublicJson(config.profileLockPath);
        assert.equal(owner.runId, nextRunId);
        assert.equal(owner.groupRunId, groupRunId);
        const state = await readPublicJson(config.statusPath);
        assert.equal(state.phase, 'waiting_terms');
        assert.equal(state.completed, 1);
        assert.equal(state.currentWalletNumber, 2);
        assert.equal((await readPublicJson(config.stopPath)).runId, first.runId);
        assert.equal((await readPublicJson(config.resumePath)).runId, first.runId);
        await acceptWorkerTerms(config, (await readPublicJson(config.candidatePath)).digest);
      },
    }, { lease, runId: nextRunId });
    assert.equal(second.phase, 'completed');
    assert.equal(second.completed, 2);
    assert.equal(termsWaits, 1);
    await assert.rejects(rearmWorkerGroupMember(config, lease, nextRunId), { code: 'CONFIRMATION_INVALID' });
  }, { runId: groupRunId });
  assert.deepEqual(calls, [[1, 2], []]);
  assert.deepEqual(closes, [2, 0]);
  assert.deepEqual(parseProgress(await readFile(config.progressPath, 'utf8')).map(record => record.walletNumber), [1, 2]);
  assert.equal(await readPublicJson(config.globalLockPath, { optional: true }), null);
});

test('member rearm waits for the old close to finish and rejects concurrent or stale rearm', async t => {
  const { configs, dependencies } = await fixture(t);
  const config = configs[0], groupRunId = randomUUID();
  const closing = deferred(), finishClose = deferred();
  await withWorkerGroupLease(configs, async lease => {
    await assert.rejects(rearmWorkerGroupMember(config, lease, groupRunId), { code: 'CONFIRMATION_INVALID' });
    const first = runWorker(config, {
      ...stopAfterWallet(config, dependencies[0]),
      launch: async () => ({
        localPage: {}, nadoPage: {}, isClosed: () => false,
        close: async () => { closing.resolve(); await finishClose.promise; },
      }),
    }, { lease });
    await closing.promise;
    await assert.rejects(rearmWorkerGroupMember(config, lease, groupRunId), { code: 'WORKER_ALREADY_RUNNING' });
    assert.notEqual(await readPublicJson(config.profileLockPath, { optional: true }), null);
    finishClose.resolve();
    assert.equal((await first).phase, 'stopped');
    await assert.rejects(rearmWorkerGroupMember(config, lease, randomUUID()), { code: 'CONFIRMATION_INVALID' });
    await assert.rejects(rearmWorkerGroupMember(config, {}, groupRunId), { code: 'CONFIRMATION_INVALID' });
    const results = await Promise.allSettled([
      rearmWorkerGroupMember(config, lease, groupRunId),
      rearmWorkerGroupMember(config, lease, groupRunId),
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.code, 'WORKER_ALREADY_RUNNING');
    await assert.rejects(runWorker(config, dependencies[0], { lease, runId: groupRunId }), { code: 'CONFIG_INVALID' });
    assert.equal((await runWorker(config, dependencies[0], { lease, runId: results[0].value })).phase, 'completed');
  }, { runId: groupRunId });
});

test('a group callback exiting during rearm revokes the restart before releasing global ownership', async t => {
  const { configs, dependencies } = await fixture(t);
  const config = configs[0], groupRunId = randomUUID();
  let pendingRearm, usedLease;
  await withWorkerGroupLease(configs, async lease => {
    usedLease = lease;
    await runWorker(config, stopAfterWallet(config, dependencies[0]), { lease });
    pendingRearm = rearmWorkerGroupMember(config, lease, groupRunId);
    // Simulate a caller abandoning the restart while its asynchronous lock and
    // progress reads are still pending. The lease finalizer must await/revoke it.
    pendingRearm.catch(() => {});
  }, { runId: groupRunId });
  await assert.rejects(pendingRearm, { code: 'CONFIRMATION_INVALID' });
  assert.equal(await readPublicJson(config.globalLockPath, { optional: true }), null);
  assert.equal(await readPublicJson(config.profileLockPath, { optional: true }), null);
  await assert.rejects(runWorker(config, dependencies[0], { lease: usedLease }), { code: 'CONFIG_INVALID' });
});

test('member rearm refuses and preserves unresolved Save intent and leftover profile ownership', async t => {
  const { configs, dependencies } = await fixture(t);
  const config = configs[0], groupRunId = randomUUID();
  const attempt = { walletNumber: 1, address: address(1), username: 'demo1', saveAttempted: true };
  await withWorkerGroupLease(configs, async lease => {
    const state = await runWorker(config, {
      ...dependencies[0],
      createRunner: options => ({
        runWallet: async () => {
          await options.onEvent({ stage: 'save_pending', ...attempt });
          throw new WorkerError('NEEDS_ATTENTION');
        },
        cleanup: async () => {},
      }),
    }, { lease });
    assert.equal(state.phase, 'failed');
    await assert.rejects(rearmWorkerGroupMember(config, lease, groupRunId), { code: 'NEEDS_ATTENTION' });
    assert.deepEqual(await readPublicJson(config.attemptPath), attempt);
    const owner = { pid: process.pid, runId: groupRunId, token: 'synthetic-leftover-owner' };
    await atomicWriteJson(config.profileLockPath, owner);
    await assert.rejects(rearmWorkerGroupMember(config, lease, groupRunId), { code: 'WORKER_ALREADY_RUNNING' });
    assert.deepEqual(await readPublicJson(config.profileLockPath), owner);
    assert.deepEqual(await readPublicJson(config.attemptPath), attempt);
  }, { runId: groupRunId });
});

for (const failure of ['close', 'launch']) test(`unconfirmed ${failure} preserves ownership and cannot rearm a member`, async t => {
  const { configs, dependencies } = await fixture(t);
  const config = configs[0], groupRunId = randomUUID();
  await withWorkerGroupLease(configs, async lease => {
    await assert.rejects(runWorker(config, {
      ...stopAfterWallet(config, dependencies[0]),
      launch: async () => {
        if (failure === 'launch') throw new Error('Synthetic partial launch failure');
        return { localPage: {}, nadoPage: {}, isClosed: () => false,
          close: async () => { throw new Error('Synthetic close failure'); } };
      },
    }, { lease }), { code: failure === 'close' ? 'BROWSER_CLOSED' : 'BROWSER_START_FAILED' });
    await assert.rejects(rearmWorkerGroupMember(config, lease, groupRunId), { code: 'BROWSER_CLOSED' });
    assert.notEqual(await readPublicJson(config.profileLockPath, { optional: true }), null);
    await assert.rejects(runWorker(config, dependencies[0]), { code: 'WORKER_ALREADY_RUNNING' });
  }, { runId: groupRunId });
  assert.notEqual(await readPublicJson(config.profileLockPath, { optional: true }), null);
  assert.notEqual(await readPublicJson(config.globalLockPath, { optional: true }), null);
});

test('confirmed partial startup cleanup releases the profile and permits a fresh member generation', async t => {
  const { configs, dependencies, calls } = await fixture(t);
  const config = configs[0], groupRunId = randomUUID();
  let partialCloses = 0;
  await withWorkerGroupLease(configs, async lease => {
    const state = await runWorker(config, {
      ...dependencies[0],
      launch: currentConfig => launchDedicatedBrowser(currentConfig, {
        chromium: { launchPersistentContext: async () => ({
          on() {},
          grantPermissions: async () => { throw new Error('synthetic page setup failure'); },
          close: async () => { partialCloses++; },
        }) },
      }),
    }, { lease });
    assert.equal(state.phase, 'failed');
    assert.equal(state.errorCode, 'BROWSER_START_FAILED');
    assert.equal(partialCloses, 1);
    assert.deepEqual(calls[0], []);
    assert.equal(await readPublicJson(config.profileLockPath, { optional: true }), null);
    assert.equal(await readPublicJson(config.attemptPath, { optional: true }), null);
    assert.equal(await readPublicJson(config.progressPath, { optional: true }), null);
    assert.equal((await readPublicJson(config.globalLockPath)).runId, groupRunId);
    const nextRunId = await rearmWorkerGroupMember(config, lease, groupRunId);
    assert.notEqual(nextRunId, groupRunId);
    const next = await runWorker(config, dependencies[0], { lease });
    assert.equal(next.runId, nextRunId);
    assert.equal(next.phase, 'completed');
    assert.deepEqual(calls[0], [1, 2]);
  }, { runId: groupRunId });
  assert.equal(await readPublicJson(config.globalLockPath, { optional: true }), null);
});

for (const [label, error] of [
  ['false', Object.assign(new WorkerError('BROWSER_START_FAILED'), { browserCloseConfirmed: false })],
  ['missing', new WorkerError('BROWSER_START_FAILED')],
  ['string', Object.assign(new WorkerError('BROWSER_START_FAILED'), { browserCloseConfirmed: 'true' })],
  ['number', Object.assign(new WorkerError('BROWSER_START_FAILED'), { browserCloseConfirmed: 1 })],
  ['raw error', Object.assign(new Error('synthetic startup error'), { code: 'BROWSER_START_FAILED', browserCloseConfirmed: true })],
  ['wrong code', Object.assign(new WorkerError('BROWSER_CLOSED'), { browserCloseConfirmed: true })],
]) test(`untrusted startup close proof (${label}) preserves ownership and prevents rearm`, async t => {
  const { configs, dependencies } = await fixture(t);
  const config = configs[0], groupRunId = randomUUID();
  await withWorkerGroupLease(configs, async lease => {
    await assert.rejects(runWorker(config, {
      ...dependencies[0], launch: async () => { throw error; },
    }, { lease }), { code: 'BROWSER_START_FAILED' });
    await assert.rejects(rearmWorkerGroupMember(config, lease, groupRunId), { code: 'BROWSER_CLOSED' });
    assert.notEqual(await readPublicJson(config.profileLockPath, { optional: true }), null);
  }, { runId: groupRunId });
  assert.notEqual(await readPublicJson(config.globalLockPath, { optional: true }), null);
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

test('stale group recovery accepts a restarted member only when its groupRunId matches the original group', async t => {
  const { configs } = await fixture(t);
  const groupRunId = randomUUID(), memberRunId = randomUUID();
  const owner = { pid: 0, runId: groupRunId, token: 'synthetic-dead-group',
    members: configs.map(config => config.profileLockPath) };
  await mkdir(join(configs[0].repoDir, 'isolated-lock'));
  for (const config of configs) await mkdir(config.stateDir, { recursive: true });
  await atomicWriteJson(configs[0].globalLockPath, owner);
  await atomicWriteJson(configs[0].profileLockPath, { pid: 0, runId: groupRunId, token: 'legacy-owner' });
  await atomicWriteJson(configs[1].profileLockPath, {
    pid: 0, runId: memberRunId, groupRunId: randomUUID(), token: 'wrong-group',
  });
  await assert.rejects(recoverWorkerGroupLocks(configs, true), { code: 'WORKER_LOCK_STALE' });
  assert.notEqual(await readPublicJson(configs[0].globalLockPath, { optional: true }), null);
  await atomicWriteJson(configs[1].profileLockPath, {
    pid: 0, runId: groupRunId, groupRunId: null, token: 'malformed-group',
  });
  await assert.rejects(recoverWorkerGroupLocks(configs, true), { code: 'WORKER_LOCK_STALE' });
  await atomicWriteJson(configs[1].profileLockPath, {
    pid: 0, runId: memberRunId, groupRunId, token: 'restarted-member',
  });
  assert.equal((await recoverWorkerGroupLocks(configs, true)).phase, 'locks_recovered');
  for (const path of [configs[0].globalLockPath, ...owner.members]) {
    assert.equal(await readPublicJson(path, { optional: true }), null);
  }
});
