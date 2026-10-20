// Process/runtime state contains public metadata only. Browser storage is never read here.
import { open, readFile, lstat, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeConfig, validateWalletManifest, normalizeProgressRecord, mergeProgress, createPlan, isVerified } from './planner.mjs';
import { parseProgress } from './cli.mjs';
import { validateTermsConfirmation, assertTermsMatch } from './cua-runner.mjs';
import { sanitizeUiObservation } from './ui-diagnostics.mjs';

const PLAN_KEYS = ['bounds', 'start', 'end', 'direction', 'laneCount', 'laneIndex'];
const CONFIG_KEYS = new Set([...PLAN_KEYS, 'walletsPath', 'progressPath', 'progressPaths', 'usernamePrefix',
  'browser', 'profileName', 'localUrl', 'timeoutMs', 'pollIntervalMs', 'maxUsernameCandidates']);
const CODES = new Set(['CONFIG_INVALID', 'PUBLIC_FILE_INVALID', 'WORKER_ALREADY_RUNNING', 'WORKER_LOCK_STALE',
  'PROFILE_NOT_DEDICATED', 'STORAGE_ERROR', 'BROWSER_START_FAILED', 'BROWSER_CLOSED', 'VAULT_LOCKED',
  'TERMS_CONFIRMATION_REQUIRED', 'PAIRING_LINK_PENDING', 'ONBOARDING_PENDING', 'CONNECTION_PROPOSAL_PENDING', 'WEBSITE_LOADING_PENDING', 'TERMS_INVALID', 'CONFIRMATION_INVALID', 'NEEDS_ATTENTION', 'ABORTED',
  'ORIGIN_MISMATCH', 'RECORD_INVALID', 'ATTEMPT_OUTSIDE_PLAN', 'RUNNER_FAILED', 'NOT_RUNNING']);
const RUNNER_STAGES = new Set(['preparing', 'pairing', 'prepared', 'checking_username', 'switching_ink',
  'verified', 'accepting_terms', 'username_introduction', 'save_pending', 'awaiting_username_result',
  'opening_walletconnect', 'waiting_pairing_link', 'clearing_pairing_clipboard', 'copying_pairing_link',
  'reading_pairing_link', 'validating_pairing_link', 'filling_pairing_link',
  'sending_connection_request', 'waiting_connection_proposal', 'approving_connection', 'waiting_onboarding', 'resetting_stale_session', 'waiting_website']);
