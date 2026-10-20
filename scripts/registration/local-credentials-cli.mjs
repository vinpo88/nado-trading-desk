#!/usr/bin/env node
// Passwords enter only through an interactive, non-echoing terminal. Never
// accept them through arguments, environment variables, or plaintext files.
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const HELP = `设置本机保险库自动解锁凭据（仅 Windows）
node scripts/registration/local-credentials-cli.mjs store --name registration-vault --profiles registration-edge,registration-chrome
密码只能在本机交互式终端输入两次，不回显；不接受密码参数、环境变量或明文文件。
凭据仅供指定专用浏览器配置使用。请在执行器配置中显式设置 autoUnlockCredential。
Ctrl+C 取消；Backspace 删除一个字符；Ctrl+U 清空本次输入。`;
const ERRORS = Object.freeze({
  ARGS_INVALID: '参数无效。仅支持 store --name NAME --profiles PROFILE[,PROFILE...]；请查看 --help。',
  WINDOWS_REQUIRED: '此命令只支持 Windows 本机终端。',
  TTY_REQUIRED: '请在交互式终端运行；密码不能通过管道或重定向输入，输出也不能重定向。',
  PASSWORD_INVALID: '密码需为 8–4096 个字符，且不能包含控制字符。',
  PASSWORD_MISMATCH: '两次密码输入不一致，未保存凭据。',
  CANCELLED: '已取消，未保存凭据。',
  TERMINAL_FAILED: '终端输入失败，未保存凭据。',
  STORE_FAILED: '凭据未能安全保存。请检查本机凭据存储设置；未输出内部错误。',
});

export class CredentialCliError extends Error {
  constructor(code) {
    super(ERRORS[code] ?? ERRORS.STORE_FAILED);
    this.name = 'CredentialCliError';
    this.code = Object.hasOwn(ERRORS, code) ? code : 'STORE_FAILED';
  }
}

export function parseLocalCredentialArgs(args) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new CredentialCliError('ARGS_INVALID');
  if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) return { help: true };
  if (args[0] !== 'store') throw new CredentialCliError('ARGS_INVALID');
  const parsed = {};
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    if (!['--name', '--profiles'].includes(flag) || !args[index + 1]
      || Object.hasOwn(parsed, flag)) throw new CredentialCliError('ARGS_INVALID');
    parsed[flag] = args[index + 1];
  }
  const credentialName = parsed['--name'];
  const profiles = parsed['--profiles']?.split(',');
  if (!NAME.test(credentialName ?? '') || !profiles?.length || profiles.length > 32
    || profiles.some(value => !NAME.test(value)) || new Set(profiles).size !== profiles.length) throw new CredentialCliError('ARGS_INVALID');
  return { command: 'store', credentialName, profiles };
}

function assertTerminal(input, output) {
  if (input?.isTTY !== true || output?.isTTY !== true || typeof input.setRawMode !== 'function') {
    throw new CredentialCliError('TTY_REQUIRED');
  }
}

export function readConfirmedPassword({ input = process.stdin, output = process.stdout } = {}) {
  assertTerminal(input, output);
  return new Promise((resolvePassword, rejectPassword) => {
    const wasRaw = input.isRaw === true;
    const wasFlowing = input.readableFlowing === true;
    const decoder = new StringDecoder('utf8');
    let first = '';
    let characters = [];
    let phase = 0;
    let length = 0;
    let ignoreLineFeed = false;
    let settled = false;
    const finish = (error, password = '') => {
      if (settled) return;
      settled = true;
      first = ''; characters.fill(''); characters = []; length = 0;
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      try { input.setRawMode(wasRaw); if (!wasFlowing) input.pause(); }
      catch { error = new CredentialCliError('TERMINAL_FAILED'); }
      try { output.write('\n'); }
      catch { error = new CredentialCliError('TERMINAL_FAILED'); }
      if (error) rejectPassword(error);
      else resolvePassword(password);
    };
    const onEnd = () => finish(new CredentialCliError('CANCELLED'));
    const onError = () => finish(new CredentialCliError('TERMINAL_FAILED'));
    const onData = chunk => {
      try {
        const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
        for (const character of text) {
          if (settled) break;
          if (ignoreLineFeed && character === '\n') { ignoreLineFeed = false; continue; }
          ignoreLineFeed = false;
          if (['\x03', '\x04', '\x1a'].includes(character)) { onEnd(); break; }
          if (character === '\b' || character === '\x7f') {
            length -= (characters.pop() ?? '').length;
            continue;
          }
          if (character === '\x15') { characters.fill(''); characters = []; length = 0; continue; }
          if (character === '\r' || character === '\n') {
            ignoreLineFeed = character === '\r';
            if (length < 8) { finish(new CredentialCliError('PASSWORD_INVALID')); break; }
            const value = characters.join('');
            characters.fill(''); characters = []; length = 0;
            if (phase === 0) { first = value; phase = 1; output.write('\n再次输入保险库密码（不回显）：'); }
            else if (value !== first) finish(new CredentialCliError('PASSWORD_MISMATCH'));
            else finish(null, value);
            continue;
          }
          if (/[\x00-\x1f\x7f-\x9f]/u.test(character)) { finish(new CredentialCliError('PASSWORD_INVALID')); break; }
          length += character.length;
          if (length > 4096) { finish(new CredentialCliError('PASSWORD_INVALID')); break; }
          characters.push(character);
        }
      } catch { finish(new CredentialCliError('TERMINAL_FAILED')); }
    };
    try {
      input.setRawMode(true);
      input.on('data', onData);
      input.once('end', onEnd);
      input.once('error', onError);
      output.write('输入保险库密码（不回显）：');
      input.resume();
    } catch { finish(new CredentialCliError('TERMINAL_FAILED')); }
  });
}

export async function runLocalCredentialsCli(args, {
  input = process.stdin, output = process.stdout, platform = process.platform,
  store = async (...values) => (await import('./local-credentials.mjs')).storeLocalCredential(...values),
} = {}) {
  const options = parseLocalCredentialArgs(args);
  if (options.help) { output.write(HELP + '\n'); return; }
  if (platform !== 'win32') throw new CredentialCliError('WINDOWS_REQUIRED');
  assertTerminal(input, output);
  let password = await readConfirmedPassword({ input, output });
  try {
    await store(REPO, { credentialName: options.credentialName, password, profiles: options.profiles });
  } catch { throw new CredentialCliError('STORE_FAILED'); }
  finally { password = ''; }
  // Never print the storage implementation's return value or exception.
  output.write('已保存本机加密凭据。仅指定的专用浏览器配置可使用。\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runLocalCredentialsCli(process.argv.slice(2)).catch(error => {
    process.stderr.write((error instanceof CredentialCliError ? error.message : ERRORS.STORE_FAILED) + '\n');
    process.exitCode = 1;
  });
}
