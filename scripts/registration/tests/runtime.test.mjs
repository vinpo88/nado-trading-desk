import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import {
  normalizeWorkerConfig, runWorker, readPublicJson, atomicWriteJson, acquireLock,
  ensureDedicatedProfile, appendVerifiedRecord, workerStatus, requestWorkerStop,
  termsCandidate, acceptWorkerTerms, recoverWorkerLocks, WorkerError,
} from '../runtime.mjs';
import { parseWorkerArgs, prepareManifestFromVisibleUi } from '../worker.mjs';
import { parseProgress } from '../cli.mjs';
import { assertTermsMatch } from '../cua-runner.mjs';

for (const pendingCode of ['PAIRING_LINK_PENDING', 'ONBOARDING_PENDING', 'CONNECTION_PROPOSAL_PENDING', 'WEBSITE_LOADING_PENDING']) test(`${pendingCode} preserves the browser and exact wallet until it becomes available`, async t => {
  const { config, deps, events } = await fixture(t, 1);
  let attempts = 0, pendingWaits = 0;
  deps.createRunner = () => ({
    runWallet: async number => {
      events.calls.push(number);
      if (++attempts < 3) throw new WorkerError(pendingCode);
      return verified(number);
    },
    cleanup: async () => { events.cleanups++; },
  });
  deps.sleep = async () => {
    const state = await workerStatus(config);
    assert.equal(state.phase, 'waiting_connection');
    assert.equal(state.stage, ({ PAIRING_LINK_PENDING: 'waiting_pairing_link',
      ONBOARDING_PENDING: 'waiting_onboarding', CONNECTION_PROPOSAL_PENDING: 'waiting_connection_proposal',
      WEBSITE_LOADING_PENDING: 'waiting_website' })[pendingCode]);
    assert.equal(state.currentWalletNumber, 1);
    assert.equal(state.completed, 0);
    assert.equal(events.closes, 0);
    pendingWaits++;
  };
  const state = await runWorker(config, deps);
  assert.equal(state.phase, 'completed');
  assert.deepEqual(events.calls, [1, 1, 1]);
  assert.equal(events.launches, 1);
  assert.equal(events.closes, 1);
  assert.equal(events.cleanups, 1);
  assert.ok(pendingWaits > 0);
  assert.equal(parseProgress(await readFile(config.progressPath, 'utf8')).length, 1);
});

test('stop during pending pairing wait does not reconnect, sign, or advance', async t => {
  const { config, deps, events } = await fixture(t, 1);
  deps.createRunner = () => ({
    runWallet: async number => { events.calls.push(number); throw new WorkerError('PAIRING_LINK_PENDING'); },
    cleanup: async () => { events.cleanups++; },
  });
  deps.sleep = async () => { await requestWorkerStop(config); };
  const state = await runWorker(config, deps);
  assert.equal(state.phase, 'stopped');
  assert.deepEqual(events.calls, [1]);
  assert.equal(state.completed, 0);
  assert.equal(events.closes, 1);
  assert.equal(await readPublicJson(config.progressPath, { optional: true }), null);
});

test('pairing retry cannot be used when a Save intent exists', async t => {
  const { config, deps, events } = await fixture(t, 1);
  deps.createRunner = options => ({
    runWallet: async number => {
      events.calls.push(number);
      await options.onEvent({ stage: 'save_pending', walletNumber: number, address: address(number), username: 'ybtl1', saveAttempted: true });
      throw new WorkerError('PAIRING_LINK_PENDING');
    },
    cleanup: async () => {},
  });
  deps.sleep = async () => assert.fail('must not retry after Save');
  const state = await runWorker(config, deps);
  assert.equal(state.phase, 'failed');
  assert.equal(state.errorCode, 'NEEDS_ATTENTION');
  assert.deepEqual(events.calls, [1]);
  assert.equal((await readPublicJson(config.attemptPath)).saveAttempted, true);
});

test('fatal UI diagnosis persists only approved enums and booleans before cleanup', async t => {
  const { config, deps, events } = await fixture(t, 1);
  deps.createRunner = () => ({
    runWallet: async () => {
      const error = new WorkerError('NEEDS_ATTENTION');
      error.uiState = { fault: 'ui_state', localStatus: 'error', siteStage: 'pairing',
        walletMatches: true, authorizationArmed: false, rawError: 'never-persist-this-detail',
        connectionCode: 'never-persist-this-connection-code', usernameMatches: 'true' };
      throw error;
    },
    cleanup: async () => { events.cleanups++; },
  });
  const state = await runWorker(config, deps);
  assert.equal(state.phase, 'failed');
  assert.deepEqual(state.uiState, { fault: 'ui_state', localStatus: 'error', siteStage: 'pairing',
    walletMatches: true, authorizationArmed: false });
  const saved = await readFile(config.statusPath, 'utf8');
  assert.equal(saved.includes('never-persist'), false);
  assert.equal(events.cleanups, 1);
});

