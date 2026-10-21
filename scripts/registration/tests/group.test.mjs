import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  parseGroupArgs, loadGroupConfig, groupStatus, stopGroup, runGroup, startGroup, publicWorkerState,
  requestWorkerRestart,
} from '../group.mjs';
import { readPublicJson, runWorker, requestWorkerResume, rearmWorkerGroupMember, atomicWriteJson, WorkerError } from '../runtime.mjs';
import { parseProgress } from '../cli.mjs';

const tick = () => new Promise(resolveWait => setImmediate(resolveWait));
function deferred() {
  let resolveWait;
  const promise = new Promise(resolvePromise => { resolveWait = resolvePromise; });
  return { promise, resolve: resolveWait };
}
async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, 'expected fixture state before timeout');
    await new Promise(resolveWait => setTimeout(resolveWait, 5));
  }
}
async function writeWalletFixture(root, count = 4) {
  const wallets = Array.from({ length: count }, (_, index) => ({
    walletNumber: index + 1, address: `0x${(index + 1).toString(16).padStart(40, '0')}`,
  }));
  await writeFile(join(root, 'wallets.json'), JSON.stringify(wallets));
  return number => ({
    walletNumber: number, address: wallets[number - 1].address, username: `demo${number}`,
    status: 'verified_login_and_ink', loginComplete: true, websiteSignedIn: true,
    websiteNetwork: 'Ink', approvedChainId: 57073, agentTransactionsSent: 0,
  });
}
async function fixture(t, workerCount = 2) {
  const root = await mkdtemp(join(tmpdir(), 'nado-group-test-'));
  const cleanup = [];
  t.after(async () => {
    for (const callback of cleanup.toReversed()) await callback();
    const checked = resolve(root);
    assert.equal(checked.startsWith(resolve(tmpdir()) + '\\nado-group-test-')
      || checked.startsWith(resolve(tmpdir()) + '/nado-group-test-'), true);
    await rm(checked, { recursive: true, force: true });
  });
  const files = workerCount === 2 ? ['edge.json', 'chrome.json']
    : Array.from({ length: workerCount }, (_, index) => `worker-${index}.json`);
  for (const [index, name] of files.entries()) await writeFile(join(root, name), JSON.stringify({
    browser: index % 2 ? 'chrome' : 'edge', profileName: `fixture-${index}`,
    bounds: { min: 1, max: workerCount * 2 }, start: (workerCount - index) * 2, end: (workerCount - index) * 2 - 1,
    walletsPath: 'wallets.json', progressPath: `progress-${index}.ndjson`,
  }));
  const configPath = join(root, 'group.json');
  await writeFile(configPath, JSON.stringify({ workerConfigs: files }));
  const group = await loadGroupConfig(configPath, { repoDir: root });
  for (const config of group.configs) config.globalLockPath = join(root, 'isolated-global.lock');
  return { root, group, onCleanup: callback => cleanup.push(callback) };
}
function fakeLease(onExit = () => {}) {
  return async (configs, callback, options) => {
    const lease = { onlyFixture: true };
    try { return await callback(lease); }
    finally { await onExit(configs, options); }
  };
}

test('group requires 2–6 explicitly listed configs and resolves members against group file', async t => {
  const { root, group } = await fixture(t);
  assert.deepEqual(group.workerConfigs, [join(root, 'edge.json'), join(root, 'chrome.json')]);
  assert.equal(group.configs[1].browser, 'chrome');
  for (const raw of [
    {}, { workerConfigs: [] }, { workerConfigs: ['edge.json'] },
    { workerConfigs: ['edge.json', './edge.json'] },
    { workerConfigs: ['edge.json', 'chrome.json'], parallel: true },
    { workerConfigs: Array.from({ length: 7 }, (_, index) => `worker-${index}.json`) },
  ]) {
    await writeFile(group.configPath, JSON.stringify(raw));
    await assert.rejects(loadGroupConfig(group.configPath, { repoDir: root }), { code: 'CONFIG_INVALID' });
  }
});

test('group loads six independent configs and rejects seven before loading any member', async t => {
  const { root, group } = await fixture(t, 6);
  assert.equal(group.configs.length, 6);
  assert.deepEqual(group.configs.map(config => config.browser), ['edge', 'chrome', 'edge', 'chrome', 'edge', 'chrome']);
  assert.equal(new Set(group.configs.map(config => config.profileDir)).size, 6);
  await writeFile(group.configPath, JSON.stringify({ workerConfigs: [...group.workerConfigs, 'worker-6.json'] }));
  let memberLoads = 0;
  await assert.rejects(loadGroupConfig(group.configPath, {
    repoDir: root, loadConfig: async () => { memberLoads++; return group.configs[0]; },
  }), { code: 'CONFIG_INVALID' });
  assert.equal(memberLoads, 0);
});

test('CLI accepts only explicit operations and run IDs', () => {
  const runId = randomUUID();
  assert.equal(parseGroupArgs(['run', '--config', 'group.json', '--run-id', runId]).runId, runId);
  assert.equal(parseGroupArgs(['recover-locks', '--config', 'g', '--confirm-closed']).confirmClosed, true);
  for (const args of [['open', '--config', 'g'], ['start'], ['start', '--config', 'g', '--run-id', runId],
    ['run', '--config', 'g', '--config', 'g'], ['run', '--config', 'g', '--run-id', 'unsafe']]) {
    assert.throws(() => parseGroupArgs(args), { code: 'CONFIG_INVALID' });
  }
});

