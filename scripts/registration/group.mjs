#!/usr/bin/env node
// One Node process owns every member and its shared UI/clipboard coordinator.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as runtime from './runtime.mjs';
import { launchDedicatedBrowser, prepareManifestFromVisibleUi } from './worker.mjs';
import { createPlaywrightNadoRunner } from './playwright-runner.mjs';
import { createUiCoordinator } from './ui-coordinator.mjs';
import { sanitizeUiObservation } from './ui-diagnostics.mjs';

const ENTRY = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(ENTRY), '../..');
const delay = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const print = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const PHASES = new Set(['not_started', 'starting', 'running', 'setup_browser', 'waiting_manifest', 'waiting_unlock',
  'waiting_manifest_export', 'exporting_manifest', 'working', 'save_pending', 'waiting_terms', 'waiting_connection', 'waiting_attention', 'completed', 'stopped', 'failed']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HELP = `本地并发注册组（同一个 Node 进程，独立的专用浏览器）
node scripts/registration/group.mjs start|run|status|stop --config GROUP.json
node scripts/registration/group.mjs recover-locks --config GROUP.json --confirm-closed
组配置只含 workerConfigs，必须明确列出 2–4 个独立执行器配置文件。
成员路径相对于组配置文件；不得重叠钱包范围、复用 profile 或进度输出。
start：隐藏后台进程并显示专用浏览器；run：前台运行。
status：只读各成员进度；stop：所有成员完成当前钱包并保存后停止。
等待解锁、条款或人工检查时及时停止。waiting_attention 会保留已安全断开的浏览器，供人工检查，不会自动重试。
条款仍需逐成员通过 worker accept-terms 明确确认。`;
const fail = code => { throw new runtime.WorkerError(code); };

export function parseGroupArgs(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) return { help: true };
  const command = args[0];
  if (!['start', 'run', 'status', 'stop', 'recover-locks'].includes(command)) fail('CONFIG_INVALID');
  const options = { command };
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--confirm-closed' && command === 'recover-locks' && !options.confirmClosed) { options.confirmClosed = true; continue; }
    if (!['--config', '--run-id'].includes(flag) || !args[index + 1] || args[index + 1].startsWith('--')) fail('CONFIG_INVALID');
    const key = flag === '--run-id' ? 'runId' : 'configPath';
    if (options[key] !== undefined) fail('CONFIG_INVALID');
    options[key] = args[++index];
  }
  if (!options.configPath || (options.runId !== undefined && (command !== 'run' || !UUID.test(options.runId)))) fail('CONFIG_INVALID');
  return options;
}

export async function loadGroupConfig(path, { repoDir = REPO, readJson = runtime.readPublicJson, loadConfig = runtime.loadWorkerConfig } = {}) {
  const configPath = resolve(path);
  const raw = await readJson(configPath);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'workerConfigs')
    || !Array.isArray(raw.workerConfigs) || raw.workerConfigs.length < 2 || raw.workerConfigs.length > 4
    || raw.workerConfigs.some(value => typeof value !== 'string' || !value.trim() || value.includes('\0'))) fail('CONFIG_INVALID');
  const workerConfigs = raw.workerConfigs.map(value => resolve(dirname(configPath), value));
  const canonical = path => process.platform === 'win32' ? path.toLowerCase() : path;
  if (new Set(workerConfigs.map(canonical)).size !== workerConfigs.length) fail('CONFIG_INVALID');
  const results = await Promise.allSettled(workerConfigs.map(member => loadConfig(member, repoDir)));
  if (results.some(result => result.status === 'rejected')) fail('CONFIG_INVALID');
  const configs = results.map(result => result.value);
  const hash = createHash('sha256').update(canonical(configPath)).digest('hex').slice(0, 16);
  const stateDir = join(resolve(repoDir), '.local', 'registration-group', hash);
  return { configPath, workerConfigs, configs, repoDir: resolve(repoDir), stateDir,
    statusPath: join(stateDir, 'status.json'), stopPath: join(stateDir, 'stop.json') };
}