for (const afterSave of [false, true]) test(`safe UI attention retains context and locks until stop, afterSave=${afterSave}`, async t => {
  const { config, deps, events } = await fixture(t, 1);
  const expectedAttempt = { walletNumber: 1, address: address(1), username: 'ybtl1', saveAttempted: true };
  let waits = 0;
  deps.createRunner = options => ({
    runWallet: async number => {
      events.calls.push(number);
      if (afterSave) await options.onEvent({ stage: 'save_pending', ...expectedAttempt });
      const error = new WorkerError('NEEDS_ATTENTION');
      error.retainedBrowserSafe = true; // Synthetic runner already revoked/disconnected.
      error.uiState = { siteStage: 'unknown', localStatus: 'disconnected',
        authorizationArmed: false, rawError: 'never-persist-this-detail' };
      throw error;
    },
    cleanup: async () => { events.cleanups++; },
  });
  deps.sleep = async ms => {
    assert.ok(ms <= 1000);
    const state = await workerStatus(config);
    assert.equal(state.phase, 'waiting_attention');
    assert.equal(state.processAlive, true);
    assert.equal(state.errorCode, 'NEEDS_ATTENTION');
    assert.equal(state.currentWalletNumber, 1);
    assert.equal(state.completed, 0);
    assert.equal(events.closes, 0);
    assert.equal(events.cleanups, 0);
    assert.deepEqual(events.calls, [1]);
    assert.equal((await readPublicJson(config.globalLockPath)).runId, state.runId);
    assert.equal((await readPublicJson(config.profileLockPath)).runId, state.runId);
    assert.deepEqual(await readPublicJson(config.attemptPath, { optional: true }), afterSave ? expectedAttempt : null);
    assert.equal(await readPublicJson(config.progressPath, { optional: true }), null);
    if (++waits === 2) await requestWorkerStop(config);
  };
  const state = await runWorker(config, deps);
  assert.equal(state.phase, 'stopped');
  assert.equal(waits, 2);
  assert.equal(events.closes, 1);
  assert.equal(events.cleanups, 1);
  assert.deepEqual(events.calls, [1]);
  assert.deepEqual(await readPublicJson(config.attemptPath, { optional: true }), afterSave ? expectedAttempt : null);
  assert.equal(await readPublicJson(config.globalLockPath, { optional: true }), null);
  assert.equal(await readPublicJson(config.profileLockPath, { optional: true }), null);
  const saved = await readFile(config.statusPath, 'utf8');
  assert.equal(saved.includes('never-persist'), false);
  assert.equal(saved.includes('retainedBrowserSafe'), false);
});

test('closing a retained browser ends attention without retrying the wallet', async t => {
  const { config, deps, events } = await fixture(t, 1);
  let closed = false;
  deps.launch = async () => ({
    localPage: {}, nadoPage: {}, isClosed: () => closed,
    close: async () => { events.closes++; },
  });
  deps.createRunner = () => ({
    runWallet: async number => {
      events.calls.push(number);
      throw Object.assign(new WorkerError('NEEDS_ATTENTION'), { retainedBrowserSafe: true });
    },
    cleanup: async () => { events.cleanups++; },
  });
  deps.sleep = async () => {
    assert.equal((await workerStatus(config)).phase, 'waiting_attention');
    assert.equal(events.closes, 0);
    closed = true;
  };
  assert.equal((await runWorker(config, deps)).phase, 'stopped');
  assert.deepEqual(events.calls, [1]);
  assert.equal(events.closes, 1);
  assert.equal(await readPublicJson(config.profileLockPath, { optional: true }), null);
});

for (const retainedBrowserSafe of [undefined, false, 'true']) test(`attention requires a strict cleanup attestation: ${retainedBrowserSafe}`, async t => {
  const { config, deps, events } = await fixture(t, 1);
  deps.createRunner = () => ({
    runWallet: async number => {
      events.calls.push(number);
      throw Object.assign(new WorkerError('NEEDS_ATTENTION'), { retainedBrowserSafe });
    },
    cleanup: async () => { events.cleanups++; },
  });
  deps.sleep = async () => assert.fail('unverified cleanup must close, not wait');
  const state = await runWorker(config, deps);
  assert.equal(state.phase, 'failed');
  assert.equal(state.errorCode, 'NEEDS_ATTENTION');
  assert.deepEqual(events.calls, [1]);
  assert.equal(events.closes, 1);
});