test('detached start uses hidden process, discarded output, exact config and one run ID', async t => {
  const { group } = await fixture(t);
  let spawnCount = 0, args, options;
  const child = new EventEmitter();
  child.pid = 12345;
  child.unref = () => {};
  const result = await startGroup(group, {
    validateGroup: configs => { assert.equal(configs, group.configs); },
    readJson: async () => null,
    spawn: (_node, passedArgs, passedOptions) => { spawnCount++; args = passedArgs; options = passedOptions; return child; },
    pidAlive: () => true,
    groupStatus: async () => ({ phase: 'running', runId: args.at(-1), pid: child.pid }),
  });
  assert.equal(spawnCount, 1);
  assert.deepEqual(args.slice(1, 4), ['run', '--config', group.configPath]);
  assert.equal(args[4], '--run-id');
  assert.equal(result.runId, args[5]);
  assert.deepEqual(options, { cwd: group.repoDir, detached: true, windowsHide: true, stdio: 'ignore' });
});

test('validation and global lock reject before spawning; delayed startup never creates a replacement', async t => {
  const { group } = await fixture(t);
  let spawns = 0;
  const spawn = () => { spawns++; return { pid: 12345, on() {}, unref() {} }; };
  await assert.rejects(startGroup(group, {
    validateGroup: () => { throw new WorkerError('CONFIG_INVALID'); }, spawn,
  }), { code: 'CONFIG_INVALID' });
  await assert.rejects(startGroup(group, {
    validateGroup: () => {}, spawn, readJson: async () => ({ pid: 123 }), pidAlive: () => true,
  }), { code: 'WORKER_ALREADY_RUNNING' });
  assert.equal(spawns, 0);
  const result = await startGroup(group, {
    validateGroup: () => {}, spawn, readJson: async () => null, pidAlive: () => true,
    groupStatus: async () => ({ phase: 'not_started' }), sleep: async () => {},
  });
  assert.equal(result.phase, 'starting'); assert.equal(spawns, 1);
});

test('group keeps lease until every member has finished and redacts a rejected member error', async t => {
  const { group } = await fixture(t);
  const finishSecond = deferred();
  const started = deferred();
  let firstRejected = false, secondClosed = false, leaseReleased = false, calls = 0;
  const runId = randomUUID();
  const pending = runGroup(group, {
    withLease: fakeLease(async (_configs, options) => {
      assert.equal(options.runId, runId);
      assert.equal(secondClosed, true);
      leaseReleased = true;
    }),
    runWorker: async (config, _deps, options) => {
      calls++;
      assert.equal(options.runId, runId);
      assert.equal(options.lease.onlyFixture, true);
      if (config.browser === 'edge') { firstRejected = true; throw new Error('wc:private-symKey-secret'); }
      started.resolve();
      await finishSecond.promise;
      secondClosed = true;
      return { phase: 'completed', completed: 2, remaining: 0 };
    },
  }, { runId });
  await started.promise;
  assert.equal(firstRejected, true); assert.equal(leaseReleased, false);
  finishSecond.resolve();
  const result = await pending;
  assert.equal(calls, 2); assert.equal(leaseReleased, true);
  assert.equal(result.phase, 'failed');
  assert.equal(result.workers[0].errorCode, 'RUNNER_FAILED');
  assert.equal(JSON.stringify(result).includes('symKey'), false);
});

test('launch, close and runner receive the same UI coordinator without locking a whole wallet', async t => {
  const { group } = await fixture(t);
  let held = false, launches = 0, closes = 0, factories = 0;
  let queue = Promise.resolve();
  const run = operation => {
    const next = queue.then(async () => {
      assert.equal(held, false); held = true;
      try { return await operation(); } finally { held = false; }
    });
    queue = next.catch(() => {});
    return next;
  };
  await runGroup(group, {
    withLease: fakeLease(),
    coordinator: { run },
    launch: async () => {
      assert.equal(held, true); launches++;
      return { close: async () => { assert.equal(held, true); closes++; } };
    },
    createRunner: options => { factories++; assert.equal(options.withUi, run); return {}; },
    runWorker: async (config, deps) => {
      const browser = await deps.launch(config);
      deps.createRunner({ localPage: {}, nadoPage: {} });
      await browser.close();
      return { phase: 'completed' };
    },
  });
  assert.deepEqual([launches, closes, factories], [2, 2, 2]);
});

test('initial unlock barrier waits for both browsers without focusing; then both proceed', async t => {
  const { group } = await fixture(t);
  const unlocked = [true, false];
  let launched = 0, proceeded = 0, polls = 0;
  const phases = [];
  await runGroup(group, {
    withLease: fakeLease(),
    sleep: async () => { polls++; assert.equal(proceeded, 0); if (launched === 2) unlocked[1] = true; await tick(); },
    launch: async config => {
      const index = group.configs.indexOf(config); launched++;
      return {
        localPage: { getByTestId: name => {
          assert.equal(name, 'connect-wallet-address');
          return { isVisible: async () => unlocked[index] };
        }, bringToFront: () => assert.fail('unlock barrier must not focus a browser') },
        isClosed: () => false, close: async () => {},
      };
    },
    runWorker: async (config, deps) => {
      const browser = await deps.launch(config);
      const ready = await deps.waitForUnlock(config, browser, {
        shouldStop: async () => false, onStage: async phase => { phases.push(phase); },
      });
      assert.equal(ready, true);
      assert.deepEqual(unlocked, [true, true]);
      proceeded++;
      await browser.close();
      return { phase: 'completed' };
    },
  });
  assert.equal(proceeded, 2); assert.ok(polls > 0);
  assert.deepEqual(phases, ['waiting_unlock', 'waiting_unlock']);
});

