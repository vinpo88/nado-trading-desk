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
const PROFILE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RESTARTABLE_PHASES = new Set(['working', 'waiting_connection', 'waiting_attention', 'failed', 'stopped']);
const RESTART_STATES = new Set(['idle', 'requested', 'stopping', 'restarting', 'restarted', 'waiting_unlock', 'blocked', 'cancelled']);
const PENDING_RESTART_STATES = new Set(['requested', 'stopping', 'restarting', 'waiting_unlock']);
const RESTART_KEYS = ['formatVersion', 'groupRunId', 'memberRunId', 'profileName', 'requestId', 'requestedAt'];
const restartPath = (group, config) => join(group.stateDir, `restart-${config.profileName}.json`);
const validRestartRequest = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === RESTART_KEYS.length && RESTART_KEYS.every(key => Object.hasOwn(value, key))
  && value.formatVersion === 1 && UUID.test(value.groupRunId ?? '') && UUID.test(value.memberRunId ?? '')
  && UUID.test(value.requestId ?? '') && PROFILE.test(value.profileName ?? '')
  && typeof value.requestedAt === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value.requestedAt)
  && Number.isFinite(Date.parse(value.requestedAt));
function publicRestartState(raw) {
  const result = {};
  if (Number.isSafeInteger(raw?.restartCount) && raw.restartCount >= 0) result.restartCount = raw.restartCount;
  if (RESTART_STATES.has(raw?.restartState)) result.restartState = raw.restartState;
  for (const key of ['restartRequestId', 'previousRunId', 'restartRunId']) {
    if (UUID.test(raw?.[key] ?? '')) result[key] = raw[key];
  }
  if (raw?.restartErrorCode) result.restartErrorCode = runtime.safeErrorCode({ code: raw.restartErrorCode });
  return result;
}
const HELP = `本地并发注册组（同一个 Node 进程，独立的专用浏览器）
node scripts/registration/group.mjs start|run|status|stop --config GROUP.json
node scripts/registration/group.mjs recover-locks --config GROUP.json --confirm-closed
node scripts/registration/group.mjs restart-worker --config GROUP.json --profile NAME --expected-run-id UUID
组配置只含 workerConfigs，必须明确列出 2–${runtime.MAX_GROUP_WORKERS} 个独立执行器配置文件。
成员路径相对于组配置文件；不得重叠钱包范围、复用 profile 或进度输出。
start：隐藏后台进程并显示专用浏览器；run：前台运行。
status：只读各成员进度；stop：所有成员完成当前钱包并保存后停止。
restart-worker：明确请求单个成员完成当前钱包、关闭后重新启动；其他成员继续。只支持状态明确提供此能力的新进程。
等待解锁、条款或人工检查时及时停止。waiting_attention 会保留已安全断开的浏览器，供人工检查，不会自动重试。
默认逐成员通过 worker accept-terms 明确确认条款；配置 approvedTermsDigest 后，仅内容摘要一致的已批准条款自动确认。`;
const fail = code => { throw new runtime.WorkerError(code); };

export function parseGroupArgs(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) return { help: true };
  const command = args[0];
  if (!['start', 'run', 'status', 'stop', 'recover-locks', 'restart-worker'].includes(command)) fail('CONFIG_INVALID');
  const options = { command };
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--confirm-closed' && command === 'recover-locks' && !options.confirmClosed) { options.confirmClosed = true; continue; }
    if (!['--config', '--run-id', '--profile', '--expected-run-id'].includes(flag) || !args[index + 1] || args[index + 1].startsWith('--')) fail('CONFIG_INVALID');
    const key = ({ '--config': 'configPath', '--run-id': 'runId', '--profile': 'profileName', '--expected-run-id': 'expectedRunId' })[flag];
    if (options[key] !== undefined) fail('CONFIG_INVALID');
    options[key] = args[++index];
  }
  if (!options.configPath || (options.runId !== undefined && (command !== 'run' || !UUID.test(options.runId)))) fail('CONFIG_INVALID');
  if (command === 'restart-worker') {
    if (!PROFILE.test(options.profileName ?? '') || !UUID.test(options.expectedRunId ?? '')) fail('CONFIG_INVALID');
  } else if (options.profileName !== undefined || options.expectedRunId !== undefined) fail('CONFIG_INVALID');
  return options;
}

