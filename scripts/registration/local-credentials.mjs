// Local opt-in convenience only. No credential is sent to a website, argv,
// environment variable, event callback, or plaintext file by this module.
import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = fileURLToPath(new URL('./local-credentials.ps1', import.meta.url));
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CODES = new Set(['CREDENTIAL_INVALID', 'CREDENTIAL_UNAVAILABLE', 'CREDENTIAL_PROFILE_DENIED',
  'CREDENTIAL_PLATFORM_UNSUPPORTED', 'AUTO_UNLOCK_ORIGIN_MISMATCH', 'AUTO_UNLOCK_FORM_UNAVAILABLE',
  'AUTO_UNLOCK_ALREADY_ATTEMPTED', 'AUTO_UNLOCK_FAILED']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && Object.keys(value).every(key => keys.includes(key));
const validName = value => typeof value === 'string' && NAME.test(value);
const validPassword = value => typeof value === 'string' && value.length >= 8 && value.length <= 4096
  && !value.includes('\0');
const validProfiles = value => Array.isArray(value) && value.length >= 1 && value.length <= 32
  && value.every(validName) && new Set(value).size === value.length;

export class LocalCredentialError extends Error {
  constructor(code) {
    super(CODES.has(code) ? code : 'CREDENTIAL_UNAVAILABLE');
    this.name = 'LocalCredentialError';
    this.code = this.message;
  }
}
const fail = code => { throw new LocalCredentialError(code); };
const safeCode = error => error instanceof LocalCredentialError ? error.code : 'CREDENTIAL_UNAVAILABLE';

async function canonicalRepository(repoDir) {
  if (typeof repoDir !== 'string' || !isAbsolute(repoDir) || repoDir.includes('\0')) fail('CREDENTIAL_INVALID');
  const target = resolve(repoDir);
  // Reject junctions as well as symlinks, including ancestors of the repository.
  let cursor = target;
  while (true) {
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('CREDENTIAL_UNAVAILABLE');
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return realpath(target);
}

async function invokeWindowsHelper(request) {
  if (process.platform !== 'win32') fail('CREDENTIAL_PLATFORM_UNSUPPORTED');
  // This trusted OS executable and repository helper are the only child command.
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) fail('CREDENTIAL_UNAVAILABLE');
  const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolveResult, rejectResult) => {
    let child;
    let output = '';
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output = '';
      if (error) rejectResult(new LocalCredentialError('CREDENTIAL_UNAVAILABLE'));
      else resolveResult(value);
    };
    try {
      child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.length > 65536) { child.kill(); finish(true); }
      });
      child.on('error', () => finish(true));
      child.stdin.on('error', () => finish(true));
      child.on('close', code => {
        if (code !== 0) return finish(true);
        try { finish(false, JSON.parse(output.replace(/^\uFEFF/, ''))); } catch { finish(true); }
      });
      timer = setTimeout(() => { child.kill(); finish(true); }, 15000);
      // Never put this JSON in command-line arguments or environment variables.
      child.stdin.end(JSON.stringify(request), 'utf8');
    } catch { child?.kill(); finish(true); }
  });
}

function validatePayload(payload, credentialName) {
  if (!exactKeys(payload, ['formatVersion', 'credentialName', 'profiles', 'password'])
    || payload.formatVersion !== 1 || payload.credentialName !== credentialName
    || !validProfiles(payload.profiles) || !validPassword(payload.password)) fail('CREDENTIAL_UNAVAILABLE');
}