test('failed launch does not strand an unlocked peer at the startup barrier', async t => {
  const { group } = await fixture(t);
  let proceeded = 0;
  const result = await runGroup(group, {
    withLease: fakeLease(), sleep: tick,
    launch: async config => {
      if (config.browser === 'edge') throw new Error('private launch failure');
      return { localPage: { getByTestId: () => ({ isVisible: async () => true }) }, isClosed: () => false, close: async () => {} };
    },
    runWorker: async (config, deps) => {
      const browser = await deps.launch(config);
      await deps.waitForUnlock(config, browser, { shouldStop: async () => false, onStage: async () => {} });
      proceeded++;
      await browser.close();
      return { phase: 'completed' };
    },
  });
  assert.equal(result.phase, 'failed');
  assert.equal(proceeded, 1);
});

test('closed member at unlock barrier fails safely while healthy member proceeds', async t => {
  const { group } = await fixture(t);
  let proceeded = 0;
  const result = await runGroup(group, {
    withLease: fakeLease(), sleep: tick,
    launch: async config => ({
      localPage: { getByTestId: () => ({ isVisible: async () => {
        if (config.browser === 'edge') throw new Error('closed');
        return true;
      } }) },
      isClosed: () => config.browser === 'edge', close: async () => {},
    }),
    runWorker: async (config, deps) => {
      const browser = await deps.launch(config);
      try {
        await deps.waitForUnlock(config, browser, { shouldStop: async () => false, onStage: async () => {} });
        proceeded++;
        return { phase: 'completed' };
      } finally { await browser.close(); }
    },
  });
  assert.equal(result.phase, 'failed');
  assert.equal(proceeded, 1);
});

test('external stop reaches all six members and unlock barrier promptly', async t => {
  const { group } = await fixture(t, 6);
  let stopped = false, returned = 0;
  const result = await runGroup(group, {
    withLease: fakeLease(), shouldStop: () => stopped,
    sleep: async () => { stopped = true; await tick(); },
    launch: async () => ({
      localPage: { getByTestId: () => ({ isVisible: async () => false }) },
      isClosed: () => false, close: async () => {},
    }),
    runWorker: async (config, deps) => {
      const browser = await deps.launch(config);
      assert.equal(await deps.waitForUnlock(config, browser, { shouldStop: deps.shouldStop, onStage: async () => {} }), false);
      returned++;
      await browser.close();
      return { phase: 'stopped' };
    },
  });
  assert.equal(result.phase, 'stopped'); assert.equal(returned, 6);
});

test('group stop marker covers a member that has not written its own status yet', async t => {
  const { group } = await fixture(t);
  await mkdir(group.stateDir, { recursive: true });
  const runId = randomUUID();
  let requests = 0;
  const result = await stopGroup(group, {
    groupStatus: async () => ({ processAlive: true, runId }),
    requestWorkerStop: async config => {
      requests++;
      assert.equal((await readPublicJson(group.stopPath)).runId, runId);
      if (config.browser === 'chrome') throw new WorkerError('NOT_RUNNING');
      return { phase: 'stop_requested' };
    },
  });
  assert.equal(requests, 2);
  assert.equal(result.workers[1].phase, 'group_stop_requested');
});

test('status is read-only, identifies members, and never exposes unknown raw fields/errors', async t => {
  const { root, group } = await fixture(t);
  const before = await readdir(root);
  const result = await groupStatus(group, {
    readJson: async () => null,
    workerStatus: async config => {
      if (config.browser === 'edge') throw new Error('wc:secret-symKey');
      return { phase: 'waiting_unlock', privateKey: 'never-output', error: new Error('private') };
    },
  });
  assert.equal(result.processAlive, false);
  assert.equal(result.workers[0].profileName, 'fixture-0');
  assert.equal(result.workers[1].browser, 'chrome');
  assert.deepEqual(await readdir(root), before);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.deepEqual(publicWorkerState({ phase: 'wc:unsafe', errorCode: 'raw secret' }), { phase: 'failed', errorCode: 'RUNNER_FAILED' });
  assert.deepEqual(publicWorkerState({ phase: 'waiting_attention', retainedBrowserSafe: true }),
    { phase: 'waiting_attention' });
  const attentionId = randomUUID();
  assert.deepEqual(publicWorkerState({ phase: 'waiting_attention', attentionId, canResumeConnection: true }),
    { phase: 'waiting_attention', attentionId, canResumeConnection: true });
  assert.deepEqual(publicWorkerState({ phase: 'working', attentionId: null, canResumeConnection: false, errorCode: null }),
    { phase: 'working', attentionId: null, canResumeConnection: false });
  assert.deepEqual(publicWorkerState({ phase: 'waiting_attention', attentionId: 'raw private text', canResumeConnection: 'true' }),
    { phase: 'waiting_attention' });
});

