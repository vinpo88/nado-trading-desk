import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  normalizeWorkerConfig, validateWorkerGroup, validateAttemptIsolation,
  withWorkerGroupLease, rearmWorkerGroupMember, runWorker, requestWorkerStop,
  readPublicJson, workerStatus, WorkerError,
} from '../runtime.mjs';
import { parseProgress } from '../cli.mjs';

const address = number => `0x${number.toString(16).padStart(40, '0')}`;
const manifest = Array.from({ length: 8 }, (_, index) => ({ walletNumber: index + 1, address: address(index + 1) }));
const journal = walletNumber => ({ walletNumber, address: address(walletNumber), username: `demo${walletNumber}`, saveAttempted: true });
const verified = walletNumber => ({
  walletNumber, address: address(walletNumber), username: `demo${walletNumber}`,
  status: 'verified_login_and_ink', loginComplete: true, websiteSignedIn: true,
  websiteNetwork: 'Ink', approvedChainId: 57073, agentTransactionsSent: 0,
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nado-deferred-runtime-test-'));
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(root));
    assert.equal(isAbsolute(rel) || rel.startsWith('..'), false);
    assert.match(rel, /^nado-deferred-runtime-test-[^/\\]+$/);
    await rm(root, { recursive: true, force: true });
  });
  const makeConfig = (profileName, start, end = start, deferredAttemptWalletNumber) => {
    const config = normalizeWorkerConfig({
      bounds: { min: 1, max: 8 }, start, end, direction: 'asc',
      browser: 'chromium', profileName, walletsPath: 'wallets.json',
      progressPath: `${profileName}.ndjson`, progressPaths: ['history.ndjson'], pollIntervalMs: 50,
      ...(deferredAttemptWalletNumber === undefined ? {} : { deferredAttemptWalletNumber }),
    }, { configPath: join(root, `${profileName}.json`), repoDir: root });
    // No test may acquire the real user's registration lock.
    config.globalLockPath = join(root, 'isolated-global', 'worker.lock');
    return config;
  };
  const config = makeConfig('deferred-owner', 2, 3, 1);
  const peer = makeConfig('healthy-peer', 4, 5);
  const oldBytes = Buffer.from('\ufeff' + JSON.stringify(journal(1), null, '\t').replaceAll('\n', '\r\n') + '\r\n', 'utf8');
  await mkdir(config.stateDir, { recursive: true });
  await writeFile(config.walletsPath, JSON.stringify(manifest));
  await writeFile(join(root, 'history.ndjson'), '');
  await writeFile(config.deferredAttemptPath, oldBytes);
  const assertOldUntouched = async () => assert.deepEqual(await readFile(config.deferredAttemptPath), oldBytes);
  return { root, config, peer, makeConfig, oldBytes, assertOldUntouched };
}

function fakeDependencies(config, { afterSave, resumeResult = true, beforeSave } = {}) {
  const events = { launches: 0, closes: 0, calls: [], saves: [], resumeAttempts: [] };
  const deps = {
    launch: async () => {
      events.launches++;
      return { localPage: {}, nadoPage: {}, isClosed: () => false, close: async () => { events.closes++; } };
    },
    createRunner: options => {
      events.resumeAttempts.push(options.resumeAttempt);
      return {
        runWallet: async number => {
          events.calls.push(number);
          if (options.resumeAttempt) {
            // Model the runner's existing verification-only journal branch:
            // returning a result requires the same wallet and no new Save event.
            assert.deepEqual(options.resumeAttempt, journal(number));
            if (!resumeResult) throw new WorkerError('NEEDS_ATTENTION');
            return verified(number);
          }
          await beforeSave?.(number);
          await options.onEvent({ stage: 'save_pending', ...journal(number) });
          assert.deepEqual(await readPublicJson(config.attemptPath), journal(number));
          events.saves.push(number);
          await afterSave?.(number);
          return verified(number);
        },
        cleanup: async () => {},
      };
    },
    // A regression in the setup guard must fail assertions, not hang the test.
    sleep: async () => { await requestWorkerStop(config); },
  };
  return { deps, events };
}

