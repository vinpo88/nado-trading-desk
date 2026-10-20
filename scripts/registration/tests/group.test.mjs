import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  parseGroupArgs, loadGroupConfig, groupStatus, stopGroup, runGroup, startGroup, publicWorkerState,
} from '../group.mjs';
import { readPublicJson, runWorker, WorkerError } from '../runtime.mjs';

const tick = () => new Promise(resolveWait => setImmediate(resolveWait));
function deferred() {
  let resolveWait;
  const promise = new Promise(resolvePromise => { resolveWait = resolvePromise; });
  return { promise, resolve: resolveWait };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nado-group-test-'));
  t.after(async () => {
    const checked = resolve(root);
    assert.equal(checked.startsWith(resolve(tmpdir()) + '\\nado-group-test-')
      || checked.startsWith(resolve(tmpdir()) + '/nado-group-test-'), true);
    await rm(checked, { recursive: true, force: true });
  });
  const files = ['edge.json', 'chrome.json'];
  for (const [index, name] of files.entries()) await writeFile(join(root, name), JSON.stringify({
    browser: index ? 'chrome' : 'edge', profileName: `fixture-${index}`,
    bounds: { min: 1, max: 4 }, start: index ? 2 : 4, end: index ? 1 : 3,
    walletsPath: 'wallets.json', progressPath: `progress-${index}.ndjson`,
  }));
  const configPath = join(root, 'group.json');
  await writeFile(configPath, JSON.stringify({ workerConfigs: files }));
  const group = await loadGroupConfig(configPath, { repoDir: root });
  for (const config of group.configs) config.globalLockPath = join(root, 'isolated-global.lock');
  return { root, group };
}
function fakeLease(onExit = () => {}) {
  return async (configs, callback, options) => {
    const lease = { onlyFixture: true };
    try { return await callback(lease); }
    finally { await onExit(configs, options); }
  };
}

test('group requires 2–4 explicitly listed configs and resolves members against group file', async t => {
  const { root, group } = await fixture(t);
  assert.deepEqual(group.workerConfigs, [join(root, 'edge.json'), join(root, 'chrome.json')]);
  assert.equal(group.configs[1].browser, 'chrome');
  for (const raw of [
    {}, { workerConfigs: [] }, { workerConfigs: ['edge.json'] },
    { workerConfigs: ['edge.json', './edge.json'] },
    { workerConfigs: ['edge.json', 'chrome.json'], parallel: true },
    { workerConfigs: Array(5).fill('edge.json') },
  ]) {
    await writeFile(group.configPath, JSON.stringify(raw));
    await assert.rejects(loadGroupConfig(group.configPath, { repoDir: root }), { code: 'CONFIG_INVALID' });
  }
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

test('external stop reaches every member and unlock barrier promptly', async t => {
  const { group } = await fixture(t);
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
  assert.equal(result.phase, 'stopped'); assert.equal(returned, 2);
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
});

test('group integrates with real runtime lease and independent ledgers using only synthetic browsers', async t => {
  const { root, group } = await fixture(t);
  const wallets = Array.from({ length: 4 }, (_, index) => ({
    walletNumber: index + 1, address: `0x${String(index + 1).repeat(40)}`,
  }));
  await writeFile(join(root, 'wallets.json'), JSON.stringify(wallets));
  const visited = [], closed = [];
  const result = await runGroup(group, {
    sleep: tick,
    launch: async config => ({
      localPage: { getByTestId: () => ({ isVisible: async () => true }) }, nadoPage: {},
      isClosed: () => false, close: async () => { closed.push(config.profileName); },
    }),
    createRunner: options => ({
      runWallet: async number => {
        visited.push(number);
        assert.equal(typeof options.withUi, 'function');
        return {
          walletNumber: number, address: wallets[number - 1].address, username: `ybtl${number}`,
          status: 'verified_login_and_ink', loginComplete: true, websiteSignedIn: true,
          websiteNetwork: 'Ink', approvedChainId: 57073, agentTransactionsSent: 0,
        };
      },
      cleanup: async () => {},
    }),
  });
  assert.equal(result.phase, 'completed');
  assert.deepEqual(visited.toSorted((a, b) => a - b), [1, 2, 3, 4]);
  assert.equal(new Set(visited).size, 4); assert.equal(closed.length, 2);
  const finalStatus = await groupStatus(group);
  assert.equal(finalStatus.processAlive, false);
  assert.deepEqual(finalStatus.workers.map(member => member.completed), [2, 2]);
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
          walletNumber: number, address: wallets[number - 1].address, username: `ybtl${number}`,
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