export const TERMINAL_PHASES = new Set(['completed', 'stopped', 'failed']);
export class WorkerError extends Error {
  constructor(code) {
    super(CODES.has(code) ? code : 'RUNNER_FAILED');
    this.name = 'WorkerError';
    this.code = this.message;
  }
}
export const safeErrorCode = error => CODES.has(error?.code) ? error.code : 'RUNNER_FAILED';
const fail = code => { throw new WorkerError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const now = () => new Date().toISOString();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const groupLeases = new WeakMap();
const pathString = value => typeof value === 'string' && value.trim() && !value.includes('\0');
const int = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

export function normalizeWorkerConfig(raw, { configPath, repoDir }) {
  try {
    if (!object(raw) || Object.keys(raw).some(key => !CONFIG_KEYS.has(key))) fail('CONFIG_INVALID');
    const plan = normalizeConfig(Object.fromEntries(PLAN_KEYS.filter(key => raw[key] !== undefined).map(key => [key, raw[key]])));
    const base = dirname(resolve(configPath));
    const browser = raw.browser ?? 'edge';
    const profileName = raw.profileName ?? `registration-${browser}`;
    if (!['edge', 'chrome', 'chromium'].includes(browser) || typeof profileName !== 'string'
      || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(profileName)) fail('CONFIG_INVALID');
    const localUrl = new URL(raw.localUrl ?? 'http://127.0.0.1:18270/connect');
    if (localUrl.protocol !== 'http:' || localUrl.hostname !== '127.0.0.1' || localUrl.pathname !== '/connect'
      || localUrl.username || localUrl.password || localUrl.hash || localUrl.search) fail('CONFIG_INVALID');
    if (!pathString(raw.walletsPath) || !pathString(raw.progressPath)) fail('CONFIG_INVALID');
    if (raw.progressPaths !== undefined && (!Array.isArray(raw.progressPaths) || raw.progressPaths.some(path => !pathString(path)))) fail('CONFIG_INVALID');
    const usernamePrefix = raw.usernamePrefix ?? 'ybtl';
    if (typeof usernamePrefix !== 'string' || !/^[A-Za-z][A-Za-z0-9_.]{0,13}$/.test(usernamePrefix)
      || `${usernamePrefix}${plan.bounds.max}`.length > 20) fail('CONFIG_INVALID');
    const timeoutMs = raw.timeoutMs ?? 20000;
    const pollIntervalMs = raw.pollIntervalMs ?? 1000;
    const maxUsernameCandidates = raw.maxUsernameCandidates ?? 5;
    if (!int(timeoutMs, 1000, 60000) || !int(pollIntervalMs, 50, 10000) || !int(maxUsernameCandidates, 1, 20)) fail('CONFIG_INVALID');
    const repo = resolve(repoDir);
    const stateDir = resolve(repo, '.local', 'registration-worker', profileName);
    const profileDir = resolve(repo, 'browser-profiles', 'registration', profileName);
    const progressPath = resolve(base, raw.progressPath);
    const walletsPath = resolve(base, raw.walletsPath);
    const progressPaths = [...new Set([...(raw.progressPaths ?? []).map(path => resolve(base, path)), progressPath])];
    const inside = (root, path) => { const rel = relative(root, path); return !rel || (!rel.startsWith('..') && !isAbsolute(rel)); };
    // Public inputs/outputs must never resolve inside the dedicated browser profile.
    if ([walletsPath, ...progressPaths].some(path => inside(resolve(repo, 'browser-profiles'), path))
      || walletsPath === progressPath || [walletsPath, ...progressPaths].some(path => inside(stateDir, path))) fail('CONFIG_INVALID');
    const owner = createHash('sha256').update(homedir()).digest('hex').slice(0, 16);
    return {
      plan, repoDir: repo, configPath: resolve(configPath), browser, profileName, profileDir, stateDir,
      localUrl: localUrl.href, walletsPath, progressPath, progressPaths, usernamePrefix,
      timeoutMs, pollIntervalMs, maxUsernameCandidates,
      globalLockPath: join(tmpdir(), `nado-registration-${owner}`, 'worker.lock'),
      profileLockPath: join(stateDir, 'profile.lock'),
      statusPath: join(stateDir, 'status.json'), stopPath: join(stateDir, 'stop.json'),
      candidatePath: join(stateDir, 'terms-candidate.json'), consentPath: join(stateDir, 'terms-accepted.json'),
      attemptPath: join(stateDir, 'attempt.json'),
    };
  } catch { fail('CONFIG_INVALID'); }
}

export async function readPublicText(path, { optional = false } = {}) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) fail('PUBLIC_FILE_INVALID');
    return (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    if (error instanceof WorkerError) throw error;
    fail('PUBLIC_FILE_INVALID');
  }
}
export async function readPublicJson(path, options) {
  const text = await readPublicText(path, options);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { fail('PUBLIC_FILE_INVALID'); }
}
export async function loadWorkerConfig(configPath, repoDir) {
  return normalizeWorkerConfig(await readPublicJson(configPath), { configPath, repoDir });
}