// Dependency injection is for isolated tests. Production exports use only the
// fixed Windows helper above and never substitute another protection mechanism.
export function createLocalCredentialManager({ invoke = invokeWindowsHelper, platform = process.platform } = {}) {
  const attemptedPages = new WeakSet();
  async function storeLocalCredential(repoDir, options) {
    try {
      if (platform !== 'win32') fail('CREDENTIAL_PLATFORM_UNSUPPORTED');
      if (!exactKeys(options, ['credentialName', 'password', 'profiles'])
        || !validName(options.credentialName) || !validPassword(options.password)
        || !validProfiles(options.profiles)) fail('CREDENTIAL_INVALID');
      const canonicalRepo = await canonicalRepository(repoDir);
      const result = await invoke({ action: 'store', repoDir: canonicalRepo, credentialName: options.credentialName,
        payload: { formatVersion: 1, credentialName: options.credentialName,
          profiles: [...options.profiles], password: options.password } });
      if (!exactKeys(result, ['stored']) || result.stored !== true) fail('CREDENTIAL_UNAVAILABLE');
      return { stored: true, credentialName: options.credentialName, profiles: [...options.profiles] };
    } catch (error) { throw new LocalCredentialError(safeCode(error)); }
  }
  async function loadLocalCredential(repoDir, credentialName, profileName) {
    let payload;
    try {
      if (platform !== 'win32') fail('CREDENTIAL_PLATFORM_UNSUPPORTED');
      if (!validName(credentialName) || !validName(profileName)) fail('CREDENTIAL_INVALID');
      const canonicalRepo = await canonicalRepository(repoDir);
      payload = await invoke({ action: 'load', repoDir: canonicalRepo, credentialName });
      validatePayload(payload, credentialName);
      if (!payload.profiles.includes(profileName)) fail('CREDENTIAL_PROFILE_DENIED');
      return payload.password;
    } catch (error) { throw new LocalCredentialError(safeCode(error)); }
    finally { if (payload && typeof payload === 'object') payload.password = ''; }
  }

  async function tryAutoUnlock(config, browser) {
    if (config?.autoUnlockCredential === undefined) return { attempted: false, unlocked: false };
    const page = browser?.localPage;
    let attempted = false;
    let password = '';
    let expectedUrl;
    let passwordInput;
    const checkOrigin = () => {
      if (!page || page.isClosed() || page.url() !== expectedUrl) fail('AUTO_UNLOCK_ORIGIN_MISMATCH');
    };
    try {
      const url = new URL(config.localUrl);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/connect'
        || url.username || url.password || url.search || url.hash) fail('AUTO_UNLOCK_ORIGIN_MISMATCH');
      expectedUrl = url.href;
      checkOrigin();
      if (attemptedPages.has(page)) fail('AUTO_UNLOCK_ALREADY_ATTEMPTED');
      const timeout = Number.isSafeInteger(config.timeoutMs) && config.timeoutMs >= 1000 && config.timeoutMs <= 60000
        ? config.timeoutMs : 20000;
      const unlocked = page.getByTestId('connect-wallet-address');
      const unlockHeading = page.getByRole('heading', { name: 'Nado 交易台 · 解锁', exact: true });
      const createHeading = page.getByRole('heading', { name: 'Nado 交易台 · 创建保险库', exact: true });
      await unlocked.or(unlockHeading).or(createHeading).first().waitFor({ state: 'visible', timeout });
      checkOrigin();
      if (await unlocked.isVisible()) { checkOrigin(); return { attempted: false, unlocked: true }; }
      if (await createHeading.isVisible()) fail('AUTO_UNLOCK_FORM_UNAVAILABLE');
      passwordInput = page.getByLabel('保险库密码', { exact: true });
      const form = page.locator('form').filter({ has: passwordInput });
      const submit = form.getByRole('button', { name: '解锁', exact: true });
      const checkForm = async () => {
        checkOrigin();
        const checks = await Promise.all([
          unlockHeading.count(), unlockHeading.isVisible(), passwordInput.count(), passwordInput.isVisible(),
          passwordInput.getAttribute('type'), passwordInput.getAttribute('autocomplete'), passwordInput.isEnabled(),
          form.count(), submit.count(), submit.isVisible(), submit.getAttribute('type'),
          page.getByLabel('确认保险库密码', { exact: true }).count(),
          page.getByRole('button', { name: '创建保险库', exact: true }).count(),
          page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').count(),
        ]);
        checkOrigin();
        if (checks[0] !== 1 || !checks[1] || checks[2] !== 1 || !checks[3] || checks[4] !== 'password'
          || checks[5] !== 'current-password' || !checks[6] || checks[7] !== 1 || checks[8] !== 1
          || !checks[9] || checks[10] !== 'submit' || checks[11] !== 0 || checks[12] !== 0 || checks[13] !== 0)
          fail('AUTO_UNLOCK_FORM_UNAVAILABLE');
      };
      await checkForm();
      // Mark before asynchronous decryption to exclude concurrent callers.
      if (attemptedPages.has(page)) fail('AUTO_UNLOCK_ALREADY_ATTEMPTED');
      attemptedPages.add(page);
      attempted = true;
      password = await loadLocalCredential(config.repoDir, config.autoUnlockCredential, config.profileName);
      await checkForm();
      await passwordInput.fill(password, { timeout });
      password = '';
      await checkForm();
      if (!await submit.isEnabled()) fail('AUTO_UNLOCK_FAILED');
      checkOrigin();
      await submit.click({ timeout });
      checkOrigin();
      await unlocked.waitFor({ state: 'visible', timeout });
      checkOrigin();
      return { attempted: true, unlocked: true };
    } catch (error) {
      // Raw Playwright errors can contain fill values. Never propagate or log.
      const code = error instanceof LocalCredentialError ? error.code : 'AUTO_UNLOCK_FAILED';
      if (attempted && passwordInput) {
        try {
          checkOrigin();
          if (await passwordInput.isVisible() && await passwordInput.getAttribute('autocomplete') === 'current-password') {
            checkOrigin();
            await passwordInput.fill('', { timeout: 1000 });
          }
        } catch { /* Keep the page available for manual recovery. */ }
      }
      return { attempted, unlocked: false, errorCode: code };
    } finally { password = ''; }
  }
  return { storeLocalCredential, loadLocalCredential, tryAutoUnlock };
}

const defaultManager = createLocalCredentialManager();
export const storeLocalCredential = defaultManager.storeLocalCredential;
export const loadLocalCredential = defaultManager.loadLocalCredential;
export const tryAutoUnlock = defaultManager.tryAutoUnlock;