test('six members share one runtime lease and UI coordinator with independent ledgers', async t => {
  const { root, group } = await fixture(t, 6);
  const wallets = Array.from({ length: 12 }, (_, index) => ({
    walletNumber: index + 1, address: `0x${(index + 1).toString(16).padStart(40, '0')}`,
  }));
  await writeFile(join(root, 'wallets.json'), JSON.stringify(wallets));
  const visited = [], closed = [], runnerCoordinators = [];
  let activeUiOperations = 0, maxActiveUiOperations = 0;
  const result = await runGroup(group, {
    sleep: tick,
    launch: async config => ({
      localPage: { getByTestId: () => ({ isVisible: async () => true }) }, nadoPage: {},
      isClosed: () => false, close: async () => { closed.push(config.profileName); },
    }),
    createRunner: options => {
      runnerCoordinators.push(options.withUi);
      return {
        runWallet: async number => {
          visited.push(number);
          await options.withUi(async () => {
            activeUiOperations++;
            maxActiveUiOperations = Math.max(maxActiveUiOperations, activeUiOperations);
            await tick();
            activeUiOperations--;
          });
          return {
            walletNumber: number, address: wallets[number - 1].address, username: `demo${number}`,
            status: 'verified_login_and_ink', loginComplete: true, websiteSignedIn: true,
            websiteNetwork: 'Ink', approvedChainId: 57073, agentTransactionsSent: 0,
          };
        },
        cleanup: async () => {},
      };
    },
  });
  assert.equal(result.phase, 'completed');
  assert.deepEqual(visited.toSorted((a, b) => a - b), wallets.map(wallet => wallet.walletNumber));
  assert.equal(new Set(visited).size, 12); assert.equal(closed.length, 6);
  assert.equal(new Set(runnerCoordinators).size, 1);
  assert.equal(maxActiveUiOperations, 1);
  const finalStatus = await groupStatus(group);
  assert.equal(finalStatus.processAlive, false);
  assert.deepEqual(finalStatus.workers.map(member => member.completed), [2, 2, 2, 2, 2, 2]);
  for (const config of group.configs) {
    assert.deepEqual(parseProgress(await readFile(config.progressPath, 'utf8')).map(record => record.walletNumber),
      [config.plan.start, config.plan.end]);
    assert.equal(await readPublicJson(config.profileLockPath, { optional: true }), null);
  }
  assert.equal(await readPublicJson(group.configs[0].globalLockPath, { optional: true }), null);
});

test('one member retains attention while its peer completes; group stop closes without replay', { timeout: 5000 }, async t => {
  const { root, group } = await fixture(t);
  const wallets = Array.from({ length: 4 }, (_, index) => ({
    walletNumber: index + 1, address: `0x${String(index + 1).repeat(40)}`,
  }));
  await writeFile(join(root, 'wallets.json'), JSON.stringify(wallets));
  const peerClosed = deferred();
  const visited = [], closed = [];
  let attentionChecks = 0;
  const result = await runGroup(group, {
    sleep: tick,
    runWorker: (config, deps, options) => runWorker(config, {
      ...deps,
      sleep: async () => {
        assert.equal(config.browser, 'edge');
        await peerClosed.promise;
        const state = await groupStatus(group);
        assert.equal(state.processAlive, true);
        assert.deepEqual(state.workers.map(member => member.phase), ['waiting_attention', 'completed']);
        assert.deepEqual(visited.toSorted((a, b) => a - b), [1, 2, 4]);
        assert.deepEqual(closed, ['fixture-1']);
        assert.notEqual(await readPublicJson(config.profileLockPath, { optional: true }), null);
        assert.notEqual(await readPublicJson(config.globalLockPath, { optional: true }), null);
        assert.equal(await readPublicJson(config.progressPath, { optional: true }), null);
        attentionChecks++;
        await stopGroup(group);
      },
    }, options),
    launch: async config => ({
      localPage: { getByTestId: () => ({ isVisible: async () => true }) }, nadoPage: {},
      isClosed: () => false,
      close: async () => {
        closed.push(config.profileName);
        if (config.browser === 'chrome') peerClosed.resolve();
      },
    }),
    createRunner: () => ({
      runWallet: async number => {
        visited.push(number);
        if (number === 4) throw Object.assign(new WorkerError('NEEDS_ATTENTION'), { retainedBrowserSafe: true });
        return {
          walletNumber: number, address: wallets[number - 1].address, username: `demo${number}`,
          status: 'verified_login_and_ink', loginComplete: true, websiteSignedIn: true,
          websiteNetwork: 'Ink', approvedChainId: 57073, agentTransactionsSent: 0,
        };
      },
      cleanup: async () => {},
    }),
  });
  assert.equal(result.phase, 'stopped');
  assert.equal(attentionChecks, 1);
  assert.deepEqual(result.workers.map(member => member.phase), ['stopped', 'completed']);
  assert.deepEqual(visited.toSorted((a, b) => a - b), [1, 2, 4]);
  assert.deepEqual(closed, ['fixture-1', 'fixture-0']);
  for (const config of group.configs) assert.equal(await readPublicJson(config.profileLockPath, { optional: true }), null);
  assert.equal(await readPublicJson(group.configs[0].globalLockPath, { optional: true }), null);
});

