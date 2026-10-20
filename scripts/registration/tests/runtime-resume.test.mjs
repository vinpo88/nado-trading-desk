import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  normalizeWorkerConfig, runWorker, workerStatus, readPublicJson, atomicWriteJson,
  requestWorkerResume, requestWorkerStop, WorkerError,
} from '../runtime.mjs';
import { parseProgress } from '../cli.mjs';

const address = number => `0x${number.toString(16).padStart(40, '0')}`;
const attempted = { walletNumber: 1, address: address(1), username: 'ybtl1', saveAttempted: true };
const verified = number => ({
  walletNumber: number, address: address(number), username: `ybtl${number}`,
  status: 'verified_login_and_ink', loginComplete: true, websiteSignedIn: true,
  websiteNetwork: 'Ink', approvedChainId: 57073, agentTransactionsSent: 0,
});
const eligibleFailure = overrides => Object.assign(new WorkerError('NEEDS_ATTENTION'), {
  retainedBrowserSafe: true, connectionRecoveryAllowed: true,
  uiState: { localStatus: 'disconnected', siteStage: 'pairing', authorizationArmed: false },
}, overrides);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nado-runtime-resume-test-'));
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(root));
    assert.equal(isAbsolute(rel) || rel.startsWith('..'), false);
    assert.match(rel, /^nado-runtime-resume-test-[^/\\]+$/);
    await rm(root, { recursive: true, force: true });
  });
  const config = normalizeWorkerConfig({
    bounds: { min: 1, max: 1 }, walletsPath: 'wallets.json', progressPath: 'progress.ndjson', pollIntervalMs: 50,
  }, { configPath: join(root, 'worker.json'), repoDir: root });
  config.globalLockPath = join(root, 'isolated-global', 'worker.lock');
  await writeFile(config.walletsPath, JSON.stringify([{ walletNumber: 1, address: address(1) }]));
  const events = { launches: 0, creates: 0, closes: 0, cleanups: 0, calls: [], recoveries: [], recovered: false };
  const deps = {
    launch: async () => {
      events.launches++;
      return { localPage: {}, nadoPage: {}, isClosed: () => false, close: async () => { events.closes++; } };
    },
    createRunner: options => {
      events.creates++;
      events.options = options;
      return {
        runWallet: async number => {
          events.calls.push(number);
          if (!events.recovered) throw eligibleFailure();
          return verified(number);
        },
        recoverConnection: async number => { events.recoveries.push(number); events.recovered = true; },
        cleanup: async () => { events.cleanups++; },
      };
    },
    sleep: async () => assert.fail('test must explicitly handle attention'),
  };
  return { root, config, events, deps };
}

test('explicit member resume consumes one command and continues the same runner and wallet', async t => {
  const { config, deps, events } = await fixture(t);
  assert.equal(config.resumePath, join(config.stateDir, 'resume.json'));
  let waits = 0;
  deps.sleep = async () => {
    assert.equal(++waits, 1);
    const state = await workerStatus(config);
    assert.equal(state.phase, 'waiting_attention');
    assert.equal(state.canResumeConnection, true);
    assert.equal(state.currentWalletNumber, 1);
    assert.equal(events.closes, 0);
    const request = await requestWorkerResume(config, state.attentionId);
    assert.equal(request.phase, 'resume_requested');
    const command = await readPublicJson(config.resumePath);
    assert.equal(command.runId, state.runId);
    assert.equal(command.profileName, config.profileName);
    assert.equal(command.walletNumber, 1);
    assert.equal(command.address, address(1));
    assert.equal((await readPublicJson(config.profileLockPath)).runId, state.runId);
    await assert.rejects(requestWorkerResume(config, state.attentionId), { code: 'CONFIRMATION_INVALID' });
    assert.deepEqual(await readPublicJson(config.resumePath), command);
  };
  const state = await runWorker(config, deps);
  assert.equal(state.phase, 'completed');
  assert.equal(state.attentionId, null);
  assert.equal(state.canResumeConnection, false);
  assert.deepEqual(events.calls, [1, 1]);
  assert.deepEqual(events.recoveries, [1]);
  assert.equal(events.launches, 1);
  assert.equal(events.creates, 1);
  assert.equal(events.closes, 1);
  assert.equal(await readPublicJson(config.resumePath, { optional: true }), null);
  assert.equal(parseProgress(await readFile(config.progressPath, 'utf8')).length, 1);
});