export async function loadGroupConfig(path, { repoDir = REPO, readJson = runtime.readPublicJson, loadConfig = runtime.loadWorkerConfig } = {}) {
  const configPath = resolve(path);
  const raw = await readJson(configPath);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'workerConfigs')
    || !Array.isArray(raw.workerConfigs) || raw.workerConfigs.length < 2 || raw.workerConfigs.length > runtime.MAX_GROUP_WORKERS
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
  for (const key of ['currentWalletNumber', 'lastCompletedWalletNumber', 'deferredAttemptWalletNumber']) {
    if (raw?.[key] === null || (Number.isSafeInteger(raw?.[key]) && raw[key] > 0)) state[key] = raw[key];
  }
  if (UUID.test(raw?.runId ?? '')) state.runId = raw.runId;
  if (raw?.attentionId === null || UUID.test(raw?.attentionId ?? '')) state.attentionId = raw.attentionId;
  if (typeof raw?.canResumeConnection === 'boolean') state.canResumeConnection = raw.canResumeConnection;
  if (typeof raw?.processAlive === 'boolean') state.processAlive = raw.processAlive;
  if (typeof raw?.memberRestartSupported === 'boolean') state.memberRestartSupported = raw.memberRestartSupported;
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
    ...group.configs.map(config => read(restartPath(group, config), { optional: true })),
  ]);
  const saved = savedResult.status === 'fulfilled' ? savedResult.value : null;
  const lock = lockResult.status === 'fulfilled' ? lockResult.value : null;
  const state = saved ? publicWorkerState(saved) : { phase: 'not_started' };
  const processAlive = Boolean(state.pid && lock?.pid === state.pid && lock?.runId === state.runId && alive(state.pid));
  const workers = results.slice(0, group.configs.length).map((result, index) => {
    const config = group.configs[index];
    const member = memberState(config, result.status === 'fulfilled' ? result.value : rejectedState(result.reason));
    const metadata = Array.isArray(saved?.members) ? saved.members.find(value => value?.profileName === config.profileName) : null;
    Object.assign(member, publicRestartState(metadata));
    const requestResult = results[group.configs.length + index];
    const request = requestResult?.status === 'fulfilled' ? requestResult.value : null;
    if (state.memberRestartSupported && processAlive && validRestartRequest(request)
      && request.groupRunId === state.runId && request.memberRunId === member.runId
      && request.profileName === config.profileName && request.requestId !== member.restartRequestId) {
      Object.assign(member, { restartState: 'requested', restartRequestId: request.requestId, previousRunId: request.memberRunId });
    }
    return member;
  });
  const errorCode = savedResult.status === 'rejected' || lockResult.status === 'rejected' ? 'PUBLIC_FILE_INVALID' : undefined;
  return { configPath: group.configPath, ...state, processAlive, ...(errorCode ? { errorCode } : {}), workers };
}