for (const code of ['STORAGE_ERROR', 'RECORD_INVALID', 'ORIGIN_MISMATCH']) test(`${code} still closes even with a cleanup attestation`, async t => {
  const { config, deps, events } = await fixture(t, 1);
  deps.createRunner = () => ({
    runWallet: async () => { throw Object.assign(new WorkerError(code), { retainedBrowserSafe: true }); },
    cleanup: async () => { events.cleanups++; },
  });
  deps.sleep = async () => assert.fail('non-UI failures must close');
  const state = await runWorker(config, deps);
  assert.equal(state.phase, 'failed');
  assert.equal(state.errorCode, code);
  assert.equal(events.closes, 1);
});

for (const failure of ['record', 'storage']) test(`sanitized runner cannot turn ${failure} callback failure into attention`, async t => {
  const { config, deps, events } = await fixture(t, 1);
  deps.createRunner = options => ({
    runWallet: async number => {
      events.calls.push(number);
      if (failure === 'storage') await mkdir(config.attemptPath);
      try {
        await options.onEvent({ stage: 'save_pending', walletNumber: number,
          address: address(failure === 'record' ? number + 1 : number), username: 'ybtl1', saveAttempted: true });
        assert.fail('event must fail before any Save');
      } catch {
        throw Object.assign(new WorkerError('NEEDS_ATTENTION'), { retainedBrowserSafe: true });
      }
    },
    cleanup: async () => { events.cleanups++; },
  });
  deps.sleep = async () => assert.fail('runtime callback failure must not wait');
  const state = await runWorker(config, deps);
  assert.equal(state.phase, 'failed');
  assert.equal(state.errorCode, failure === 'record' ? 'RECORD_INVALID' : 'STORAGE_ERROR');
  assert.equal(state.completed, 0);
  assert.deepEqual(events.calls, [1]);
  assert.equal(events.closes, 1);
  assert.equal(await readPublicJson(config.progressPath, { optional: true }), null);
});

const address = number => `0x${number.toString(16).padStart(40, '0')}`;
const manifest = count => Array.from({ length: count }, (_, index) => ({ walletNumber: index + 1, address: address(index + 1) }));
const verified = number => ({
  walletNumber: number, address: address(number), username: `ybtl${number}`,
  status: 'verified_login_and_ink', loginComplete: true, websiteSignedIn: true,
  websiteNetwork: 'Ink', approvedChainId: 57073, agentTransactionsSent: 0,
});
const terms = {
  declarations: Array.from({ length: 6 }, (_, index) => `公开条款声明 ${index + 1}`),
  links: ['https://nado.xyz/legal-docs/terms-of-use', 'https://nado.xyz/legal-docs/privacy-policy'],
  termsUrl: 'https://nado.xyz/legal-docs/terms-of-use',
  privacyUrl: 'https://nado.xyz/legal-docs/privacy-policy',
};
async function fixture(t, count = 3, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nado-runtime-test-'));
  t.after(async () => {
    // Only remove the exact fresh test directory, never a computed user path.
    assert.equal(resolve(root).startsWith(resolve(tmpdir()) + '\\nado-runtime-test-')
      || resolve(root).startsWith(resolve(tmpdir()) + '/nado-runtime-test-'), true);
    await rm(root, { recursive: true, force: true });
  });
  const config = normalizeWorkerConfig({
    bounds: { min: 1, max: count }, walletsPath: 'wallets.json', progressPath: 'progress.ndjson',
    pollIntervalMs: 50, ...overrides,
  }, { configPath: join(root, 'worker.json'), repoDir: root });
  // Never contend with a user's actual worker or system clipboard during tests.
  config.globalLockPath = join(root, 'test-global', 'worker.lock');
  await writeFile(config.walletsPath, JSON.stringify(manifest(count)));
  const events = { launches: 0, closes: 0, cleanups: 0, calls: [], options: null };
  const deps = {
    launch: async () => {
      events.launches++;
      return { localPage: {}, nadoPage: {}, isClosed: () => false, close: async () => { events.closes++; } };
    },
    createRunner: options => {
      events.options = options;
      return {
        runWallet: async number => { events.calls.push(number); return verified(number); },
        readTermsCandidate: async () => terms,
        cleanup: async () => { events.cleanups++; },
      };
    },
    sleep: async () => {},
  };
  return { root, config, events, deps };
}