test('single-member connection resume keeps the peer running and reuses the same group coordinator', { timeout: 5000 }, async t => {
  const { root, group } = await fixture(t);
  const wallets = Array.from({ length: 4 }, (_, index) => ({
    walletNumber: index + 1, address: `0x${String(index + 1).repeat(40)}`,
  }));
  await writeFile(join(root, 'wallets.json'), JSON.stringify(wallets));
  const attentionReady = deferred(), peerAdvanced = deferred(), edgeRecovered = deferred();
  const visited = [], launched = [], closed = [], runnerCoordinators = [];
  let resumed = false, requests = 0;
  const result = await runGroup(group, {
    sleep: tick,
    runWorker: (config, deps, options) => runWorker(config, {
      ...deps,
      sleep: async () => {
        assert.equal(config.browser, 'edge');
        attentionReady.resolve();
        await peerAdvanced.promise;
        if (requests) return tick();
        const state = await groupStatus(group);
        assert.deepEqual(state.workers.map(member => member.phase), ['waiting_attention', 'working']);
        assert.equal(state.workers[0].canResumeConnection, true);
        assert.equal(state.workers[1].currentWalletNumber, 1);
        assert.deepEqual(closed, []);
        await requestWorkerResume(config, state.workers[0].attentionId);
        requests++;
      },
    }, options),
    launch: async config => {
      launched.push(config.browser);
      return {
        localPage: { browser: config.browser, getByTestId: () => ({ isVisible: async () => true }) }, nadoPage: {},
        isClosed: () => false, close: async () => { closed.push(config.browser); },
      };
    },
    createRunner: options => {
      runnerCoordinators.push(options.withUi);
      return {
        runWallet: async number => {
          visited.push(number);
          if (number === 4 && !resumed) {
            throw Object.assign(new WorkerError('NEEDS_ATTENTION'), {
              retainedBrowserSafe: true, connectionRecoveryAllowed: true,
              uiState: { siteStage: 'pairing', localStatus: 'disconnected', disconnectReason: 'pair_timeout',
                walletMatches: true, usernameMatches: true, authorizationArmed: false },
            });
          }
          if (number === 2) await attentionReady.promise;
          if (number === 1) { peerAdvanced.resolve(); await edgeRecovered.promise; }
          return {
            walletNumber: number, address: wallets[number - 1].address, username: `demo${number}`,
            status: 'verified_login_and_ink', loginComplete: true, websiteSignedIn: true,
            websiteNetwork: 'Ink', approvedChainId: 57073, agentTransactionsSent: 0,
          };
        },
        recoverConnection: async number => options.withUi(async () => {
          assert.equal(options.localPage.browser, 'edge');
          assert.equal(number, 4);
          assert.equal(resumed, false);
          assert.deepEqual(closed, []);
          resumed = true;
          edgeRecovered.resolve();
          return { walletNumber: number, recovered: true };
        }),
        cleanup: async () => {},
      };
    },
  });
  assert.equal(result.phase, 'completed');
  assert.equal(requests, 1);
  assert.deepEqual(launched.toSorted(), ['chrome', 'edge']);
  assert.equal(runnerCoordinators.length, 2);
  assert.equal(runnerCoordinators[0], runnerCoordinators[1]);
  assert.deepEqual(visited.filter(number => number >= 3), [4, 4, 3]);
  assert.deepEqual(visited.filter(number => number <= 2), [2, 1]);
  assert.deepEqual(closed.toSorted(), ['chrome', 'edge']);
  assert.deepEqual(result.workers.map(member => member.completed), [2, 2]);
});

test('restart CLI requires a named profile and exact member generation', () => {
  const runId = randomUUID();
  assert.deepEqual(parseGroupArgs(['restart-worker', '--config', 'group.json', '--profile', 'registration-edge', '--expected-run-id', runId]),
    { command: 'restart-worker', configPath: 'group.json', profileName: 'registration-edge', expectedRunId: runId });
  for (const args of [
    ['restart-worker', '--config', 'group.json'],
    ['restart-worker', '--config', 'group.json', '--profile', '../edge', '--expected-run-id', runId],
    ['restart-worker', '--config', 'group.json', '--profile', 'edge', '--expected-run-id', 'old'],
    ['restart-worker', '--config', 'group.json', '--profile', 'edge', '--expected-run-id', runId, '--run-id', runId],
    ['stop', '--config', 'group.json', '--profile', 'edge', '--expected-run-id', runId],
  ]) assert.throws(() => parseGroupArgs(args), { code: 'CONFIG_INVALID' });
});

test('restart request rejects old capability, stale identity, unsafe phases and Save journals; duplicates share one identity', async t => {
  const { group } = await fixture(t);
  const config = group.configs[0], groupRunId = randomUUID(), memberRunId = randomUUID();
  const base = { processAlive: true, memberRestartSupported: true, runId: groupRunId,
    workers: [{ profileName: config.profileName, runId: memberRunId, phase: 'working', restartState: 'idle' }] };
  let state = structuredClone(base), attempt = null, stopping = false, writes = 0;
  const files = new Map();
  const deps = {
    groupStatus: async () => state,
    readJson: async path => path === config.attemptPath ? attempt
      : path === group.stopPath ? (stopping ? { runId: groupRunId } : null) : files.get(path) ?? null,
    writeJson: async (path, value) => { writes++; files.set(path, value); },
  };
  state.memberRestartSupported = false;
  await assert.rejects(requestWorkerRestart(group, config.profileName, memberRunId, deps), { code: 'CONFIRMATION_INVALID' });
  state = structuredClone(base);
  await assert.rejects(requestWorkerRestart(group, config.profileName, randomUUID(), deps), { code: 'CONFIRMATION_INVALID' });
  await assert.rejects(requestWorkerRestart(group, 'unknown-profile', memberRunId, deps), { code: 'CONFIG_INVALID' });
  for (const phase of ['completed', 'save_pending', 'waiting_terms', 'waiting_unlock', 'starting']) {
    state.workers[0].phase = phase;
    await assert.rejects(requestWorkerRestart(group, config.profileName, memberRunId, deps), { code: 'CONFIRMATION_INVALID' });
  }
  state = structuredClone(base);
  attempt = { saveAttempted: true };
  await assert.rejects(requestWorkerRestart(group, config.profileName, memberRunId, deps), { code: 'CONFIRMATION_INVALID' });
  attempt = null; stopping = true;
  await assert.rejects(requestWorkerRestart(group, config.profileName, memberRunId, deps), { code: 'NOT_RUNNING' });
  stopping = false;
  const first = await requestWorkerRestart(group, config.profileName, memberRunId, deps);
  state.workers[0].restartState = 'requested';
  const second = await requestWorkerRestart(group, config.profileName, memberRunId, deps);
  assert.equal(second.requestId, first.requestId);
  assert.equal(writes, 1);
  state.workers[0].restartState = 'blocked';
  await assert.rejects(requestWorkerRestart(group, config.profileName, memberRunId, deps), { code: 'CONFIRMATION_INVALID' });
});

