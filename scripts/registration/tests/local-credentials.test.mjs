import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLocalCredentialManager, storeLocalCredential, loadLocalCredential } from '../local-credentials.mjs';

const SYNTHETIC_PASSWORD = 'fixture-only-password-123';
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'nado-credential-test-'));
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(root));
    assert.ok(rel.startsWith('nado-credential-test-') && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
function fakeProtectedHelper() {
  // Fake protection stays in this test process; never a production fallback.
  const protectedRecords = new Map();
  const calls = [];
  return {
    calls,
    invoke: async request => {
      calls.push({ action: request.action, credentialName: request.credentialName });
      const key = `${request.repoDir}/${request.credentialName}`;
      if (request.action === 'store') {
        protectedRecords.set(key, structuredClone(request.payload));
        return { stored: true };
      }
      if (!protectedRecords.has(key)) throw new Error('synthetic provider detail must not escape');
      return structuredClone(protectedRecords.get(key));
    },
  };
}
async function fixture(t, pageOptions = {}, managerOptions = {}) {
  const repoDir = await temporary(t);
  const helper = fakeProtectedHelper();
  const manager = createLocalCredentialManager({ platform: 'win32', invoke: helper.invoke, ...managerOptions });
  await manager.storeLocalCredential(repoDir, { credentialName: 'test-vault', password: SYNTHETIC_PASSWORD,
    profiles: ['edge-test', 'chrome-test'] });
  const config = { repoDir, profileName: 'edge-test', autoUnlockCredential: 'test-vault',
    localUrl: 'http://127.0.0.1:18270/connect', timeoutMs: 1000 };
  const page = fakePage(pageOptions);
  return { manager, helper, config, page, browser: { localPage: page } };
}
function fakePage(options = {}) {
  const state = {
    mode: 'locked', url: 'http://127.0.0.1:18270/connect', closed: false, fieldValue: '',
    fills: [], clicks: 0, waits: 0, readyAfterWait: false, type: 'password', autocomplete: 'current-password',
    forms: 1, inputs: 1, dialog: false, disabled: false, wrongPassword: false, ...options,
  };
  function locator(kind) {
    const loc = {
      or: () => locator('ready'),
      first: () => loc,
      filter: () => loc,
      getByRole: () => locator('submit'),
      count: async () => {
        if (kind === 'heading') return state.mode === 'locked' ? 1 : 0;
        if (kind === 'password') return state.inputs;
        if (kind === 'form') return state.forms;
        if (kind === 'dialog') return state.dialog ? 1 : 0;
        if (kind === 'confirm' || kind === 'createButton') return state.mode === 'create' ? 1 : 0;
        return 1;
      },
      isVisible: async () => {
        if (kind === 'unlocked') return state.mode === 'unlocked';
        if (kind === 'createHeading') return state.mode === 'create';
        if (['heading', 'password', 'submit'].includes(kind)) return state.mode === 'locked';
        return true;
      },
      isEnabled: async () => kind === 'submit' ? !!state.fieldValue && !state.disabled : !state.disabled,
      getAttribute: async key => {
        if (key === 'type') return kind === 'submit' ? 'submit' : state.type;
        if (key === 'autocomplete') return state.autocomplete;
        return null;
      },
      waitFor: async () => {
        state.waits++;
        if (kind === 'ready' && state.readyAfterWait) state.mode = 'locked';
        if (kind === 'unlocked' && state.mode !== 'unlocked') throw new Error('synthetic TimeoutError');
      },
      fill: async value => {
        state.fills.push(value === '' ? 'clear' : 'secret');
        state.fieldValue = value;
        if (state.fillError) throw new Error(`synthetic fill error ${value}`);
        if (state.navigateAfterFill) state.url = 'https://example.invalid/connect';
      },
      click: async () => {
        state.clicks++;
        if (!state.wrongPassword) state.mode = 'unlocked';
      },
    };
    return loc;
  }
  return {
    state, isClosed: () => state.closed, url: () => state.url,
    getByTestId: () => locator('unlocked'),
    getByRole: (role, query) => {
      if (role === 'button') return locator('createButton');
      return locator(query.name.includes('创建') ? 'createHeading' : 'heading');
    },
    getByLabel: name => locator(name === '保险库密码' ? 'password' : 'confirm'),
    locator: selector => locator(selector === 'form' ? 'form' : 'dialog'),
  };
}

test('fake helper store/load validates metadata and profile binding', async t => {
  const { manager, config } = await fixture(t);
  assert.ok(await manager.loadLocalCredential(config.repoDir, 'test-vault', 'edge-test') === SYNTHETIC_PASSWORD);
  assert.ok(await manager.loadLocalCredential(config.repoDir, 'test-vault', 'chrome-test') === SYNTHETIC_PASSWORD);
  await assert.rejects(manager.loadLocalCredential(config.repoDir, 'test-vault', 'other-profile'),
    { code: 'CREDENTIAL_PROFILE_DENIED' });
});

test('rejects unsafe names, duplicate profiles, unknown fields and unsupported platform', async t => {
  const repoDir = await temporary(t);
  let calls = 0;
  const manager = createLocalCredentialManager({ platform: 'win32', invoke: async () => { calls++; } });
  const good = { credentialName: 'test', password: SYNTHETIC_PASSWORD, profiles: ['edge-test'] };
  for (const options of [
    { ...good, credentialName: '../escape' }, { ...good, profiles: ['edge-test', 'edge-test'] },
    { ...good, profiles: [] }, { ...good, password: 'short' }, { ...good, extra: true },
  ]) await assert.rejects(manager.storeLocalCredential(repoDir, options), { code: 'CREDENTIAL_INVALID' });
  assert.equal(calls, 0);
  await assert.rejects(createLocalCredentialManager({ platform: 'linux' }).storeLocalCredential(repoDir, good),
    { code: 'CREDENTIAL_PLATFORM_UNSUPPORTED' });
});

test('raw helper errors and malformed decrypted payloads never escape', async t => {
  const repoDir = await temporary(t);
  const secretSentinel = 'synthetic-provider-secret';
  for (const invoke of [
    async () => { throw new Error(secretSentinel); },
    async () => ({ formatVersion: 1, credentialName: 'test', profiles: ['edge-test'], password: SYNTHETIC_PASSWORD, extra: true }),
    async () => ({ formatVersion: 1, credentialName: 'other', profiles: ['edge-test'], password: SYNTHETIC_PASSWORD }),
  ]) {
    const manager = createLocalCredentialManager({ platform: 'win32', invoke });
    await assert.rejects(manager.loadLocalCredential(repoDir, 'test', 'edge-test'),
      error => error.code === 'CREDENTIAL_UNAVAILABLE' && !String(error.stack).includes(secretSentinel));
  }
});

test('repository junction is rejected before the helper is called', async t => {
  const root = await temporary(t);
  const real = join(root, 'real');
  const link = join(root, 'alias');
  await mkdir(real);
  await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  let calls = 0;
  const manager = createLocalCredentialManager({ platform: 'win32', invoke: async () => { calls++; } });
  await assert.rejects(manager.loadLocalCredential(link, 'test', 'edge-test'), { code: 'CREDENTIAL_UNAVAILABLE' });
  assert.equal(calls, 0);
});

test('auto unlock no config is a strict no-op', async () => {
  const manager = createLocalCredentialManager();
  assert.deepEqual(await manager.tryAutoUnlock({}, {}), { attempted: false, unlocked: false });
});

test('waits for UI readiness then fills and submits exactly once', async t => {
  const { manager, config, browser, page } = await fixture(t, { mode: 'loading', readyAfterWait: true });
  assert.deepEqual(await manager.tryAutoUnlock(config, browser), { attempted: true, unlocked: true });
  assert.deepEqual(page.state.fills, ['secret']);
  assert.equal(page.state.clicks, 1);
  assert.ok(page.state.waits >= 2);
  assert.deepEqual(await manager.tryAutoUnlock(config, browser),
    { attempted: false, unlocked: false, errorCode: 'AUTO_UNLOCK_ALREADY_ATTEMPTED' });
  assert.equal(page.state.clicks, 1);
});

test('already unlocked or create-vault pages never receive a secret', async t => {
  for (const mode of ['unlocked', 'create']) {
    const { manager, config, browser, page, helper } = await fixture(t, { mode });
    const result = await manager.tryAutoUnlock(config, browser);
    assert.equal(result.attempted, false);
    assert.equal(result.unlocked, mode === 'unlocked');
    assert.equal(page.state.clicks, 0);
    assert.deepEqual(page.state.fills, []);
    assert.equal(helper.calls.filter(call => call.action === 'load').length, 0);
  }
});

test('origin, form, autocomplete and dialog guards fail before decrypt or fill', async t => {
  for (const options of [
    { url: 'http://localhost:18270/connect' }, { url: 'https://example.invalid/connect' },
    { url: 'http://127.0.0.1:18270/connect?redirect=evil' }, { forms: 2 }, { inputs: 2 },
    { type: 'text' }, { autocomplete: 'new-password' }, { dialog: true }, { disabled: true },
  ]) {
    const { manager, config, browser, page, helper } = await fixture(t, options);
    const result = await manager.tryAutoUnlock(config, browser);
    assert.equal(result.unlocked, false);
    assert.equal(page.state.clicks, 0);
    assert.deepEqual(page.state.fills, []);
    assert.equal(helper.calls.filter(call => call.action === 'load').length, 0);
  }
});

test('wrong password requires manual intervention without retry or closing the page', async t => {
  const { manager, config, browser, page } = await fixture(t, { wrongPassword: true });
  assert.deepEqual(await manager.tryAutoUnlock(config, browser),
    { attempted: true, unlocked: false, errorCode: 'AUTO_UNLOCK_FAILED' });
  await manager.tryAutoUnlock(config, browser);
  assert.equal(page.state.clicks, 1);
  assert.deepEqual(page.state.fills, ['secret', 'clear']);
  assert.equal(page.state.closed, false);
});

test('fill errors containing passwords are sanitized and never cause a click', async t => {
  const { manager, config, browser, page } = await fixture(t, { fillError: true });
  const result = await manager.tryAutoUnlock(config, browser);
  assert.equal(result.errorCode, 'AUTO_UNLOCK_FAILED');
  assert.ok(!JSON.stringify(result).includes(SYNTHETIC_PASSWORD));
  assert.equal(page.state.clicks, 0);
});

test('navigation after fill prevents submit and no secret is sent to the new page', async t => {
  const { manager, config, browser, page } = await fixture(t, { navigateAfterFill: true });
  const result = await manager.tryAutoUnlock(config, browser);
  assert.equal(result.errorCode, 'AUTO_UNLOCK_ORIGIN_MISMATCH');
  assert.equal(page.state.clicks, 0);
  assert.deepEqual(page.state.fills, ['secret']);
});

test('concurrent calls can consume only one automatic attempt', async t => {
  const { manager, config, browser, page } = await fixture(t);
  const results = await Promise.all([manager.tryAutoUnlock(config, browser), manager.tryAutoUnlock(config, browser)]);
  assert.equal(results.filter(result => result.unlocked).length, 1);
  assert.equal(page.state.clicks, 1);
  assert.deepEqual(page.state.fills, ['secret']);
});

test('Windows DPAPI synthetic roundtrip, replacement, binding and tampering', { skip: process.platform !== 'win32' }, async t => {
  const repoDir = await temporary(t);
  // Generated only inside this isolated test; do not put it in assertion output.
  const password = randomBytes(32).toString('base64');
  const options = { credentialName: 'synthetic-vault', password, profiles: ['edge-test', 'chrome-test'] };
  assert.equal((await storeLocalCredential(repoDir, options)).stored, true);
  assert.ok(await loadLocalCredential(repoDir, options.credentialName, 'edge-test') === password);
  assert.ok(await loadLocalCredential(repoDir, options.credentialName, 'chrome-test') === password);
  await assert.rejects(loadLocalCredential(repoDir, options.credentialName, 'wrong-profile'), { code: 'CREDENTIAL_PROFILE_DENIED' });
  const path = join(repoDir, '.local', 'credentials', 'synthetic-vault.dpapi');
  const encrypted = await readFile(path);
  assert.ok(!encrypted.includes(Buffer.from(password)));
  assert.equal(encrypted.subarray(0, 20).toString('hex'), '01000000d08c9ddf0115d1118c7a00c04fc297eb');
  // Replacement is atomic and still keeps the current-user ACL enforced by load.
  await storeLocalCredential(repoDir, options);
  assert.ok(await loadLocalCredential(repoDir, options.credentialName, 'edge-test') === password);
  await storeLocalCredential(repoDir, { ...options, credentialName: 'other-name' });
  await writeFile(join(repoDir, '.local', 'credentials', 'other-name.dpapi'), encrypted);
  await assert.rejects(loadLocalCredential(repoDir, 'other-name', 'edge-test'), { code: 'CREDENTIAL_UNAVAILABLE' });
  encrypted[Math.floor(encrypted.length / 2)] ^= 1;
  await writeFile(path, encrypted);
  await assert.rejects(loadLocalCredential(repoDir, options.credentialName, 'edge-test'), { code: 'CREDENTIAL_UNAVAILABLE' });
});