test('worker config defaults to 10000 descending; paths are config-relative and profile is fixed', () => {
  const repo = resolve('fixture-repo');
  const config = normalizeWorkerConfig({ walletsPath: 'private-data/wallets.json', progressPath: 'progress.ndjson' },
    { repoDir: repo, configPath: resolve('config-place', 'worker.json') });
  assert.deepEqual([config.plan.start, config.plan.end, config.plan.direction], [10000, 1, 'desc']);
  assert.equal(config.profileDir, join(repo, 'browser-profiles', 'registration', 'registration-edge'));
  assert.equal(config.walletsPath, resolve('config-place', 'private-data', 'wallets.json'));
  for (const bad of [
    { userDataDir: 'daily-profile' }, { browser: 'iab' }, { profileName: '../daily' },
    { localUrl: 'https://example.com/connect' }, { localUrl: 'http://127.0.0.1:18270/connect?wc=secret' },
    { laneindex: 1 }, { timeoutMs: 120000 }, { laneCount: 2, laneIndex: 2 },
  ]) assert.throws(() => normalizeWorkerConfig({ walletsPath: 'wallets.json', progressPath: 'progress.ndjson', ...bad },
    { repoDir: repo, configPath: join(repo, 'worker.json') }), { code: 'CONFIG_INVALID' });
});

test('CLI recognizes bootstrap, explicit consent and recovery; rejects implicit or duplicate options', () => {
  assert.equal(parseWorkerArgs(['open', '--config', 'worker.json']).command, 'open');
  assert.equal(parseWorkerArgs(['recover-locks', '--config', 'worker.json', '--confirm-closed']).confirmClosed, true);
  assert.equal(parseWorkerArgs(['run', '--config', 'worker.json', '--setup']).setup, true);
  for (const args of [['start'], ['start', '--config', 'a', '--config', 'b'], ['start', '--config', 'a', '--digest', 'x'],
    ['open', '--config', 'a', '--user-data-dir', 'daily']]) assert.throws(() => parseWorkerArgs(args));
});

test('exclusive lock cannot be taken twice and only owner releases it', async t => {
  const { root } = await fixture(t);
  const path = join(root, 'lock');
  const owner = { pid: process.pid, token: 'owner', runId: 'run' };
  const release = await acquireLock(path, owner);
  await assert.rejects(acquireLock(path, { ...owner, token: 'other' }), { code: 'WORKER_ALREADY_RUNNING' });
  await atomicWriteJson(path, { ...owner, token: 'replacement' });
  await release();
  assert.equal((await readPublicJson(path)).token, 'replacement');
});

test('dedicated profile refuses existing unmarked data and accepts its own marker', async t => {
  const { config } = await fixture(t);
  await ensureDedicatedProfile(config);
  await ensureDedicatedProfile(config);
  const another = { ...config, profileName: 'unmarked', profileDir: join(config.repoDir, 'browser-profiles', 'registration', 'unmarked') };
  await mkdir(another.profileDir);
  await writeFile(join(another.profileDir, 'example.txt'), 'unrelated data');
  await assert.rejects(ensureDedicatedProfile(another), { code: 'PROFILE_NOT_DEDICATED' });
  assert.equal(await readFile(join(another.profileDir, 'example.txt'), 'utf8'), 'unrelated data');
});

test('profile junction/symlink is rejected without inspecting the target', async t => {
  const { root, config } = await fixture(t);
  const target = join(root, 'other-browser');
  await mkdir(target);
  await mkdir(join(root, 'browser-profiles', 'registration'), { recursive: true });
  await symlink(target, config.profileDir, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ensureDedicatedProfile(config), { code: 'STORAGE_ERROR' });
  assert.deepEqual(await readdir(target), []);
});

test('serial worker skips verified progress and appends durably before the next number', async t => {
  const { config, deps, events } = await fixture(t);
  await writeFile(config.progressPath, JSON.stringify(verified(2)) + '\n');
  deps.createRunner = options => {
    events.options = options;
    return {
      runWallet: async number => {
        events.calls.push(number);
        if (number === 1) assert.deepEqual(parseProgress(await readFile(config.progressPath, 'utf8')).map(r => r.walletNumber), [2, 3]);
        await options.onEvent({ stage: 'preparing', walletNumber: number, address: address(number) });
        await options.onEvent({ stage: 'save_pending', walletNumber: number, address: address(number), username: `ybtl${number}`, saveAttempted: true });
        assert.equal((await readPublicJson(config.attemptPath)).walletNumber, number);
        return verified(number);
      },
      cleanup: async () => { events.cleanups++; },
    };
  };
  const state = await runWorker(config, deps);
  assert.equal(state.phase, 'completed');
  assert.deepEqual(events.calls, [3, 1]);
  assert.equal(state.completed, 3);
  assert.equal(events.cleanups, 1); assert.equal(events.closes, 1);
  assert.equal(await readPublicJson(config.attemptPath, { optional: true }), null);
  assert.equal((await workerStatus(config)).processAlive, false);
});