export async function requestWorkerRestart(group, profileName, expectedRunId, dependencies = {}) {
  if (!PROFILE.test(profileName ?? '') || !UUID.test(expectedRunId ?? '')) fail('CONFIRMATION_INVALID');
  const config = group.configs.find(member => member.profileName === profileName);
  if (!config) fail('CONFIG_INVALID');
  const read = dependencies.readJson ?? runtime.readPublicJson;
  const state = await (dependencies.groupStatus ?? groupStatus)(group, dependencies);
  if (!state.processAlive || !UUID.test(state.runId ?? '')) fail('NOT_RUNNING');
  if (state.memberRestartSupported !== true) fail('CONFIRMATION_INVALID');
  const member = state.workers.find(value => value.profileName === profileName);
  if (!member || member.runId !== expectedRunId) fail('CONFIRMATION_INVALID');
  const stop = await read(group.stopPath, { optional: true });
  if (stop?.runId === state.runId) fail('NOT_RUNNING');
  const previous = await read(restartPath(group, config), { optional: true });
  if (previous && !validRestartRequest(previous)) fail('PUBLIC_FILE_INVALID');
  if (validRestartRequest(previous) && previous.groupRunId === state.runId
    && previous.memberRunId === expectedRunId && previous.profileName === profileName) {
    if (!PENDING_RESTART_STATES.has(member.restartState)) fail('CONFIRMATION_INVALID');
    return { phase: 'restart_requested', groupRunId: state.runId, memberRunId: expectedRunId,
      profileName, requestId: previous.requestId };
  }
  if (!RESTARTABLE_PHASES.has(member.phase) || PENDING_RESTART_STATES.has(member.restartState)
    || await read(config.attemptPath, { optional: true }) !== null) fail('CONFIRMATION_INVALID');
  // One request identity per group/member generation also makes simultaneous
  // duplicate CLI submissions idempotent before either sees the other's file.
  const requestHash = createHash('sha256').update(JSON.stringify([state.runId, profileName, expectedRunId])).digest('hex').slice(0, 32);
  const requestId = `${requestHash.slice(0, 8)}-${requestHash.slice(8, 12)}-${requestHash.slice(12, 16)}-${requestHash.slice(16, 20)}-${requestHash.slice(20)}`;
  const request = { formatVersion: 1, groupRunId: state.runId, memberRunId: expectedRunId,
    profileName, requestId, requestedAt: new Date().toISOString() };
  await (dependencies.writeJson ?? runtime.atomicWriteJson)(restartPath(group, config), request);
  return { phase: 'restart_requested', groupRunId: state.runId, memberRunId: expectedRunId,
    profileName, requestId: request.requestId };
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
  const rearm = dependencies.rearmWorker ?? runtime.rearmWorkerGroupMember;
  const execute = dependencies.runWorker ?? runtime.runWorker;
  const coordinator = dependencies.coordinator ?? createUiCoordinator();
  const launch = dependencies.launch ?? launchDedicatedBrowser;
  const prepareManifest = dependencies.prepareManifest ?? prepareManifestFromVisibleUi;
  const createRunner = dependencies.createRunner ?? createPlaywrightNadoRunner;
  const read = dependencies.readJson ?? runtime.readPublicJson;
  const write = dependencies.writeJson ?? runtime.atomicWriteJson;
  const workerStatus = dependencies.workerStatus ?? runtime.workerStatus;
  let stop = false, timer, polling, writeQueue = Promise.resolve(), rearmQueue = Promise.resolve();
  const serializeRearm = operation => {
    const next = rearmQueue.then(operation);
    rearmQueue = next.catch(() => {});
    return next;
  };
  const slots = group.configs.map(config => ({
    profileName: config.profileName, memberRunId: runId, browser: null, waiting: false, finished: false,
    abandoned: false, generation: 0, restartCount: 0, restartState: 'idle',
    pending: null, requestedRunId: null, seen: new Set(), result: null,
  }));
  const wait = dependencies.sleep ?? delay;
  let state = { formatVersion: 1, pid: process.pid, runId, phase: 'starting', memberRestartSupported: true,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const update = patch => {
    state = { ...state, ...patch, updatedAt: new Date().toISOString() };
    const snapshot = { ...state };
    writeQueue = writeQueue.then(() => write(group.statusPath, snapshot));
    return writeQueue;
  };
  const publishSlots = () => update({ members: slots.map(slot => ({
    profileName: slot.profileName, memberRunId: slot.memberRunId, ...publicRestartState(slot),
  })) });
  const finishRequest = (slot, restartState, error) => {
    slot.restartState = restartState;
    slot.restartErrorCode = error ? runtime.safeErrorCode(error) : undefined;
    slot.pending = null;
  };
  return withLease(group.configs, async lease => {
    await (dependencies.ensureDirectory ?? runtime.ensureOwnedDirectory)(group.repoDir, group.stateDir);
    await update({ phase: 'running' });
    await publishSlots();
    const pollControls = () => {
      if (polling) return polling;
      polling = (async () => {
        let changed = false;
        try {
          if (dependencies.shouldStop?.()) stop = true;
          const request = await read(group.stopPath, { optional: true });
          if (request?.runId === runId) stop = true;
          for (const [index, config] of group.configs.entries()) {
            const slot = slots[index];
            try {
              const request = await read(restartPath(group, config), { optional: true });
              if (!request) continue;
              if (!validRestartRequest(request) || request.profileName !== config.profileName) {
                if (!slot.pending && slot.restartState !== 'blocked') {
                  finishRequest(slot, 'blocked', { code: 'PUBLIC_FILE_INVALID' }); changed = true;
                }
                continue;
              }
              if (request.groupRunId !== runId || slot.seen.has(request.requestId)) continue;
              slot.seen.add(request.requestId);
              // A second writer cannot replace a request already stopping this generation.
              if (slot.pending) continue;
              slot.restartRequestId = request.requestId;
              slot.previousRunId = request.memberRunId;
              changed = true;
              if (stop) { finishRequest(slot, 'cancelled'); continue; }
              if (request.memberRunId !== slot.memberRunId || slot.requestedRunId === slot.memberRunId) {
                finishRequest(slot, 'blocked', { code: 'CONFIRMATION_INVALID' }); continue;
              }
              const member = await workerStatus(config);
              // A request made during working may arrive while that same wallet is
              // saving. Stop at its existing safe boundary; rearm rejects any journal
              // that still exists after the worker has fully finished.
              if (member.runId !== slot.memberRunId
                || (!RESTARTABLE_PHASES.has(member.phase) && member.phase !== 'save_pending')) {
                finishRequest(slot, 'blocked', { code: 'CONFIRMATION_INVALID' }); continue;
              }
              slot.pending = request;
              slot.requestedRunId = slot.memberRunId;
              slot.restartState = 'stopping';
              slot.restartErrorCode = undefined;
            } catch {
              // A member control-file/read failure must not stop healthy peers.
              // Do not retry or retain a partially accepted restart request.
              if (slot.restartState !== 'blocked' || slot.restartErrorCode !== 'PUBLIC_FILE_INVALID') {
                finishRequest(slot, 'blocked', { code: 'PUBLIC_FILE_INVALID' }); changed = true;
              }
            }
          }
        } catch { stop = true; } // Corrupt control state fails closed.
        if (stop) for (const slot of slots) if (slot.pending) {
          finishRequest(slot, 'cancelled'); changed = true;
        }
        if (changed) await publishSlots();
      })().catch(() => { stop = true; }).finally(() => { polling = null; });
      return polling;
    };
    await pollControls();
    timer = setInterval(() => { void pollControls(); }, dependencies.controlPollMs ?? 250);
    timer.unref?.();
    const runSlot = async (config, slot) => {
      while (true) {
        slot.finished = false;
        slot.waiting = false;
        slot.abandoned = false;
        slot.browser = null;
        try {
          slot.result = await execute(config, {
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
                  // A restarted member observes only its own unlock. Peers that
                  // already passed the initial barrier never re-enter it.
                  if (slot.generation > 0) {
                    if (await browser.localPage.getByTestId('connect-wallet-address').isVisible()) {
                      slot.restartState = 'restarted';
                      await publishSlots();
                      return true;
                    }
                    if (slot.restartState !== 'waiting_unlock') {
                      slot.restartState = 'waiting_unlock';
                      await publishSlots();
                    }
                  } else {
                    // Visibility reads do not focus a browser or type a password.
                    const active = slots.filter(member => member.generation === 0 && !member.finished && !member.abandoned);
                    if (active.every(member => member.browser && member.waiting)) {
                      const visible = await Promise.all(active.map(async member => {
                        try { return await member.browser.localPage.getByTestId('connect-wallet-address').isVisible(); }
                        catch { member.abandoned = true; return false; }
                      }));
                      if (slot.abandoned) fail('BROWSER_CLOSED');
                      if (active.every((member, memberIndex) => member.abandoned || visible[memberIndex])) return true;
                    }
                  }
                  await wait(250);
                }
              } catch {
                slot.abandoned = true;
                fail(browser.isClosed?.() ? 'BROWSER_CLOSED' : 'NEEDS_ATTENTION');
              }
            },
            createRunner: options => createRunner({ ...options, withUi: coordinator.run }),
            shouldStop: () => stop || Boolean(slot.pending) || Boolean(dependencies.shouldStop?.()),
          }, { lease, runId: slot.memberRunId });
        } catch (error) {
          slot.result = rejectedState(error);
        } finally {
          // execute resolves only after cleanup, browser close and profile-lock
          // release. A close failure is rejected and rearm verifies it independently.
          slot.finished = true;
        }
        await pollControls();
        if (slot.result.phase === 'completed') {
          if (slot.pending) finishRequest(slot, 'cancelled');
          else if (slot.generation && slot.restartState === 'restarting') slot.restartState = 'restarted';
          await publishSlots();
          return slot.result;
        }
        // Keep a failed/stopped slot available while a healthy peer is running.
        // There is no autonomous retry: only a fresh explicit request can rearm.
        while (!stop && !slot.pending
          && slots.some(other => other !== slot && (!other.finished || other.pending))) {
          await wait(250);
          await pollControls();
        }
        if (stop || !slot.pending) {
          if (slot.pending) { finishRequest(slot, 'cancelled'); await publishSlots(); }
          return slot.result;
        }
        const previousRunId = slot.memberRunId;
        slot.restartState = 'restarting';
        await publishSlots();
        try {
          if (typeof rearm !== 'function') fail('CONFIG_INVALID');
          const nextRunId = await serializeRearm(async () => {
            await pollControls();
            if (stop) return null;
            return rearm(config, lease, previousRunId);
          });
          await pollControls();
          if (stop || nextRunId === null) {
            finishRequest(slot, 'cancelled');
            await publishSlots();
            return slot.result;
          }
          if (!UUID.test(nextRunId ?? '') || nextRunId === previousRunId) fail('CONFIRMATION_INVALID');
          slot.memberRunId = nextRunId;
          slot.restartRunId = nextRunId;
          slot.restartCount++;
          slot.generation++;
          slot.finished = false;
          slot.pending = null;
          slot.restartErrorCode = undefined;
          await publishSlots();
        } catch (error) {
          finishRequest(slot, 'blocked', error);
          await publishSlots();
          // A failed rearm consumes the request and cannot fall through into
          // execute. Keep the failure visible while other members finish.
          while (!stop && slots.some(other => other !== slot && (!other.finished || other.pending))) {
            await wait(250);
            await pollControls();
          }
          return slot.result;
        }
      }
    };
    try {
      const results = await Promise.allSettled(group.configs.map((config, index) => runSlot(config, slots[index])));
      const workers = results.map((result, index) => ({
        ...memberState(group.configs[index], result.status === 'fulfilled' ? result.value : rejectedState(result.reason)),
        ...publicRestartState(slots[index]),
      }));
      const failed = workers.some(worker => worker.phase === 'failed');
      const stopped = stop || workers.some(worker => worker.phase === 'stopped');
      await update({ phase: failed ? 'failed' : stopped ? 'stopped' : 'completed' });
      return { ...publicWorkerState(state), workers };
    } finally {
      clearInterval(timer);
      await polling;
      await writeQueue.catch(() => {});
      // withLease releases only after every runWorker has closed its own context.
    }
  }, { runId });
}

/*
 * Member restart deliberately lives in the existing group process. It never
 * spawns a second group or edits its plans/profiles, and cannot consume old-run
 * requests after a successful generation change.
 */

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
  if (options.command === 'restart-worker') {
    output(await requestWorkerRestart(group, options.profileName, options.expectedRunId, dependencies));
    return;
  }
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