async function assertLocksReleased(config) {
  assert.equal(await readPublicJson(config.profileLockPath, { optional: true }), null);
  assert.equal(await readPublicJson(config.globalLockPath, { optional: true }), null);
}

function reorderedJournal() {
  const value = journal(1);
  // Still schema-valid, but different from the exact object fingerprint leased.
  return { saveAttempted: value.saveAttempted, username: value.username, address: value.address, walletNumber: value.walletNumber };
}

test('deferred original bytes survive new Saves; only active journals are removed and deferred wallet is not completed', async t => {
  const f = await fixture(t);
  assert.equal(f.config.deferredAttemptPath, join(f.config.stateDir, 'attempt.json'));
  assert.equal(f.config.attemptPath, join(f.config.stateDir, 'active-attempt.json'));
  const { deps, events } = fakeDependencies(f.config, { afterSave: f.assertOldUntouched });
  const result = await runWorker(f.config, deps);
  assert.equal(result.phase, 'completed');
  assert.deepEqual([result.total, result.completed, result.remaining], [2, 2, 0]);
  assert.equal(result.deferredAttemptWalletNumber, 1);
  assert.deepEqual(events.calls, [2, 3]);
  assert.deepEqual(events.saves, [2, 3]);
  assert.deepEqual(events.resumeAttempts, [undefined]);
  assert.equal(await readPublicJson(f.config.attemptPath, { optional: true }), null);
  assert.deepEqual(parseProgress(await readFile(f.config.progressPath, 'utf8')).map(row => row.walletNumber), [2, 3]);
  await f.assertOldUntouched();
  assert.equal((await workerStatus(f.config)).deferredAttemptWalletNumber, 1);
  await assertLocksReleased(f.config);
});

test('a new unresolved active Save survives failure and rearm refusal; later verification receives the exact journal without another Save', async t => {
  const f = await fixture(t);
  const failed = fakeDependencies(f.config, { afterSave: async () => { throw new WorkerError('NEEDS_ATTENTION'); } });
  const groupRunId = randomUUID();
  await withWorkerGroupLease([f.config, f.peer], async lease => {
    const state = await runWorker(f.config, failed.deps, { lease });
    assert.equal(state.phase, 'failed');
    assert.equal(state.errorCode, 'NEEDS_ATTENTION');
    assert.deepEqual(await readPublicJson(f.config.attemptPath), journal(2));
    await assert.rejects(rearmWorkerGroupMember(f.config, lease, groupRunId), { code: 'NEEDS_ATTENTION' });
    await f.assertOldUntouched();
  }, { runId: groupRunId });
  assert.equal(await readPublicJson(f.config.progressPath, { optional: true }), null);
  assert.deepEqual(failed.events.saves, [2]);
  // Stop immediately after the recovered wallet, keeping this fixture's fake
  // verification branch scoped to one journal and one wallet.
  const resumed = fakeDependencies(f.config);
  const createRunner = resumed.deps.createRunner;
  resumed.deps.createRunner = options => {
    const runner = createRunner(options);
    return { ...runner, runWallet: async number => {
      const record = await runner.runWallet(number);
      await requestWorkerStop(f.config);
      return record;
    } };
  };
  const state = await runWorker(f.config, resumed.deps);
  assert.equal(state.phase, 'stopped');
  assert.deepEqual(resumed.events.calls, [2]);
  assert.deepEqual(resumed.events.saves, []);
  assert.deepEqual(resumed.events.resumeAttempts, [journal(2)]);
  assert.deepEqual(parseProgress(await readFile(f.config.progressPath, 'utf8')).map(row => row.walletNumber), [2]);
  assert.equal(await readPublicJson(f.config.attemptPath, { optional: true }), null);
  await f.assertOldUntouched();
  await assertLocksReleased(f.config);
});

test('an unverifiable active Save remains pending across another run, preserving both journals', async t => {
  const f = await fixture(t);
  const activeBytes = Buffer.from(JSON.stringify(journal(2), null, 2) + '\n');
  await writeFile(f.config.attemptPath, activeBytes);
  const { deps, events } = fakeDependencies(f.config, { resumeResult: false });
  const result = await runWorker(f.config, deps);
  assert.equal(result.errorCode, 'NEEDS_ATTENTION');
  assert.deepEqual(events.calls, [2]);
  assert.deepEqual(events.saves, []);
  assert.deepEqual(await readFile(f.config.attemptPath), activeBytes);
  assert.equal(await readPublicJson(f.config.progressPath, { optional: true }), null);
  await f.assertOldUntouched();
  await assertLocksReleased(f.config);
});