// Only known public fields are returned, even if an on-disk status was edited.
export function publicWorkerState(raw) {
  const state = { phase: PHASES.has(raw?.phase) ? raw.phase : 'failed' };
  if (raw?.formatVersion === 1) state.formatVersion = 1;
  for (const key of ['pid', 'total', 'completed', 'remaining', 'heartbeatAgeSeconds']) {
    if (Number.isSafeInteger(raw?.[key]) && raw[key] >= 0) state[key] = raw[key];
  }
  for (const key of ['currentWalletNumber', 'lastCompletedWalletNumber']) {
    if (raw?.[key] === null || (Number.isSafeInteger(raw?.[key]) && raw[key] > 0)) state[key] = raw[key];
  }
  if (UUID.test(raw?.runId ?? '')) state.runId = raw.runId;
  if (raw?.attentionId === null || UUID.test(raw?.attentionId ?? '')) state.attentionId = raw.attentionId;
  if (typeof raw?.canResumeConnection === 'boolean') state.canResumeConnection = raw.canResumeConnection;
  if (typeof raw?.processAlive === 'boolean') state.processAlive = raw.processAlive;
  for (const key of ['startedAt', 'updatedAt', 'waitingSince']) {
    if (typeof raw?.[key] === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(raw[key]) && Number.isFinite(Date.parse(raw[key]))) state[key] = raw[key];
  }
  if (typeof raw?.stage === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(raw.stage)) state.stage = raw.stage;
  const uiState = sanitizeUiObservation(raw?.uiState);
  if (Object.keys(uiState).length) state.uiState = uiState;
  if (/^[a-f0-9]{64}$/.test(raw?.termsDigest ?? '')) state.termsDigest = raw.termsDigest;
  if (raw?.errorCode !== undefined && raw?.errorCode !== null) state.errorCode = runtime.safeErrorCode({ code: raw.errorCode });
  return state;
}
const memberState = (config, state) => ({ configPath: config.configPath, profileName: config.profileName, browser: config.browser, ...publicWorkerState(state) });
const rejectedState = reason => ({ phase: 'failed', errorCode: runtime.safeErrorCode(reason) });

export async function groupStatus(group, dependencies = {}) {
  const read = dependencies.readJson ?? runtime.readPublicJson;
  const status = dependencies.workerStatus ?? runtime.workerStatus;
  const alive = dependencies.pidAlive ?? runtime.pidAlive;
  const [savedResult, lockResult, ...results] = await Promise.allSettled([
    read(group.statusPath, { optional: true }), read(group.configs[0].globalLockPath, { optional: true }),
    ...group.configs.map(config => status(config)),
  ]);
  const saved = savedResult.status === 'fulfilled' ? savedResult.value : null;
  const lock = lockResult.status === 'fulfilled' ? lockResult.value : null;
  const state = saved ? publicWorkerState(saved) : { phase: 'not_started' };
  const processAlive = Boolean(state.pid && lock?.pid === state.pid && lock?.runId === state.runId && alive(state.pid));
  const workers = results.map((result, index) => memberState(group.configs[index],
    result.status === 'fulfilled' ? result.value : rejectedState(result.reason)));
  const errorCode = savedResult.status === 'rejected' || lockResult.status === 'rejected' ? 'PUBLIC_FILE_INVALID' : undefined;
  return { configPath: group.configPath, ...state, processAlive, ...(errorCode ? { errorCode } : {}), workers };
}

export async function stopGroup(group, dependencies = {}) {
  const status = await (dependencies.groupStatus ?? groupStatus)(group, dependencies);
  if (!status.processAlive || !status.runId) fail('NOT_RUNNING');
  // Group marker covers members still starting before their profile status exists.
  await (dependencies.writeJson ?? runtime.atomicWriteJson)(group.stopPath, { runId: status.runId, requestedAt: new Date().toISOString() });
  const stop = dependencies.requestWorkerStop ?? runtime.requestWorkerStop;
  const results = await Promise.allSettled(group.configs.map(config => stop(config)));
  const workers = results.map((result, index) => ({
    configPath: group.configs[index].configPath,
    profileName: group.configs[index].profileName,
    phase: result.status === 'fulfilled' ? 'stop_requested' : 'group_stop_requested',
    ...(result.status === 'rejected' && result.reason?.code !== 'NOT_RUNNING' ? { errorCode: runtime.safeErrorCode(result.reason) } : {}),
  }));
  return { phase: 'stop_requested', runId: status.runId, workers };
}