test('explicit restart finishes the current wallet, only replaces its own browser and ignores the old request', { timeout: 10000 }, async t => {
  const { root, group, onCleanup } = await fixture(t);
  const verified = await writeWalletFixture(root);
  const firstWallet = deferred(), finishFirst = deferred(), peerReady = deferred(), finishPeer = deferred();
  const restartedWallet = deferred(), finishRestarted = deferred(), closingOld = deferred(), finishClose = deferred();
  const visits = [], launches = [], closes = [], results = [];
  const task = runGroup(group, {
    controlPollMs: 5, sleep: tick,
    runWorker: async (...args) => {
      const result = await runWorker(...args);
      results.push({ profile: args[0].profileName, ...result });
      return result;
    },
    launch: async config => {
      launches.push(config.profileName);
      return { localPage: { profile: config.profileName, getByTestId: () => ({ isVisible: async () => true }) }, nadoPage: {},
        isClosed: () => false, close: async () => {
          closes.push(config.profileName);
          if (config === group.configs[0] && closes.filter(name => name === config.profileName).length === 1) {
            closingOld.resolve(); await finishClose.promise;
          }
        } };
    },
    createRunner: options => ({
      runWallet: async number => {
        visits.push(number);
        if (number === 4) {
          firstWallet.resolve(); await finishFirst.promise;
          await options.onEvent({ stage: 'save_pending', walletNumber: number, address: verified(number).address,
            username: `demo${number}`, saveAttempted: true });
        }
        if (number === 2) { peerReady.resolve(); await finishPeer.promise; }
        if (number === 3) { restartedWallet.resolve(); await finishRestarted.promise; }
        return verified(number);
      },
      cleanup: async () => {},
    }),
  });
  onCleanup(async () => {
    finishFirst.resolve(); finishPeer.resolve(); finishRestarted.resolve(); finishClose.resolve();
    await stopGroup(group).catch(() => {});
    await task;
  });
  await Promise.all([firstWallet.promise, peerReady.promise]);
  const before = await groupStatus(group);
  const oldRunId = before.workers[0].runId;
  assert.equal(before.memberRestartSupported, true);
  const request = await requestWorkerRestart(group, group.configs[0].profileName, oldRunId);
  const duplicate = await requestWorkerRestart(group, group.configs[0].profileName, oldRunId);
  assert.equal(request.requestId, duplicate.requestId);
  await until(async () => (await groupStatus(group)).workers[0].restartState === 'stopping');
  assert.equal(launches.length, 2);
  finishFirst.resolve();
  await closingOld.promise;
  assert.equal(launches.length, 2, 'old close must settle before replacement launch');
  finishClose.resolve();
  await restartedWallet.promise;
  const after = await groupStatus(group);
  assert.notEqual(after.workers[0].runId, oldRunId);
  assert.equal(after.workers[1].runId, before.workers[1].runId);
  assert.equal(after.workers[0].restartCount, 1);
  assert.equal(after.workers[0].restartState, 'restarted');
  assert.equal(after.workers[0].previousRunId, oldRunId);
  assert.equal(after.workers[0].restartRunId, after.workers[0].runId);
  assert.equal(after.workers[0].restartRequestId, request.requestId);
  assert.equal(launches.filter(name => name === group.configs[0].profileName).length, 2);
  assert.equal(launches.filter(name => name === group.configs[1].profileName).length, 1);
  assert.deepEqual(closes, [group.configs[0].profileName]);
  await assert.rejects(requestWorkerRestart(group, group.configs[0].profileName, oldRunId), { code: 'CONFIRMATION_INVALID' });
  finishPeer.resolve();
  await until(async () => {
    const peer = (await groupStatus(group)).workers[1];
    assert.notEqual(peer.phase, 'failed', JSON.stringify(peer));
    assert.notEqual(peer.phase, 'stopped', JSON.stringify(peer));
    return peer.phase === 'completed';
  }).catch(async () => {
    throw new Error(JSON.stringify({ state: await groupStatus(group), visits, launches, closes, results }));
  });
  assert.equal(visits.filter(number => number === 4).length, 1);
  finishRestarted.resolve();
  const result = await task;
  assert.equal(result.phase, 'completed');
  assert.deepEqual(visits.toSorted(), [1, 2, 3, 4]);
  assert.equal(result.workers[0].restartCount, 1);
  assert.deepEqual(parseProgress(await readFile(group.configs[0].progressPath, 'utf8')).map(row => row.walletNumber), [4, 3]);
  for (const config of group.configs) assert.equal(await readPublicJson(config.profileLockPath, { optional: true }), null);
  assert.equal(await readPublicJson(group.configs[0].globalLockPath, { optional: true }), null);
});

