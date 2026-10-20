import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseLocalCredentialArgs, readConfirmedPassword, runLocalCredentialsCli } from '../local-credentials-cli.mjs';

const args = ['store', '--name', 'registration-vault', '--profiles', 'registration-edge,registration-chrome'];
const secret = 'SYNTHETIC-Vault-Pass';
function terminal() {
  const input = new EventEmitter();
  Object.assign(input, {
    isTTY: true, isRaw: false, readableFlowing: false, rawChanges: [],
    setRawMode(value) { this.isRaw = value; this.rawChanges.push(value); },
    resume() { this.readableFlowing = true; },
    pause() { this.readableFlowing = false; },
  });
  const output = { isTTY: true, text: '', write(text) { this.text += text; } };
  return { input, output, send(text) { input.emit('data', Buffer.from(text)); } };
}

test('credential CLI parses only safe public names and unique profiles', () => {
  assert.deepEqual(parseLocalCredentialArgs(args), {
    command: 'store', credentialName: 'registration-vault', profiles: ['registration-edge', 'registration-chrome'],
  });
  for (const input of [[], ['--help'], ['-h']]) assert.deepEqual(parseLocalCredentialArgs(input), { help: true });
  for (const input of [
    ['load'], [...args, '--password', secret], [...args, '--password-file', 'password.txt'],
    [...args, '--password-env', 'SYNTHETIC_PASSWORD'], [...args, '--repo', 'C:/Other'],
    [...args, '--name', 'other'], [...args, '--help'], [...args, secret],
    ['store', '--name', '../escape', '--profiles', 'edge'],
    ['store', '--name', 'safe', '--profiles', 'edge,edge'],
    ['store', '--name', 'safe', '--profiles', 'edge,,chrome'],
    ['store', '--name', 'safe', '--profiles', 'edge, chrome'],
    ['store', '--name', 'safe', '--profiles', Array.from({ length: 33 }, (_, n) => `profile${n}`).join(',')],
    ['store', '--name', 'safe'], ['store', '--name'], ['store', '--name=safe', '--profiles=edge'],
  ]) assert.throws(() => parseLocalCredentialArgs(input), error => error.code === 'ARGS_INVALID' && !error.message.includes(secret));
});

test('credential CLI requires Windows and both input/output TTY before reading or storing', async () => {
  let stores = 0;
  for (const change of ['platform', 'input', 'output', 'rawMode']) {
    const tty = terminal();
    if (change === 'input') tty.input.isTTY = false;
    if (change === 'output') tty.output.isTTY = false;
    if (change === 'rawMode') delete tty.input.setRawMode;
    await assert.rejects(() => runLocalCredentialsCli(args, {
      ...tty, platform: change === 'platform' ? 'linux' : 'win32', store: () => { stores++; },
    }), error => error.code === (change === 'platform' ? 'WINDOWS_REQUIRED' : 'TTY_REQUIRED'));
    assert.equal(tty.output.text, '');
    assert.equal(tty.input.listenerCount('data'), 0);
  }
  assert.equal(stores, 0);
});

test('credential CLI reads twice without echo, binds the repository root, and never prints storage output', async () => {
  const tty = terminal();
  let saved;
  const pending = runLocalCredentialsCli(args, {
    ...tty, platform: 'win32', store: async (repoDir, options) => { saved = { repoDir, ...options }; return { secret }; },
  });
  assert.equal(tty.input.isRaw, true);
  tty.send(secret + '\r\n' + secret + '\r\n');
  await pending;
  assert.deepEqual(saved, {
    repoDir: resolve(fileURLToPath(new URL('../../..', import.meta.url))),
    credentialName: 'registration-vault', profiles: ['registration-edge', 'registration-chrome'], password: secret,
  });
  assert.equal(tty.output.text.includes(secret), false);
  assert.match(tty.output.text, /再次输入/);
  assert.match(tty.output.text, /已保存本机加密凭据/);
  assert.deepEqual(tty.input.rawChanges, [true, false]);
  assert.equal(tty.input.listenerCount('data'), 0);
});

test('hidden terminal entry handles UTF-8 boundaries, Backspace and clear-line without echo', async () => {
  const tty = terminal();
  const password = '测试密码Abc123';
  const pending = readConfirmedPassword(tty);
  const bytes = Buffer.from('X\b' + password + '\r');
  tty.input.emit('data', bytes.subarray(0, 3));
  tty.input.emit('data', bytes.subarray(3));
  tty.send('discard me\x15' + password + '\r');
  assert.equal(await pending, password);
  assert.equal(tty.output.text.includes(password), false);
  assert.equal(tty.output.text.includes('discard me'), false);
});

test('mismatch, cancel, input failure, short/oversized/control input all restore raw mode and never store', async () => {
  for (const sample of [
    { input: secret + '\rDIFFERENT-PASSWORD\r', code: 'PASSWORD_MISMATCH' },
    { input: secret + '\x03', code: 'CANCELLED' },
    { input: '\x04', code: 'CANCELLED' },
    { input: '\x1a', code: 'CANCELLED' },
    { input: '\r', code: 'PASSWORD_INVALID' },
    { input: 'short\r', code: 'PASSWORD_INVALID' },
    { input: 'x'.repeat(4097), code: 'PASSWORD_INVALID' },
    { input: secret + '\x1b[A', code: 'PASSWORD_INVALID' },
    { event: 'end', code: 'CANCELLED' },
    { event: 'error', code: 'TERMINAL_FAILED' },
  ]) {
    const tty = terminal();
    let stored = false;
    const pending = runLocalCredentialsCli(args, { ...tty, platform: 'win32', store: () => { stored = true; } });
    if (sample.event) tty.input.emit(sample.event, new Error(secret));
    else tty.send(sample.input);
    await assert.rejects(pending, error => error.code === sample.code && !error.message.includes(secret));
    assert.equal(stored, false);
    assert.equal(tty.input.isRaw, false);
    assert.equal(tty.input.listenerCount('data'), 0);
    assert.equal(tty.input.listenerCount('error'), 0);
    assert.equal(tty.output.text.includes(secret), false);
    assert.equal(tty.output.text.includes('已保存'), false);
  }
});

test('storage errors never escape and a previously raw, flowing terminal is restored as found', async () => {
  const tty = terminal();
  tty.input.isRaw = true; tty.input.readableFlowing = true;
  const pending = runLocalCredentialsCli(args, {
    ...tty, platform: 'win32', store: async () => { throw new Error(secret); },
  });
  tty.send(secret + '\r' + secret + '\r');
  await assert.rejects(pending, error => error.code === 'STORE_FAILED' && !error.message.includes(secret));
  assert.deepEqual(tty.input.rawChanges, [true, true]);
  assert.equal(tty.input.readableFlowing, true);
  assert.equal(tty.output.text.includes(secret), false);
  assert.equal(tty.output.text.includes('已保存'), false);
});

test('actual CLI with piped input fails before reading it, even when a password environment variable exists', () => {
  const entry = fileURLToPath(new URL('../local-credentials-cli.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entry, ...args], {
    input: secret + '\n' + secret + '\n', encoding: 'utf8',
    env: { ...process.env, NADO_VAULT_PASSWORD: secret }, windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.equal((result.stdout + result.stderr).includes(secret), false);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, process.platform === 'win32' ? /交互式终端/ : /Windows/);
});