// Only creates task-owned state/profile directories, rejecting junctions/symlinks.
export async function ensureOwnedDirectory(root, target) {
  const base = resolve(root);
  const rel = relative(base, resolve(target));
  if (rel.startsWith('..') || isAbsolute(rel)) fail('STORAGE_ERROR');
  for (const part of [base, ...rel.split(/[\\/]/).filter(Boolean).map((_, index, parts) => resolve(base, ...parts.slice(0, index + 1)))]) {
    try {
      const info = await lstat(part);
      if (!info.isDirectory() || info.isSymbolicLink()) fail('STORAGE_ERROR');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try { await mkdir(part, { mode: 0o700 }); }
      catch (created) {
        if (created?.code !== 'EEXIST') throw created;
        const concurrent = await lstat(part);
        if (!concurrent.isDirectory() || concurrent.isSymbolicLink()) fail('STORAGE_ERROR');
      }
    }
  }
}
export async function atomicWriteJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    const existing = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) fail('STORAGE_ERROR');
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await file.sync();
    await file.close(); file = null;
    await rename(temporary, path);
  } catch {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    fail('STORAGE_ERROR');
  }
}
export function pidAlive(pid) {
  if (!int(pid, 1, 2147483647)) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export async function acquireLock(path, owner, alive = pidAlive) {
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') fail('STORAGE_ERROR');
    let previous;
    try { previous = await readPublicJson(path); } catch { fail('WORKER_LOCK_STALE'); }
    fail(alive(previous?.pid) ? 'WORKER_ALREADY_RUNNING' : 'WORKER_LOCK_STALE');
  }
  try { await handle.writeFile(JSON.stringify(owner), 'utf8'); await handle.sync(); }
  catch { await handle.close(); await unlink(path).catch(() => {}); fail('STORAGE_ERROR'); }
  await handle.close();
  return async () => {
    try {
      const current = await readPublicJson(path);
      if (current?.token === owner.token) await unlink(path);
    } catch { /* Never remove another process's lock. */ }
  };
}
export async function ensureDedicatedProfile(config) {
  await ensureOwnedDirectory(config.repoDir, config.profileDir);
  const markerPath = join(config.profileDir, '.nado-worker-profile.json');
  const marker = await readPublicJson(markerPath, { optional: true });
  if (marker) {
    if (marker.formatVersion !== 1 || marker.purpose !== 'nado-registration-only' || marker.profileName !== config.profileName) fail('PROFILE_NOT_DEDICATED');
  } else {
    if ((await readdir(config.profileDir)).length) fail('PROFILE_NOT_DEDICATED');
    await atomicWriteJson(markerPath, { formatVersion: 1, purpose: 'nado-registration-only', profileName: config.profileName });
  }
}

export async function appendVerifiedRecord(path, record) {
  let handle;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink())) fail('STORAGE_ERROR');
    handle = await open(path, 'a+', 0o600);
    const size = (await handle.stat()).size;
    // Validate the sink's first token and last byte without re-reading all prior
    // records on every append. The entire ledger was validated before launch.
    const buffer = Buffer.alloc(4096);
    for (let position = 0; position < size; position += buffer.length) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      const first = buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '').trimStart()[0];
      if (first) { if (first !== '{') fail('STORAGE_ERROR'); break; }
    }
    let separator = '';
    if (size) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] !== 10) separator = '\n';
    }
    const line = `${separator}${JSON.stringify(record)}\n`;
    await handle.writeFile(line, 'utf8');
    await handle.sync();
  } catch { fail('STORAGE_ERROR'); }
  finally { await handle?.close(); }
}
export async function saveManifestIfMissing(path, manifest) {
  let normalized;
  try { normalized = validateWalletManifest(manifest); } catch { fail('PUBLIC_FILE_INVALID'); }
  let handle;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(normalized, null, 2) + '\n', 'utf8');
    await handle.sync();
  } catch (error) {
    // If the user exported a file concurrently, use strict validation later.
    // Never overwrite it, even if it differs from the browser's new export.
    if (error?.code !== 'EEXIST') fail('STORAGE_ERROR');
  } finally { await handle?.close(); }
}
export function validateAttempt(raw) {
  if (!object(raw) || Object.keys(raw).some(key => !['walletNumber', 'address', 'username', 'saveAttempted'].includes(key))
    || raw.saveAttempted !== true || !int(raw.walletNumber, 1, 1000000)
    || typeof raw.address !== 'string' || !/^0x[0-9a-f]{40}$/.test(raw.address)
    || typeof raw.username !== 'string' || !/^[A-Za-z0-9_.]{3,20}$/.test(raw.username)) fail('RECORD_INVALID');
  return { walletNumber: raw.walletNumber, address: raw.address, username: raw.username, saveAttempted: true };
}
export function termsCandidate(raw, runId) {
  try {
    const approved = validateTermsConfirmation({ ...raw, confirmed: true, context: '仅本次本地运行的明确确认' });
    if (!Array.isArray(raw.links) || !raw.links.includes(approved.termsUrl) || !raw.links.includes(approved.privacyUrl)) fail('TERMS_INVALID');
    const terms = { declarations: [...approved.declarations], links: [approved.termsUrl, approved.privacyUrl], termsUrl: approved.termsUrl, privacyUrl: approved.privacyUrl };
    return { formatVersion: 1, runId, digest: digest({ runId, terms }), terms };
  } catch { fail('TERMS_INVALID'); }
}