test('group stop while rearm is pending cancels the request without launching a replacement', { timeout: 10000 }, async t => {
  const { root, group, onCleanup } = await fixture(t);
  const verified = await writeWalletFixture(root);
  const ready = deferred(), finishWallet = deferred(), rearming = deferred(), releaseRearm = deferred(), finishPeer = deferred();
  let launches = 0;
  const task = runGroup(group, {
    controlPollMs: 5, sleep: tick,
    rearmWorker: async (config, lease, runId) => {
      const nextRunId = await rearmWorkerGroupMember(config, lease, runId);
      rearming.resolve(); await releaseRearm.promise; return nextRunId;
    },
    launch: async () => {
      launches++;
      return { localPage: { getByTestId: () => ({ isVisible: async () => true }) }, nadoPage: {},
        isClosed: () => false, close: async () => {} };
    },
    createRunner: () => ({
      runWallet: async number => {
        if (number === 4) { ready.resolve(); await finishWallet.promise; }
        if (number === 2) await finishPeer.promise;
        return verified(number);
      }, cleanup: async () => {},
    }),
  });
  onCleanup(async () => {
    finishWallet.resolve(); releaseRearm.resolve(); finishPeer.resolve();
    await stopGroup(group).catch(() => {});
    await task;
  });
  await ready.promise;
  const before = await groupStatus(group);
  await requestWorkerRestart(group, group.configs[0].profileName, before.workers[0].runId);
  await until(async () => (await groupStatus(group)).workers[0].restartState === 'stopping');
  finishWallet.resolve();
  await rearming.promise;
  await stopGroup(group);
  releaseRearm.resolve(); finishPeer.resolve();
  const result = await task;
  assert.equal(result.phase, 'stopped');
  assert.equal(launches, 2);
  assert.equal(result.workers[0].restartState, 'cancelled');
  assert.equal(result.workers[0].restartCount, 0);
  assert.equal(await readPublicJson(group.configs[0].globalLockPath, { optional: true }), null);
});

for (const blocker of ['attempt', 'close']) test(`restart cannot replay after ${blocker} prevents safe rearm`, { timeout: 10000 }, async t => {
  const { root, group, onCleanup } = await fixture(t);
  const verified = await writeWalletFixture(root);
  const ready = deferred(), finishWallet = deferred(), finishPeer = deferred();
  const launches = [], visits = [];
  const task = runGroup(group, {
    controlPollMs: 5, sleep: tick,
    launch: async config => {
      launches.push(config.profileName);
      return { localPage: { profile: config.profileName, getByTestId: () => ({ isVisible: async () => true }) }, nadoPage: {},
        isClosed: () => false, close: async () => {
          if (blocker === 'close' && config === group.configs[0]) throw new Error('PRIVATE_CLOSE_FAILURE');
        } };
    },
    createRunner: () => ({
      runWallet: async number => {
        visits.push(number);
        if (number === 4) {
          ready.resolve(); await finishWallet.promise;
          if (blocker === 'attempt') {
            await atomicWriteJson(group.configs[0].attemptPath, {
              walletNumber: number, address: verified(number).address, username: `demo${number}`, saveAttempted: true,
            });
            throw new WorkerError('NEEDS_ATTENTION');
          }
        }
        if (number === 2) await finishPeer.promise;
        return verified(number);
      }, cleanup: async () => {},
    }),
  });
  onCleanup(async () => {
    finishWallet.resolve(); finishPeer.resolve();
    await stopGroup(group).catch(() => {});
    await task;
  });
  await ready.promise;
  const before = await groupStatus(group);
  await requestWorkerRestart(group, group.configs[0].profileName, before.workers[0].runId);
  await until(async () => (await groupStatus(group)).workers[0].restartState === 'stopping');
  finishWallet.resolve();
  await until(async () => (await groupStatus(group)).workers[0].restartState === 'blocked');
  const blocked = await groupStatus(group);
  assert.equal(blocked.workers[0].restartErrorCode, blocker === 'attempt' ? 'NEEDS_ATTENTION' : 'BROWSER_CLOSED');
  assert.equal(blocked.workers[0].restartCount, 0);
  assert.equal(blocked.workers[1].phase, 'working');
  assert.equal(launches.length, 2);
  assert.equal(JSON.stringify(blocked).includes('PRIVATE_CLOSE_FAILURE'), false);
  finishPeer.resolve();
  const result = await task;
  assert.equal(result.phase, 'failed');
  assert.equal(visits.includes(3), false);
  assert.equal(launches.length, 2);
  if (blocker === 'attempt') assert.notEqual(await readPublicJson(group.configs[0].attemptPath, { optional: true }), null);
  else assert.notEqual(await readPublicJson(group.configs[0].profileLockPath, { optional: true }), null);
});

test('a malformed member restart file blocks only that request while every wallet can finish', { timeout: 10000 }, async t => {
  const { root, group, onCleanup } = await fixture(t);
  const verified = await writeWalletFixture(root), release = deferred();
  const visits = [], launches = [];
  const task = runGroup(group, {
    controlPollMs: 5, sleep: tick,
    launch: async config => {
      launches.push(config.profileName);
      return { localPage: { getByTestId: () => ({ isVisible: async () => true }) }, nadoPage: {},
        isClosed: () => false, close: async () => {} };
    },
    createRunner: () => ({
      runWallet: async number => { visits.push(number); await release.promise; return verified(number); },
      cleanup: async () => {},
    }),
  });
  onCleanup(async () => {
    release.resolve();
    await stopGroup(group).catch(() => {});
    await task;
  });
  await until(() => visits.length === 2);
  await writeFile(join(group.stateDir, `restart-${group.configs[0].profileName}.json`), '{broken request');
  await until(async () => (await groupStatus(group)).workers[0].restartState === 'blocked');
  const state = await groupStatus(group);
  assert.equal(state.workers[0].restartErrorCode, 'PUBLIC_FILE_INVALID');
  assert.deepEqual(state.workers.map(member => member.phase), ['working', 'working']);
  assert.equal(await readPublicJson(group.stopPath, { optional: true }), null);
  release.resolve();
  const result = await task;
  assert.equal(result.phase, 'completed');
  assert.deepEqual(visits.toSorted(), [1, 2, 3, 4]);
  assert.equal(launches.length, 2);
});