for (const [name, patch] of [
  ['run', () => ({ runId: randomUUID() })],
  ['attention token', () => ({ attentionId: randomUUID() })],
  ['profile', () => ({ profileName: 'different-profile' })],
  ['wallet number', () => ({ walletNumber: 2 })],
  ['address', () => ({ address: address(2) })],
  ['unknown field', () => ({ untrusted: 'not-an-instruction' })],
]) test(`a command with a mismatched ${name} cannot recover a member`, async t => {
  const { config, deps, events } = await fixture(t);
  let waits = 0;
  deps.sleep = async () => {
    const state = await workerStatus(config);
    if (++waits === 1) {
      await requestWorkerResume(config, state.attentionId);
      await atomicWriteJson(config.resumePath, { ...await readPublicJson(config.resumePath), ...patch() });
    } else {
      assert.equal(waits, 2);
      assert.equal(state.phase, 'waiting_attention');
      assert.deepEqual(events.recoveries, []);
      await requestWorkerStop(config);
    }
  };
  const state = await runWorker(config, deps);
  assert.equal(state.phase, 'stopped');
  assert.deepEqual(events.calls, [1]);
  assert.deepEqual(events.recoveries, []);
});

for (const proof of [undefined, false, 'true']) test(`connection recovery requires strict runner proof: ${proof}`, async t => {
  const { config, deps, events } = await fixture(t);
  const create = deps.createRunner;
  deps.createRunner = options => ({
    ...create(options),
    runWallet: async number => { events.calls.push(number); throw eligibleFailure({ connectionRecoveryAllowed: proof }); },
  });
  deps.sleep = async () => {
    const state = await workerStatus(config);
    assert.equal(state.phase, 'waiting_attention');
    assert.equal(state.canResumeConnection, false);
    await assert.rejects(requestWorkerResume(config, state.attentionId), { code: 'CONFIRMATION_INVALID' });
    assert.equal(await readPublicJson(config.resumePath, { optional: true }), null);
    await requestWorkerStop(config);
  };
  assert.equal((await runWorker(config, deps)).phase, 'stopped');
  assert.deepEqual(events.recoveries, []);
});

test('an old runner without a recovery method cannot be upgraded by a resume command', async t => {
  const { config, deps, events } = await fixture(t);
  const create = deps.createRunner;
  deps.createRunner = options => {
    const runner = create(options);
    delete runner.recoverConnection;
    return runner;
  };
  deps.sleep = async () => {
    const state = await workerStatus(config);
    assert.equal(state.canResumeConnection, false);
    await assert.rejects(requestWorkerResume(config, state.attentionId), { code: 'CONFIRMATION_INVALID' });
    await requestWorkerStop(config);
  };
  assert.equal((await runWorker(config, deps)).phase, 'stopped');
  assert.deepEqual(events.recoveries, []);
});

test('the request API refuses a missing old-process capability, wrong token and mismatched manifest', async t => {
  const { config, deps, events } = await fixture(t);
  deps.sleep = async () => {
    const state = await workerStatus(config);
    await assert.rejects(requestWorkerResume(config, randomUUID()), { code: 'CONFIRMATION_INVALID' });
    const old = { ...state };
    delete old.attentionId;
    delete old.canResumeConnection;
    await atomicWriteJson(config.statusPath, old);
    await assert.rejects(requestWorkerResume(config, state.attentionId), { code: 'CONFIRMATION_INVALID' });
    await atomicWriteJson(config.statusPath, state);
    await writeFile(config.walletsPath, JSON.stringify([{ walletNumber: 2, address: address(2) }]));
    await assert.rejects(requestWorkerResume(config, state.attentionId), { code: 'CONFIRMATION_INVALID' });
    assert.equal(await readPublicJson(config.resumePath, { optional: true }), null);
    await requestWorkerStop(config);
  };
  assert.equal((await runWorker(config, deps)).phase, 'stopped');
  assert.deepEqual(events.recoveries, []);
});

test('an existing Save intent disables recovery and is preserved', async t => {
  const { config, deps, events } = await fixture(t);
  await mkdir(config.stateDir, { recursive: true });
  await atomicWriteJson(config.attemptPath, attempted);
  deps.sleep = async () => {
    const state = await workerStatus(config);
    assert.equal(state.canResumeConnection, false);
    await assert.rejects(requestWorkerResume(config, state.attentionId), { code: 'CONFIRMATION_INVALID' });
    await requestWorkerStop(config);
  };
  assert.equal((await runWorker(config, deps)).phase, 'stopped');
  assert.deepEqual(events.options.resumeAttempt, attempted);
  assert.deepEqual(events.recoveries, []);
  assert.deepEqual(await readPublicJson(config.attemptPath), attempted);
});