for (const [label, replacement, code] of [
  ['missing', null, 'PUBLIC_FILE_INVALID'],
  ['wrong wallet', journal(6), 'RECORD_INVALID'],
  ['wrong address', { ...journal(1), address: address(6) }, 'RECORD_INVALID'],
  ['wrong username', { ...journal(1), username: 'other1' }, 'RECORD_INVALID'],
  ['not a Save', { ...journal(1), saveAttempted: false }, 'RECORD_INVALID'],
]) test(`invalid deferred record (${label}) rejects both standalone startup and whole-group lease before any browser`, async t => {
  const f = await fixture(t);
  if (replacement === null) await unlink(f.config.deferredAttemptPath);
  else await writeFile(f.config.deferredAttemptPath, JSON.stringify(replacement));
  const { deps, events } = fakeDependencies(f.config);
  const result = await runWorker(f.config, deps);
  assert.equal(result.phase, 'failed');
  assert.equal(result.errorCode, code);
  assert.equal(events.launches, 0);
  let entered = false;
  await assert.rejects(withWorkerGroupLease([f.config, f.peer], async () => { entered = true; }), { code });
  assert.equal(entered, false);
  await assertLocksReleased(f.config);
});

for (const change of ['removed', 'changed']) test(`deferred journal ${change} after leasing prevents member startup`, async t => {
  const f = await fixture(t);
  const { deps, events } = fakeDependencies(f.config);
  await withWorkerGroupLease([f.config, f.peer], async lease => {
    if (change === 'removed') await unlink(f.config.deferredAttemptPath);
    else await writeFile(f.config.deferredAttemptPath, JSON.stringify(reorderedJournal()));
    const result = await runWorker(f.config, deps, { lease });
    assert.equal(result.errorCode, change === 'removed' ? 'PUBLIC_FILE_INVALID' : 'RECORD_INVALID');
    assert.equal(events.launches, 0);
    assert.equal(await readPublicJson(f.config.attemptPath, { optional: true }), null);
  });
  await assertLocksReleased(f.config);
});

test('deferred journal mutation before a new Save event prevents the active intent and submission', async t => {
  const f = await fixture(t);
  const { deps, events } = fakeDependencies(f.config, {
    beforeSave: async () => writeFile(f.config.deferredAttemptPath, JSON.stringify(reorderedJournal())),
  });
  const result = await runWorker(f.config, deps);
  assert.equal(result.errorCode, 'RECORD_INVALID');
  assert.deepEqual(events.calls, [2]);
  assert.deepEqual(events.saves, []);
  assert.equal(await readPublicJson(f.config.attemptPath, { optional: true }), null);
  assert.equal(await readPublicJson(f.config.progressPath, { optional: true }), null);
  await assertLocksReleased(f.config);
});

for (const mode of ['normal', 'empty-plan', 'setup']) test(`removing defer configuration cannot hide an active journal in ${mode}`, async t => {
  const f = await fixture(t);
  const activeBytes = Buffer.from(JSON.stringify(journal(2)) + '\n');
  await writeFile(f.config.attemptPath, activeBytes);
  const reverted = f.makeConfig(f.config.profileName, 2, 3);
  if (mode === 'empty-plan') await writeFile(reverted.progressPath, [verified(2), verified(3)].map(JSON.stringify).join('\n') + '\n');
  const { deps, events } = fakeDependencies(reverted);
  const result = await runWorker(reverted, deps, { setup: mode === 'setup' });
  assert.equal(result.errorCode, 'NEEDS_ATTENTION');
  assert.equal(events.launches, 0);
  assert.deepEqual(await readFile(f.config.attemptPath), activeBytes);
  await f.assertOldUntouched();
  await assertLocksReleased(reverted);
});