export async function workerStatus(config) {
  const state = await readPublicJson(config.statusPath, { optional: true });
  if (!state) return { phase: 'not_started', processAlive: false };
  const lock = await readPublicJson(config.profileLockPath, { optional: true });
  const processAlive = !TERMINAL_PHASES.has(state.phase) && lock?.runId === state.runId && lock?.pid === state.pid && pidAlive(state.pid);
  return { ...state, processAlive, heartbeatAgeSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(state.updatedAt)) / 1000)) };
}
export async function requestWorkerStop(config) {
  const state = await workerStatus(config);
  if (!state.processAlive) fail('NOT_RUNNING');
  await atomicWriteJson(config.stopPath, { runId: state.runId, requestedAt: now() });
  return { phase: 'stop_requested', runId: state.runId, message: '当前钱包完成并保存后停止；等待解锁或条款时立即停止。' };
}
export async function acceptWorkerTerms(config, expectedDigest) {
  const state = await workerStatus(config);
  const candidate = await readPublicJson(config.candidatePath);
  if (!state.processAlive || state.phase !== 'waiting_terms' || !/^[a-f0-9]{64}$/.test(expectedDigest ?? '')
    || candidate.runId !== state.runId || candidate.digest !== expectedDigest
    || termsCandidate(candidate.terms, candidate.runId).digest !== expectedDigest) fail('CONFIRMATION_INVALID');
  await atomicWriteJson(config.consentPath, { runId: state.runId, digest: expectedDigest, confirmedAt: now() });
  return { phase: 'terms_confirmed', runId: state.runId, digest: expectedDigest };
}

// Short-lived ownership changes are serialized separately from the long-lived
// worker lock. An abandoned control lock fails closed and is never auto-deleted.
async function withControlLock(config, operation) {
  await mkdir(dirname(config.globalLockPath), { recursive: true, mode: 0o700 });
  const info = await lstat(dirname(config.globalLockPath));
  if (!info.isDirectory() || info.isSymbolicLink()) fail('STORAGE_ERROR');
  const owner = { pid: process.pid, runId: randomUUID(), token: randomUUID(), createdAt: now() };
  const release = await acquireLock(`${config.globalLockPath}.control`, owner);
  try { return await operation(); } finally { await release(); }
}
export async function recoverWorkerLocks(config, confirmedClosed) {
  if (confirmedClosed !== true) fail('CONFIRMATION_INVALID');
  return withControlLock(config, async () => {
    const paths = [config.globalLockPath, config.profileLockPath];
    const locks = await Promise.all(paths.map(path => readPublicJson(path, { optional: true })));
    if (locks.some(lock => lock && pidAlive(lock.pid))) fail('WORKER_ALREADY_RUNNING');
    if (locks[0]?.members !== undefined) fail('WORKER_LOCK_STALE');
    // Cross-profile cleanup is prohibited. A global lock owned by another
    // profile must be recovered using that profile's original configuration.
    if (locks[0] && locks[1] && locks[0].runId !== locks[1].runId) fail('WORKER_LOCK_STALE');
    if (locks[0] && !locks[1]) fail('WORKER_LOCK_STALE');
    for (let index = 0; index < paths.length; index++) {
      const previous = locks[index];
      if (!previous) continue;
      const current = await readPublicJson(paths[index]);
      if (current?.token !== previous.token || pidAlive(current.pid)) fail('WORKER_LOCK_STALE');
      await unlink(paths[index]);
    }
    return { phase: 'locks_recovered', message: '已移除已退出进程的锁。未终止任何进程，未读取或修改浏览器存储。' };
  });
}