test('completed plan does not open any browser', async t => {
  const { config, deps, events } = await fixture(t, 1);
  await writeFile(config.progressPath, JSON.stringify(verified(1)) + '\n');
  assert.equal((await runWorker(config, deps)).phase, 'completed');
  assert.equal(events.launches, 0);
});

test('bootstrap opens the dedicated browser without a manifest or a registration runner', async t => {
  const { config, deps, events } = await fixture(t);
  config.walletsPath = join(config.repoDir, 'not-exported-yet.json');
  deps.createRunner = () => assert.fail('bootstrap must not create a signing runner');
  deps.sleep = async () => {
    assert.equal((await workerStatus(config)).phase, 'setup_browser');
    await requestWorkerStop(config);
  };
  assert.equal((await runWorker(config, deps, { setup: true })).phase, 'stopped');
  assert.equal(events.launches, 1); assert.equal(events.closes, 1);
  assert.equal(await readPublicJson(config.progressPath, { optional: true }), null);
});

test('first start exports missing public manifest and continues in the same unlocked context', async t => {
  const { root, config, deps, events } = await fixture(t, 2);
  config.walletsPath = join(root, 'new-public-folder', 'wallets.json');
  let prepared = 0;
  deps.prepareManifest = async (_config, browser, callbacks) => {
    prepared++;
    assert.equal(browser.localPage !== undefined, true);
    await callbacks.onStage('waiting_unlock');
    assert.equal((await workerStatus(config)).phase, 'waiting_unlock');
    await callbacks.onStage('exporting_manifest');
    return manifest(2);
  };
  assert.equal((await runWorker(config, deps)).phase, 'completed');
  assert.equal(events.launches, 1); assert.equal(prepared, 1);
  assert.deepEqual(events.calls, [2, 1]);
  assert.deepEqual(await readPublicJson(config.walletsPath), manifest(2));
  assert.equal(events.closes, 1);
});

test('stop during first-run unlock/export wait closes context without creating a manifest', async t => {
  const { root, config, deps, events } = await fixture(t);
  config.walletsPath = join(root, 'not-yet-exported.json');
  deps.prepareManifest = async (_config, _browser, callbacks) => {
    await callbacks.onStage('waiting_manifest_export');
    await requestWorkerStop(config);
    assert.equal(await callbacks.shouldStop(), true);
    return null;
  };
  assert.equal((await runWorker(config, deps)).phase, 'stopped');
  assert.equal(await readPublicJson(config.walletsPath, { optional: true }), null);
  assert.equal(events.launches, 1); assert.equal(events.closes, 1);
  assert.equal(events.options, null);
});

test('existing invalid manifest is rejected before launch and is never replaced by browser export', async t => {
  const { config, deps, events } = await fixture(t);
  const invalid = JSON.stringify([{ walletNumber: 1, address: address(1), privateKey: 'never-read-by-runner' }]);
  await writeFile(config.walletsPath, invalid);
  deps.prepareManifest = async () => assert.fail('existing file must never trigger export');
  assert.equal((await runWorker(config, deps)).errorCode, 'PUBLIC_FILE_INVALID');
  assert.equal(await readFile(config.walletsPath, 'utf8'), invalid);
  assert.equal(events.launches, 0);
});