test('two explicit member restarts serialize only rearm transactions and leave a third member running', { timeout: 10000 }, async t => {
  const { root, group, onCleanup } = await fixture(t, 3);
  const verified = await writeWalletFixture(root, 6);
  const oldReady = new Set(), newReady = new Set();
  const finishOld = deferred(), finishNew = deferred(), finishPeer = deferred();
  const launches = [], visits = [], closed = [];
  let rearmActive = 0, maxRearmActive = 0;
  const task = runGroup(group, {
    controlPollMs: 5, sleep: tick,
    rearmWorker: async (...args) => {
      rearmActive++; maxRearmActive = Math.max(maxRearmActive, rearmActive);
      try {
        await new Promise(resolveWait => setTimeout(resolveWait, 10));
        return await rearmWorkerGroupMember(...args);
      } finally { rearmActive--; }
    },
    launch: async config => {
      launches.push(config.profileName);
      return { localPage: { getByTestId: () => ({ isVisible: async () => true }) }, nadoPage: {},
        isClosed: () => false, close: async () => { closed.push(config.profileName); } };
    },
    createRunner: () => ({
      runWallet: async number => {
        visits.push(number);
        if (number === 6 || number === 4) { oldReady.add(number); await finishOld.promise; }
        if (number === 5 || number === 3) { newReady.add(number); await finishNew.promise; }
        if (number === 2) { oldReady.add(number); await finishPeer.promise; }
        return verified(number);
      }, cleanup: async () => {},
    }),
  });
  onCleanup(async () => {
    finishOld.resolve(); finishNew.resolve(); finishPeer.resolve();
    await stopGroup(group).catch(() => {});
    await task;
  });
  await until(() => oldReady.size === 3);
  const before = await groupStatus(group);
  await Promise.all(group.configs.slice(0, 2).map((config, index) =>
    requestWorkerRestart(group, config.profileName, before.workers[index].runId)));
  await until(async () => (await groupStatus(group)).workers.slice(0, 2).every(member => member.restartState === 'stopping'));
  finishOld.resolve();
  await until(() => newReady.size === 2);
  const restarted = await groupStatus(group);
  assert.equal(maxRearmActive, 1);
  assert.deepEqual(restarted.workers.map(member => member.restartCount), [1, 1, 0]);
  assert.equal(restarted.workers[2].runId, before.workers[2].runId);
  assert.equal(launches.filter(name => name === group.configs[2].profileName).length, 1);
  assert.equal(closed.includes(group.configs[2].profileName), false);
  finishPeer.resolve();
  await until(() => closed.includes(group.configs[2].profileName));
  assert.equal((await groupStatus(group)).workers[2].phase, 'completed');
  finishNew.resolve();
  const result = await task;
  assert.equal(result.phase, 'completed');
  assert.deepEqual(visits.toSorted(), [1, 2, 3, 4, 5, 6]);
  assert.equal(launches.length, 5);
});

test('a restarted member waiting for unlock does not pull healthy peers into the initial barrier', { timeout: 10000 }, async t => {
  const { root, group, onCleanup } = await fixture(t);
  const verified = await writeWalletFixture(root);
  const ready = new Set(), finishOld = deferred(), finishPeer = deferred();
  const launches = [], visits = [], closed = [];
  const task = runGroup(group, {
    controlPollMs: 5, sleep: tick,
    launch: async config => {
      launches.push(config.profileName);
      const unlocked = config !== group.configs[0] || launches.filter(name => name === config.profileName).length === 1;
      return { localPage: { getByTestId: () => ({ isVisible: async () => unlocked }),
        bringToFront: () => assert.fail('unlock wait must not focus the restarted browser') }, nadoPage: {},
        isClosed: () => false, close: async () => { closed.push(config.profileName); } };
    },
    createRunner: () => ({
      runWallet: async number => {
        visits.push(number);
        if (number === 4) { ready.add(number); await finishOld.promise; }
        if (number === 2) { ready.add(number); await finishPeer.promise; }
        return verified(number);
      }, cleanup: async () => {},
    }),
  });
  onCleanup(async () => {
    finishOld.resolve(); finishPeer.resolve();
    await stopGroup(group).catch(() => {});
    await task;
  });
  await until(() => ready.size === 2);
  const before = await groupStatus(group);
  await requestWorkerRestart(group, group.configs[0].profileName, before.workers[0].runId);
  await until(async () => (await groupStatus(group)).workers[0].restartState === 'stopping');
  finishOld.resolve();
  await until(async () => (await groupStatus(group)).workers[0].restartState === 'waiting_unlock');
  finishPeer.resolve();
  await until(() => closed.includes(group.configs[1].profileName));
  const paused = await groupStatus(group);
  assert.equal(paused.workers[0].phase, 'waiting_unlock');
  assert.equal(paused.workers[1].phase, 'completed');
  assert.equal(paused.workers[1].runId, before.workers[1].runId);
  assert.equal(visits.includes(3), false);
  await assert.rejects(requestWorkerRestart(group, group.configs[0].profileName, paused.workers[0].runId),
    { code: 'CONFIRMATION_INVALID' });
  await stopGroup(group);
  const result = await task;
  assert.equal(result.phase, 'stopped');
  assert.equal(launches.length, 3);
});