test('a Save intent appearing after request blocks consumption and any recovery', async t => {
  const { config, deps, events } = await fixture(t);
  let waits = 0;
  deps.sleep = async () => {
    const state = await workerStatus(config);
    if (++waits === 1) {
      await requestWorkerResume(config, state.attentionId);
      await atomicWriteJson(config.attemptPath, attempted);
    } else {
      assert.equal(waits, 2);
      assert.equal(state.canResumeConnection, false);
      await assert.rejects(requestWorkerResume(config, state.attentionId), { code: 'CONFIRMATION_INVALID' });
      await requestWorkerStop(config);
    }
  };
  assert.equal((await runWorker(config, deps)).phase, 'stopped');
  assert.deepEqual(events.recoveries, []);
  assert.deepEqual(await readPublicJson(config.attemptPath), attempted);
});

test('stop takes priority over an already queued resume command', async t => {
  const { config, deps, events } = await fixture(t);
  deps.sleep = async () => {
    const state = await workerStatus(config);
    await requestWorkerResume(config, state.attentionId);
    await requestWorkerStop(config);
    await assert.rejects(requestWorkerResume(config, state.attentionId), { code: 'CONFIRMATION_INVALID' });
  };
  const state = await runWorker(config, deps);
  assert.equal(state.phase, 'stopped');
  assert.equal(state.attentionId, null);
  assert.equal(state.canResumeConnection, false);
  assert.deepEqual(events.calls, [1]);
  assert.deepEqual(events.recoveries, []);
});

test('failed recovery creates a new token and cannot replay the consumed request', async t => {
  const { config, deps, events } = await fixture(t);
  const create = deps.createRunner;
  deps.createRunner = options => ({
    ...create(options),
    recoverConnection: async number => {
      events.recoveries.push(number);
      if (events.recoveries.length === 1) throw eligibleFailure();
      events.recovered = true;
    },
  });
  let waits = 0, previous, nextAttentionId;
  deps.sleep = async () => {
    const state = await workerStatus(config);
    if (++waits === 1) {
      await requestWorkerResume(config, state.attentionId);
      previous = await readPublicJson(config.resumePath);
    } else if (waits === 2) {
      assert.notEqual(state.attentionId, previous.attentionId);
      nextAttentionId = state.attentionId;
      assert.deepEqual(events.recoveries, [1]);
      assert.equal(await readPublicJson(config.resumePath, { optional: true }), null);
      await assert.rejects(requestWorkerResume(config, previous.attentionId), { code: 'CONFIRMATION_INVALID' });
      await atomicWriteJson(config.resumePath, previous);
    } else {
      assert.equal(waits, 3);
      assert.equal(state.attentionId, nextAttentionId);
      assert.deepEqual(events.recoveries, [1]);
      await requestWorkerResume(config, state.attentionId);
    }
  };
  assert.equal((await runWorker(config, deps)).phase, 'completed');
  assert.deepEqual(events.calls, [1, 1]);
  assert.deepEqual(events.recoveries, [1, 1]);
  assert.equal(events.creates, 1);
});

for (const failure of ['unsafe', 'storage', 'callback']) test(`recovery ${failure} failure closes instead of retaining or retrying`, async t => {
  const { config, deps, events } = await fixture(t);
  const create = deps.createRunner;
  deps.createRunner = options => ({
    ...create(options),
    recoverConnection: async number => {
      events.recoveries.push(number);
      if (failure === 'storage') throw new WorkerError('STORAGE_ERROR');
      if (failure === 'unsafe') throw eligibleFailure({ retainedBrowserSafe: false });
      try { await options.onEvent({ stage: 'recovering_connection', walletNumber: number, address: address(9) }); }
      catch { throw eligibleFailure(); } // Sanitizing must not erase runtime's own error.
    },
  });
  let waits = 0;
  deps.sleep = async () => {
    assert.equal(++waits, 1);
    await requestWorkerResume(config, (await workerStatus(config)).attentionId);
  };
  const state = await runWorker(config, deps);
  assert.equal(state.phase, 'failed');
  assert.equal(state.errorCode, failure === 'storage' ? 'STORAGE_ERROR' : failure === 'callback' ? 'RECORD_INVALID' : 'NEEDS_ATTENTION');
  assert.equal(state.attentionId, null);
  assert.equal(state.canResumeConnection, false);
  assert.deepEqual(events.calls, [1]);
  assert.deepEqual(events.recoveries, [1]);
  assert.equal(events.closes, 1);
  assert.equal(await readPublicJson(config.progressPath, { optional: true }), null);
});