test('manifest exporter clicks only exact public export button and validates downloaded fields', async t => {
  const { config } = await fixture(t);
  const stages = [];
  const expected = manifest(3);
  let clicks = 0;
  const page = {
    url: () => config.localUrl,
    getByTestId: name => {
      assert.equal(name, 'connect-wallet-address');
      return { isVisible: async () => true };
    },
    getByRole: (role, options) => {
      assert.equal(role, 'button');
      assert.deepEqual(options, { name: '导出编号与地址清单', exact: true });
      return { count: async () => 1, isVisible: async () => true, isEnabled: async () => true,
        click: async () => { clicks++; } };
    },
    waitForEvent: async name => {
      assert.equal(name, 'download');
      return { createReadStream: async () => Readable.from([Buffer.from(JSON.stringify(expected))]) };
    },
  };
  const result = await prepareManifestFromVisibleUi(config, { localPage: page }, {
    shouldStop: async () => false, onStage: async stage => { stages.push(stage); },
  });
  assert.deepEqual(result, expected); assert.equal(clicks, 1);
  assert.deepEqual(stages, ['exporting_manifest']);
  page.waitForEvent = async () => ({ createReadStream: async () => Readable.from([Buffer.from('{"privateKey":"invalid"}')]) });
  await assert.rejects(prepareManifestFromVisibleUi(config, { localPage: page }, {
    shouldStop: async () => false, onStage: async () => {},
  }), { code: 'PUBLIC_FILE_INVALID' });
});

test('stop requested during a wallet saves that wallet and never advances', async t => {
  const { config, deps, events } = await fixture(t);
  deps.createRunner = () => ({
    runWallet: async number => {
      events.calls.push(number);
      await requestWorkerStop(config);
      return verified(number);
    }, cleanup: async () => { events.cleanups++; },
  });
  const state = await runWorker(config, deps);
  assert.equal(state.phase, 'stopped');
  assert.deepEqual(events.calls, [3]);
  assert.deepEqual(parseProgress(await readFile(config.progressPath, 'utf8')).map(r => r.walletNumber), [3]);
  assert.equal(events.closes, 1);
});

test('waiting for manual vault unlock stops promptly', async t => {
  const { config, deps, events } = await fixture(t);
  deps.createRunner = () => ({
    runWallet: async number => { events.calls.push(number); throw new WorkerError('VAULT_LOCKED'); },
    cleanup: async () => { events.cleanups++; },
  });
  deps.sleep = async () => {
    assert.equal((await workerStatus(config)).phase, 'waiting_unlock');
    await requestWorkerStop(config);
  };
  const state = await runWorker(config, deps);
  assert.equal(state.phase, 'stopped');
  assert.deepEqual(events.calls, [3]); assert.equal(events.closes, 1);
});

test('terms wait requires current-run digest confirmation and delegates live checks to the same runner', async t => {
  const { config, deps, events } = await fixture(t, 1);
  let checks = 0, waits = 0;
  deps.createRunner = () => ({
    runWallet: async (number, confirmation) => {
      events.calls.push(number);
      if (!confirmation) throw new WorkerError('TERMS_CONFIRMATION_REQUIRED');
      assert.equal(confirmation.confirmed, true);
      assert.deepEqual(confirmation.declarations, terms.declarations);
      assertTermsMatch(terms, confirmation); // The runner owns its final visible-UI check.
      return verified(number);
    },
    readTermsCandidate: async () => { checks++; return terms; }, cleanup: async () => {},
  });
  deps.sleep = async () => {
    const candidate = await readPublicJson(config.candidatePath);
    const state = await workerStatus(config);
    assert.equal(state.phase, 'waiting_terms');
    assert.equal(candidate.runId, state.runId);
    assert.deepEqual(events.calls, [1]);
    if (++waits === 1) {
      await atomicWriteJson(config.consentPath, { runId: 'another-run', digest: candidate.digest });
      return;
    }
    if (waits === 2) {
      await atomicWriteJson(config.consentPath, { runId: state.runId, digest: '0'.repeat(64) });
      return;
    }
    await assert.rejects(acceptWorkerTerms(config, '0'.repeat(64)), { code: 'CONFIRMATION_INVALID' });
    await acceptWorkerTerms(config, candidate.digest);
  };
  const state = await runWorker(config, deps);
  assert.equal(state.phase, 'completed');
  assert.deepEqual(events.calls, [1, 1]); assert.equal(checks, 1);
  assert.equal(waits, 3);
});