// A group owns the same OS-user lock as a standalone worker. Only this module
// can issue a lease; it covers fixed, non-overlapping plans and public snapshots.
export function validateWorkerGroup(configs) {
  if (!Array.isArray(configs) || configs.length < 2 || configs.length > 4) fail('CONFIG_INVALID');
  const first = configs[0];
  const paths = new Set(), numbers = new Set();
  const normalizedPath = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const inside = (root, path) => {
    const rel = relative(normalizedPath(root), normalizedPath(path));
    return !rel || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  const privateDirs = configs.flatMap(config => [config.stateDir, config.profileDir]);
  for (const config of configs) {
    if (config.repoDir !== first.repoDir || config.globalLockPath !== first.globalLockPath
      || config.walletsPath !== first.walletsPath || config.localUrl !== first.localUrl) fail('CONFIG_INVALID');
    if ([config.walletsPath, config.progressPath, ...config.progressPaths]
      .some(path => privateDirs.some(root => inside(root, path)))) fail('CONFIG_INVALID');
    for (const path of [config.profileDir, config.stateDir, config.progressPath]) {
      const key = process.platform === 'win32' ? path.toLowerCase() : path;
      if (paths.has(key)) fail('CONFIG_INVALID');
      paths.add(key);
    }
    const plan = normalizeConfig(config.plan);
    const count = Math.abs(plan.end - plan.start) + 1;
    const step = plan.direction === 'asc' ? 1 : -1;
    for (let offset = plan.laneIndex; offset < count; offset += plan.laneCount) {
      const number = plan.start + offset * step;
      if (numbers.has(number)) fail('CONFIG_INVALID');
      numbers.add(number);
    }
  }
  return configs;
}

export async function withWorkerGroupLease(configs, operation, { runId = randomUUID() } = {}) {
  validateWorkerGroup(configs);
  if (typeof operation !== 'function') fail('CONFIG_INVALID');
  const owner = { pid: process.pid, runId, token: randomUUID(), createdAt: now(),
    members: configs.map(config => config.profileLockPath) };
  let release;
  const lease = Object.freeze({});
  try {
    await withControlLock(configs[0], async () => {
      release = await acquireLock(configs[0].globalLockPath, owner);
      for (const config of configs) {
        const lock = await readPublicJson(config.profileLockPath, { optional: true });
        if (lock) fail(pidAlive(lock.pid) ? 'WORKER_ALREADY_RUNNING' : 'WORKER_LOCK_STALE');
      }
    });
    let manifest, records;
    try {
      manifest = validateWalletManifest(await readPublicJson(configs[0].walletsPath));
      const outputs = new Set(configs.map(config => config.progressPath));
      const sources = new Set(configs.flatMap(config => config.progressPaths));
      const arrays = [];
      for (const path of sources) {
        const text = await readPublicText(path, { optional: outputs.has(path) });
        if (outputs.has(path) && text?.trimStart().startsWith('[')) fail('PUBLIC_FILE_INVALID');
        arrays.push(text === null ? [] : parseProgress(text));
      }
      records = mergeProgress(arrays, manifest);
    } catch { fail('PUBLIC_FILE_INVALID'); }
    const entries = new Map(configs.map(config => [digest(config), {
      manifest, records, plan: createPlan(config.plan, manifest, records), active: false, runId,
    }]));
    groupLeases.set(lease, entries);
    return await operation(lease);
  } finally {
    // Keep global ownership even if a caller mistakenly uses Promise.all and
    // another member rejects before its peers have closed their browsers.
    const entries = groupLeases.get(lease);
    if (entries) await Promise.allSettled([...entries.values()].map(entry => entry.finished).filter(Boolean));
    groupLeases.delete(lease);
    await release?.();
  }
}

export async function recoverWorkerGroupLocks(configs, confirmedClosed) {
  validateWorkerGroup(configs);
  if (confirmedClosed !== true) fail('CONFIRMATION_INVALID');
  return withControlLock(configs[0], async () => {
    const paths = [configs[0].globalLockPath, ...configs.map(config => config.profileLockPath)];
    const locks = await Promise.all(paths.map(path => readPublicJson(path, { optional: true })));
    if (locks.some(lock => lock && pidAlive(lock.pid))) fail('WORKER_ALREADY_RUNNING');
    const global = locks[0];
    if (global && (!Array.isArray(global.members) || JSON.stringify([...global.members].sort())
      !== JSON.stringify(paths.slice(1).sort()))) fail('WORKER_LOCK_STALE');
    if (global && locks.slice(1).some(lock => lock && lock.runId !== global.runId)) fail('WORKER_LOCK_STALE');
    for (let index = 0; index < paths.length; index++) {
      if (!locks[index]) continue;
      const current = await readPublicJson(paths[index]);
      if (current?.token !== locks[index].token || pidAlive(current.pid)) fail('WORKER_LOCK_STALE');
      await unlink(paths[index]);
    }
    return { phase: 'locks_recovered' };
  });
}

export async function runWorker(config, dependencies, { setup = false, runId, lease } = {}) {
  const leased = lease === undefined ? null : groupLeases.get(lease)?.get(digest(config));
  if (lease !== undefined && (!leased || leased.active || setup)) fail('CONFIG_INVALID');
  runId ??= leased?.runId ?? randomUUID();
  if (leased && runId !== leased.runId) fail('CONFIG_INVALID');
  let finishLease;
  if (leased) {
    leased.active = true;
    leased.finished = new Promise(resolveFinished => { finishLease = resolveFinished; });
  }
  const owner = { pid: process.pid, runId, token: randomUUID(), createdAt: now() };
  let releaseGlobal, releaseProfile, browser, runner, timer, writeQueue = Promise.resolve();
  let stopped = false, current = null, attempt = null, confirmation, completed = 0, total = 0;
  let state = { formatVersion: 1, pid: owner.pid, runId, phase: 'starting', startedAt: now(), updatedAt: now(), total: 0, completed: 0, remaining: 0 };
  const writeState = patch => {
    state = { ...state, ...patch, updatedAt: now() };
    const snapshot = { ...state };
    writeQueue = writeQueue.then(() => atomicWriteJson(config.statusPath, snapshot));
    return writeQueue;
  };
  const stopRequested = async () => {
    if (dependencies.shouldStop?.()) stopped = true;
    const request = await readPublicJson(config.stopPath, { optional: true });
    if (request?.runId === runId || browser?.isClosed?.()) stopped = true;
    return stopped;
  };
  const wait = dependencies.sleep ?? sleep;
  const launch = async () => {
    if (browser) return;
    try { browser = await dependencies.launch(config); } catch { fail('BROWSER_START_FAILED'); }
  };
  try {
    await ensureOwnedDirectory(config.repoDir, config.stateDir);
    if (leased) {
      releaseProfile = await acquireLock(config.profileLockPath, owner);
    } else {
      await withControlLock(config, async () => {
        releaseGlobal = await acquireLock(config.globalLockPath, owner);
        releaseProfile = await acquireLock(config.profileLockPath, owner);
      });
    }
    await writeState({});
    timer = setInterval(() => { writeState({}).catch(() => { stopped = true; }); }, 5000);
    timer.unref?.();
    await ensureDedicatedProfile(config);
    let manifest = [], records = [], plan = { items: [] };
    if (!setup) {
      if (leased) {
        manifest = leased.manifest; records = leased.records; plan = leased.plan;
      } else {
        if (await readPublicText(config.walletsPath, { optional: true }) === null) {
          if (!dependencies.prepareManifest) fail('PUBLIC_FILE_INVALID');
          if (await stopRequested()) { await writeState({ phase: 'stopped' }); return state; }
          await writeState({ phase: 'waiting_manifest' });
          await launch();
          const exported = await dependencies.prepareManifest(config, browser, {
            shouldStop: stopRequested,
            onStage: phase => {
              if (!['waiting_unlock', 'waiting_manifest_export', 'exporting_manifest'].includes(phase)) fail('PUBLIC_FILE_INVALID');
              return writeState({ phase });
            },
          });
          if (await stopRequested()) { await writeState({ phase: 'stopped' }); return state; }
          if (!exported) fail('PUBLIC_FILE_INVALID');
          await saveManifestIfMissing(config.walletsPath, exported);
        }
        try {
          manifest = validateWalletManifest(await readPublicJson(config.walletsPath));
          const arrays = [];
          for (const path of config.progressPaths) {
            const text = await readPublicText(path, { optional: path === config.progressPath });
            if (path === config.progressPath && text?.trimStart().startsWith('[')) fail('PUBLIC_FILE_INVALID');
            arrays.push(text === null ? [] : parseProgress(text));
          }
          records = mergeProgress(arrays, manifest);
          plan = createPlan(config.plan, manifest, records);
        } catch (error) { throw error instanceof WorkerError ? error : new WorkerError('PUBLIC_FILE_INVALID'); }
      }
      completed = plan.completed; total = plan.total;
      await writeState({ total, completed, remaining: plan.remaining });
      const previous = await readPublicJson(config.attemptPath, { optional: true });
      if (previous) {
        attempt = validateAttempt(previous);
        const done = records.find(record => record.walletNumber === attempt.walletNumber && record.address === attempt.address && isVerified(record));
        if (done) { await unlink(config.attemptPath); attempt = null; }
        else if (plan.items[0]?.walletNumber !== attempt.walletNumber || plan.items[0]?.address !== attempt.address) fail('ATTEMPT_OUTSIDE_PLAN');
      }
      if (!plan.items.length) { await writeState({ phase: 'completed' }); return state; }
    }
    if (await stopRequested()) { await writeState({ phase: 'stopped' }); return state; }
    await launch();
    if (setup) {
      await writeState({ phase: 'setup_browser' });
      while (!(await stopRequested())) await wait(config.pollIntervalMs);
      await writeState({ phase: 'stopped' });
      return state;
    }
    if (dependencies.waitForUnlock) {
      await dependencies.waitForUnlock(config, browser, {
        shouldStop: stopRequested,
        onStage: () => writeState({ phase: 'waiting_unlock' }),
      });
      if (await stopRequested()) { await writeState({ phase: 'stopped' }); return state; }
    }
    runner = await dependencies.createRunner({
      localPage: browser.localPage, nadoPage: browser.nadoPage, walletManifest: manifest,
      timeoutMs: config.timeoutMs, maxUsernameCandidates: config.maxUsernameCandidates,
      usernameForWallet: walletNumber => `${config.usernamePrefix}${walletNumber}`,
      resumeAttempt: attempt ?? undefined,
      onEvent: async event => {
        if (!RUNNER_STAGES.has(event?.stage)) return;
        if (!current || event.walletNumber !== current.walletNumber || event.address !== current.address) fail('RECORD_INVALID');
        if (event.stage !== 'save_pending') {
          await writeState({ phase: 'working', stage: event.stage,
            ...(event.stage === 'sending_connection_request' || event.stage === 'approving_connection' ? { waitingSince: null } : {}) });
          return;
        }
        const next = validateAttempt({ walletNumber: event.walletNumber, address: event.address, username: event.username, saveAttempted: event.saveAttempted });
        if (!current || next.walletNumber !== current.walletNumber || next.address !== current.address
          || (attempt && JSON.stringify(attempt) !== JSON.stringify(next))) fail('RECORD_INVALID');
        await atomicWriteJson(config.attemptPath, next);
        attempt = next;
        await writeState({ phase: 'save_pending', stage: 'save_pending' });
      },
    });
    for (const item of plan.items) {
      if (await stopRequested()) break;
      current = item;
      await writeState({ phase: 'working', currentWalletNumber: item.walletNumber, waitingSince: null });
      let record;
      while (!record && !(await stopRequested())) {
        try { record = await runner.runWallet(item.walletNumber, confirmation); }
        catch (error) {
          const code = safeErrorCode(error);
          if (browser.isClosed?.()) { stopped = true; break; }
          if (code === 'VAULT_LOCKED') {
            await writeState({ phase: 'waiting_unlock' });
            await wait(config.pollIntervalMs);
          } else if (['PAIRING_LINK_PENDING', 'ONBOARDING_PENDING', 'CONNECTION_PROPOSAL_PENDING', 'WEBSITE_LOADING_PENDING'].includes(code)) {
            // The UI runner permits this only while waiting for the pairing
            // link or the post-connection page, before any username signature.
            // Keep the same browser and exact plan item; do not replay clicks.
            if (attempt) fail('NEEDS_ATTENTION');
            await writeState({
              phase: 'waiting_connection', stage: ({ PAIRING_LINK_PENDING: 'waiting_pairing_link',
                ONBOARDING_PENDING: 'waiting_onboarding', CONNECTION_PROPOSAL_PENDING: 'waiting_connection_proposal',
                WEBSITE_LOADING_PENDING: 'waiting_website' })[code],
              waitingSince: state.waitingSince ?? now(),
            });
            // Check stop promptly without holding either browser's UI lock.
            const slices = Math.max(1, Math.ceil(5000 / Math.min(config.pollIntervalMs, 1000)));
            for (let index = 0; index < slices && !(await stopRequested()); index++) await wait(Math.min(config.pollIntervalMs, 1000));
          } else if (code === 'TERMS_CONFIRMATION_REQUIRED') {
            const candidate = termsCandidate(await runner.readTermsCandidate(), runId);
            await atomicWriteJson(config.candidatePath, candidate);
            await writeState({ phase: 'waiting_terms', termsDigest: candidate.digest });
            while (!(await stopRequested())) {
              const accepted = await readPublicJson(config.consentPath, { optional: true });
              if (accepted?.runId === runId && accepted.digest === candidate.digest) {
                // Re-read the visible declarations before any checkbox/click.
                const observed = await runner.readTermsCandidate();
                confirmation = validateTermsConfirmation({ ...candidate.terms, confirmed: true, context: `本地 CLI 明确确认；run ${runId}` });
                assertTermsMatch(observed, confirmation);
                await writeState({ phase: 'working' });
                break;
              }
              await wait(config.pollIntervalMs);
            }
          } else {
            await writeState({ uiState: sanitizeUiObservation(error?.uiState) });
            throw new WorkerError(code);
          }
        }
      }
      if (!record) break;
      let normalized;
      try { normalized = normalizeProgressRecord(record); } catch { fail('RECORD_INVALID'); }
      if (normalized.walletNumber !== item.walletNumber || normalized.address !== item.address || !isVerified(normalized)
        || normalized.websiteSignedIn !== true || normalized.websiteNetwork !== 'Ink'
        || normalized.approvedChainId !== 57073 || normalized.agentTransactionsSent !== 0 || !normalized.username
        || (attempt && normalized.username !== attempt.username)) fail('RECORD_INVALID');
      // Durable append is the only point where this wallet becomes completed.
      await (dependencies.append ?? appendVerifiedRecord)(config.progressPath, normalized);
      completed++;
      if (attempt) { await unlink(config.attemptPath); attempt = null; }
      await writeState({ phase: 'working', completed, remaining: total - completed, lastCompletedWalletNumber: item.walletNumber });
    }
    await writeState({ phase: stopped ? 'stopped' : 'completed', currentWalletNumber: null });
    return state;
  } catch (error) {
    if (!releaseProfile) throw new WorkerError(safeErrorCode(error));
    const code = safeErrorCode(error);
    const uiState = sanitizeUiObservation(error?.uiState);
    // A failed atomic writer must not keep masking the terminal state write.
    await writeQueue.catch(() => {});
    writeQueue = Promise.resolve();
    await writeState({ phase: 'failed', errorCode: code,
      ...(Object.keys(uiState).length ? { uiState } : {}) }).catch(() => {});
    return { ...state, phase: 'failed', errorCode: code };
  } finally {
    if (timer) clearInterval(timer);
    await runner?.cleanup?.().catch(() => {});
    await browser?.close?.().catch(() => {});
    await writeQueue.catch(() => {});
    await releaseProfile?.();
    await releaseGlobal?.();
    finishLease?.();
  }
}