export async function runGroup(group, dependencies = {}, { runId = randomUUID() } = {}) {
  if (!UUID.test(runId)) fail('CONFIG_INVALID');
  const withLease = dependencies.withLease ?? runtime.withWorkerGroupLease;
  if (typeof withLease !== 'function') fail('CONFIG_INVALID');
  const execute = dependencies.runWorker ?? runtime.runWorker;
  const coordinator = dependencies.coordinator ?? createUiCoordinator();
  const launch = dependencies.launch ?? launchDedicatedBrowser;
  const prepareManifest = dependencies.prepareManifest ?? prepareManifestFromVisibleUi;
  const createRunner = dependencies.createRunner ?? createPlaywrightNadoRunner;
  const read = dependencies.readJson ?? runtime.readPublicJson;
  const write = dependencies.writeJson ?? runtime.atomicWriteJson;
  let stop = false, timer;
  const slots = group.configs.map(() => ({ browser: null, waiting: false, finished: false, abandoned: false }));
  const wait = dependencies.sleep ?? delay;
  let state = { formatVersion: 1, pid: process.pid, runId, phase: 'starting',
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const update = async patch => {
    state = { ...state, ...patch, updatedAt: new Date().toISOString() };
    await write(group.statusPath, state);
  };
  return withLease(group.configs, async lease => {
    await (dependencies.ensureDirectory ?? runtime.ensureOwnedDirectory)(group.repoDir, group.stateDir);
    await update({ phase: 'running' });
    const pollStop = async () => {
      try {
        if (dependencies.shouldStop?.()) stop = true;
        const request = await read(group.stopPath, { optional: true });
        if (request?.runId === runId) stop = true;
      } catch { stop = true; } // Corrupt control state fails closed.
    };
    await pollStop();
    timer = setInterval(() => { void pollStop(); }, 250);
    timer.unref?.();
    try {
      const results = await Promise.allSettled(group.configs.map(async (config, index) => {
        const slot = slots[index];
        try {
          return await execute(config, {
            launch: async currentConfig => coordinator.run(async () => {
              const browser = await launch(currentConfig);
              slot.browser = browser;
              return { ...browser, close: () => coordinator.run(() => browser.close()) };
            }),
            prepareManifest,
            waitForUnlock: async (_config, browser, { shouldStop, onStage }) => {
              slot.waiting = true;
              await onStage('waiting_unlock');
              try {
                while (true) {
                  if (stop || await shouldStop()) { slot.abandoned = true; return false; }
                  if (browser.isClosed?.()) { slot.abandoned = true; fail('BROWSER_CLOSED'); }
                  // Merely inspect visibility. Do not focus either browser while
                  // the owner is restoring or typing a vault password.
                  const active = slots.filter(member => !member.finished && !member.abandoned);
                  if (active.every(member => member.browser && member.waiting)) {
                    const visible = await Promise.all(active.map(async member => {
                      try { return await member.browser.localPage.getByTestId('connect-wallet-address').isVisible(); }
                      catch { member.abandoned = true; return false; }
                    }));
                    if (slot.abandoned) fail('BROWSER_CLOSED');
                    if (active.every((member, memberIndex) => member.abandoned || visible[memberIndex])) return true;
                  }
                  await wait(250);
                }
              } catch {
                slot.abandoned = true;
                fail(browser.isClosed?.() ? 'BROWSER_CLOSED' : 'NEEDS_ATTENTION');
              }
            },
            createRunner: options => createRunner({ ...options, withUi: coordinator.run }),
            shouldStop: () => stop || Boolean(dependencies.shouldStop?.()),
          }, { lease, runId });
        } finally {
          // Failed startup and already-completed plans must not strand peers at
          // the initial unlock barrier.
          slot.finished = true;
        }
      }));
      const workers = results.map((result, index) => memberState(group.configs[index],
        result.status === 'fulfilled' ? result.value : rejectedState(result.reason)));
      const failed = workers.some(worker => worker.phase === 'failed');
      const stopped = stop || workers.some(worker => worker.phase === 'stopped');
      await update({ phase: failed ? 'failed' : stopped ? 'stopped' : 'completed' });
      return { ...publicWorkerState(state), workers };
    } finally {
      clearInterval(timer);
      // withLease releases only after every runWorker has closed its own context.
    }
  }, { runId });
}

export async function startGroup(group, dependencies = {}) {
  const read = dependencies.readJson ?? runtime.readPublicJson;
  const alive = dependencies.pidAlive ?? runtime.pidAlive;
  const spawnProcess = dependencies.spawn ?? spawn;
  const wait = dependencies.sleep ?? delay;
  const validate = dependencies.validateGroup ?? runtime.validateWorkerGroup;
  if (typeof validate !== 'function') fail('CONFIG_INVALID');
  await validate(group.configs);
  const lock = await read(group.configs[0].globalLockPath, { optional: true });
  if (lock) fail(alive(lock.pid) ? 'WORKER_ALREADY_RUNNING' : 'WORKER_LOCK_STALE');
  const runId = randomUUID();
  const child = spawnProcess(process.execPath, [ENTRY, 'run', '--config', group.configPath, '--run-id', runId], {
    cwd: group.repoDir, detached: true, windowsHide: true, stdio: 'ignore',
  });
  let failed = false;
  child.on('error', () => { failed = true; });
  child.unref();
  for (let attempt = 0; attempt < 50; attempt++) {
    if (failed) fail('RUNNER_FAILED');
    const state = await (dependencies.groupStatus ?? groupStatus)(group, dependencies);
    if (state.runId === runId) return state;
    if (child.pid && !alive(child.pid)) {
      const owner = await read(group.configs[0].globalLockPath, { optional: true });
      fail(owner ? 'WORKER_ALREADY_RUNNING' : 'RUNNER_FAILED');
    }
    await wait(100);
  }
  // Never start a replacement merely because the first child is slow.
  return { phase: 'starting', pid: child.pid, runId, configPath: group.configPath };
}

export async function runGroupCli(args, output = print, dependencies = {}) {
  const options = parseGroupArgs(args);
  if (options.help) { process.stdout.write(HELP + '\n'); return; }
  const group = await (dependencies.loadConfig ?? loadGroupConfig)(options.configPath);
  if (options.command === 'status') { output(await groupStatus(group, dependencies)); return; }
  if (options.command === 'stop') { output(await stopGroup(group, dependencies)); return; }
  if (options.command === 'start') { output(await startGroup(group, dependencies)); return; }
  if (options.command === 'recover-locks') {
    if (!options.confirmClosed) fail('CONFIRMATION_INVALID');
    const recover = dependencies.recoverLocks ?? runtime.recoverWorkerGroupLocks;
    if (typeof recover !== 'function') fail('CONFIG_INVALID');
    await recover(group.configs, true);
    output({ phase: 'locks_recovered' });
    return;
  }
  let stop = false;
  const onSignal = () => { stop = true; };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    const result = await runGroup(group, { ...dependencies, shouldStop: () => stop || Boolean(dependencies.shouldStop?.()) }, { runId: options.runId });
    output(result);
    if (result.phase === 'failed') process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runGroupCli(process.argv.slice(2)).catch(error => {
    print({ phase: 'failed', errorCode: runtime.safeErrorCode(error), message: '并发组未完成，请检查公开配置、锁和成员状态。未输出原始浏览器异常。' });
    process.exitCode = 1;
  });
}