for (const advancedStage of ['introduction', 'complete']) test(`Terms disappears before consent; the same runner resumes ${advancedStage} without another candidate read`, async t => {
  const { config, deps, events } = await fixture(t, 1);
  let visibleStage = 'terms', reads = 0, saves = 0;
  deps.createRunner = options => ({
    runWallet: async (number, confirmation) => {
      events.calls.push(number);
      if (!confirmation) throw new WorkerError('TERMS_CONFIRMATION_REQUIRED');
      assert.equal(visibleStage, advancedStage);
      assert.equal(confirmation.confirmed, true);
      assertTermsMatch(terms, confirmation);
      if (advancedStage === 'introduction') {
        saves++;
        await options.onEvent({ stage: 'save_pending', walletNumber: number,
          address: address(number), username: 'ybtl1', saveAttempted: true });
      }
      return verified(number);
    },
    readTermsCandidate: async () => {
      reads++;
      if (visibleStage !== 'terms') throw Object.assign(new Error('dialog is gone'), { name: 'TimeoutError' });
      return terms;
    },
    cleanup: async () => { events.cleanups++; },
  });
  deps.sleep = async () => {
    visibleStage = advancedStage;
    await acceptWorkerTerms(config, (await readPublicJson(config.candidatePath)).digest);
  };
  const state = await runWorker(config, deps);
  assert.equal(state.phase, 'completed');
  assert.deepEqual(events.calls, [1, 1]);
  assert.equal(reads, 1);
  assert.equal(saves, advancedStage === 'introduction' ? 1 : 0);
  assert.equal(parseProgress(await readFile(config.progressPath, 'utf8')).length, 1);
  assert.equal(await readPublicJson(config.attemptPath, { optional: true }), null);
});

test('old-run terms consent is never reused and stop while waiting closes the browser', async t => {
  const { config, deps, events } = await fixture(t, 1);
  await mkdir(config.stateDir, { recursive: true });
  const oldCandidate = termsCandidate(terms, 'old-run');
  await atomicWriteJson(config.consentPath, { runId: 'old-run', digest: oldCandidate.digest });
  deps.createRunner = () => ({
    runWallet: async (_, confirmation) => { assert.equal(confirmation, undefined); throw new WorkerError('TERMS_CONFIRMATION_REQUIRED'); },
    readTermsCandidate: async () => terms, cleanup: async () => {},
  });
  deps.sleep = async () => { await requestWorkerStop(config); };
  assert.equal((await runWorker(config, deps)).phase, 'stopped');
  assert.equal(events.closes, 1);
  assert.equal(await readPublicJson(config.progressPath, { optional: true }), null);
});

test('runner rejects changed visible Terms after consent without a success record', async t => {
  const { config, deps, events } = await fixture(t, 1);
  let reads = 0, agreements = 0;
  deps.createRunner = () => ({
    runWallet: async (number, confirmation) => {
      events.calls.push(number);
      if (!confirmation) throw new WorkerError('TERMS_CONFIRMATION_REQUIRED');
      try { assertTermsMatch({ ...terms, declarations: terms.declarations.map(x => x + ' changed') }, confirmation); }
      catch { throw new WorkerError('NEEDS_ATTENTION'); }
      agreements++;
      return verified(number);
    },
    readTermsCandidate: async () => { reads++; return terms; },
    cleanup: async () => {},
  });
  deps.sleep = async () => { await acceptWorkerTerms(config, (await readPublicJson(config.candidatePath)).digest); };
  const state = await runWorker(config, deps);
  assert.equal(state.phase, 'failed');
  assert.equal(state.errorCode, 'NEEDS_ATTENTION');
  assert.deepEqual(events.calls, [1, 1]);
  assert.equal(reads, 1);
  assert.equal(agreements, 0);
  assert.equal(await readPublicJson(config.progressPath, { optional: true }), null);
});

test('Terms consent never removes an unresolved Save intent or bypasses the runner replay guard', async t => {
  const { config, deps, events } = await fixture(t, 1);
  const attempt = { walletNumber: 1, address: address(1), username: 'ybtl1', saveAttempted: true };
  await mkdir(config.stateDir, { recursive: true });
  await atomicWriteJson(config.attemptPath, attempt);
  let reads = 0;
  deps.createRunner = options => ({
    runWallet: async (number, confirmation) => {
      events.calls.push(number);
      assert.deepEqual(options.resumeAttempt, attempt);
      assert.deepEqual(await readPublicJson(config.attemptPath), attempt);
      if (!confirmation) throw new WorkerError('TERMS_CONFIRMATION_REQUIRED');
      // An unresolved prior Save may only be verified, never submitted again.
      throw new WorkerError('NEEDS_ATTENTION');
    },
    readTermsCandidate: async () => { reads++; return terms; },
    cleanup: async () => {},
  });
  deps.sleep = async () => { await acceptWorkerTerms(config, (await readPublicJson(config.candidatePath)).digest); };
  const state = await runWorker(config, deps);
  assert.equal(state.phase, 'failed');
  assert.equal(state.errorCode, 'NEEDS_ATTENTION');
  assert.deepEqual(events.calls, [1, 1]);
  assert.equal(reads, 1);
  assert.deepEqual(await readPublicJson(config.attemptPath), attempt);
  assert.equal(await readPublicJson(config.progressPath, { optional: true }), null);
});