test('six-member group cannot assign another profile the deferred wallet even when history claims completion', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'history.ndjson'), JSON.stringify(verified(1)) + '\n');
  const configs = [f.config, f.makeConfig('wrong-owner', 1),
    ...[4, 5, 6, 7].map(number => f.makeConfig(`other-${number}`, number))];
  assert.throws(() => validateWorkerGroup(configs), { code: 'CONFIG_INVALID' });
  let entered = false;
  await assert.rejects(withWorkerGroupLease(configs, async () => { entered = true; }), { code: 'CONFIG_INVALID' });
  assert.equal(entered, false);
  await f.assertOldUntouched();
  await assertLocksReleased(f.config);
});

for (const journalKind of ['deferred', 'active']) test(`omitting the original profile cannot replay its ${journalKind} journal via a group or standalone worker`, async t => {
  const f = await fixture(t);
  const number = journalKind === 'deferred' ? 1 : 2;
  if (journalKind === 'active') await writeFile(f.config.attemptPath, JSON.stringify(journal(number)));
  const intruder = f.makeConfig('different-owner', number);
  await writeFile(join(f.root, 'history.ndjson'), JSON.stringify(verified(number)) + '\n');
  await assert.rejects(validateAttemptIsolation([intruder], manifest), { code: 'ATTEMPT_OUTSIDE_PLAN' });
  let entered = false;
  await assert.rejects(withWorkerGroupLease([intruder, f.peer], async () => { entered = true; }), { code: 'ATTEMPT_OUTSIDE_PLAN' });
  assert.equal(entered, false);
  const { deps, events } = fakeDependencies(intruder);
  const result = await runWorker(intruder, deps);
  assert.equal(result.errorCode, 'ATTEMPT_OUTSIDE_PLAN');
  assert.equal(events.launches, 0);
  if (journalKind === 'active') assert.deepEqual(await readPublicJson(f.config.attemptPath), journal(number));
  await f.assertOldUntouched();
  await assertLocksReleased(intruder);
});

test('safe member rearm retains deferred ownership and skips only its newly verified active wallet', async t => {
  const f = await fixture(t);
  const groupRunId = randomUUID();
  const first = fakeDependencies(f.config, { afterSave: async () => requestWorkerStop(f.config) });
  await withWorkerGroupLease([f.config, f.peer], async lease => {
    assert.equal((await runWorker(f.config, first.deps, { lease })).phase, 'stopped');
    const nextRunId = await rearmWorkerGroupMember(f.config, lease, groupRunId);
    assert.notEqual(nextRunId, groupRunId);
    const second = fakeDependencies(f.config);
    const result = await runWorker(f.config, second.deps, { lease });
    assert.equal(result.phase, 'completed');
    assert.equal(result.runId, nextRunId);
    assert.equal(result.deferredAttemptWalletNumber, 1);
    assert.deepEqual(first.events.calls, [2]);
    assert.deepEqual(second.events.calls, [3]);
    await f.assertOldUntouched();
  }, { runId: groupRunId });
  await assertLocksReleased(f.config);
});

for (const change of ['removed', 'changed', 'active-save']) test(`rearm refuses ${change} journal after a clean member stop`, async t => {
  const f = await fixture(t);
  const groupRunId = randomUUID();
  const { deps } = fakeDependencies(f.config, { afterSave: async () => requestWorkerStop(f.config) });
  await withWorkerGroupLease([f.config, f.peer], async lease => {
    assert.equal((await runWorker(f.config, deps, { lease })).phase, 'stopped');
    if (change === 'removed') await unlink(f.config.deferredAttemptPath);
    else if (change === 'changed') await writeFile(f.config.deferredAttemptPath, JSON.stringify(reorderedJournal()));
    else await writeFile(f.config.attemptPath, JSON.stringify(journal(3)));
    const code = change === 'removed' ? 'PUBLIC_FILE_INVALID' : change === 'changed' ? 'RECORD_INVALID' : 'NEEDS_ATTENTION';
    await assert.rejects(rearmWorkerGroupMember(f.config, lease, groupRunId), { code });
    if (change === 'active-save') {
      assert.deepEqual(await readPublicJson(f.config.attemptPath), journal(3));
      await f.assertOldUntouched();
    }
  }, { runId: groupRunId });
  await assertLocksReleased(f.config);
});