test('invalid success records never enter the verified ledger', async t => {
  for (const change of [{ address: address(99) }, { walletNumber: 2 }, { loginComplete: false },
    { agentTransactionsSent: 1 }, { websiteNetwork: 'Other' }, { username: undefined }]) {
    const { config, deps, events } = await fixture(t, 1);
    deps.createRunner = () => ({ runWallet: async () => ({ ...verified(1), ...change }), cleanup: async () => {} });
    const state = await runWorker(config, deps);
    assert.equal(state.phase, 'failed'); assert.equal(state.errorCode, 'RECORD_INVALID');
    assert.equal(await readPublicJson(config.progressPath, { optional: true }), null);
    assert.equal(events.closes, 1);
  }
});

test('failed durable append preserves attempt and does not advance; raw error is redacted', async t => {
  const { config, deps, events } = await fixture(t);
  const secretSentinel = 'wc:private-topic@symKey=never-print-this';
  deps.createRunner = options => ({
    runWallet: async number => {
      events.calls.push(number);
      await options.onEvent({ stage: 'save_pending', walletNumber: number, address: address(number), username: `ybtl${number}`, saveAttempted: true });
      return verified(number);
    }, cleanup: async () => { events.cleanups++; },
  });
  deps.append = async () => { throw new Error(secretSentinel); };
  const state = await runWorker(config, deps);
  assert.equal(state.phase, 'failed'); assert.equal(state.completed, 0);
  assert.deepEqual(events.calls, [3]);
  assert.equal((await readPublicJson(config.attemptPath)).walletNumber, 3);
  assert.equal((await readFile(config.statusPath, 'utf8')).includes(secretSentinel), false);
  assert.equal(events.cleanups, 1); assert.equal(events.closes, 1);
});

test('unfinished Save attempt is passed to the same wallet; different plan cannot bypass it', async t => {
  const { config, deps, events } = await fixture(t);
  await mkdir(config.stateDir, { recursive: true });
  const attempt = { walletNumber: 3, address: address(3), username: 'ybtl3', saveAttempted: true };
  await atomicWriteJson(config.attemptPath, attempt);
  await runWorker(config, deps);
  assert.deepEqual(events.options.resumeAttempt, attempt);
  await atomicWriteJson(config.attemptPath, { ...attempt, walletNumber: 2, address: address(2), username: 'ybtl2' });
  await writeFile(config.progressPath, '');
  events.launches = 0;
  const state = await runWorker(config, deps);
  assert.equal(state.errorCode, 'ATTEMPT_OUTSIDE_PLAN'); assert.equal(events.launches, 0);
});

test('append handles missing newline and refuses JSON-array output', async t => {
  const { config } = await fixture(t, 2);
  await writeFile(config.progressPath, JSON.stringify(verified(2)));
  await appendVerifiedRecord(config.progressPath, verified(1));
  assert.deepEqual(parseProgress(await readFile(config.progressPath, 'utf8')).map(r => r.walletNumber), [2, 1]);
  await writeFile(config.progressPath, JSON.stringify([verified(2)]));
  await assert.rejects(appendVerifiedRecord(config.progressPath, verified(1)), { code: 'STORAGE_ERROR' });
});

test('status does not create state; stale recovery requires explicit closure and refuses live PIDs', async t => {
  const { config } = await fixture(t);
  const before = await readdir(config.repoDir);
  assert.equal((await workerStatus(config)).phase, 'not_started');
  assert.deepEqual(await readdir(config.repoDir), before);
  await mkdir(config.stateDir, { recursive: true });
  await mkdir(join(config.repoDir, 'test-global'));
  const active = { pid: process.pid, runId: 'run', token: 'owner' };
  await atomicWriteJson(config.globalLockPath, active);
  await atomicWriteJson(config.profileLockPath, active);
  await assert.rejects(recoverWorkerLocks(config, false), { code: 'CONFIRMATION_INVALID' });
  await assert.rejects(recoverWorkerLocks(config, true), { code: 'WORKER_ALREADY_RUNNING' });
  const dead = { ...active, pid: 2147483647 };
  await atomicWriteJson(config.globalLockPath, dead);
  await atomicWriteJson(config.profileLockPath, dead);
  assert.equal((await recoverWorkerLocks(config, true)).phase, 'locks_recovered');
  assert.equal(await readPublicJson(config.globalLockPath, { optional: true }), null);
  assert.equal(await readPublicJson(config.profileLockPath, { optional: true }), null);
});
