#!/usr/bin/env node
// This CLI handles public files only. It cannot connect, sign, register, or unlock wallets.
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPlan, getStatus, mergeProgress, normalizeConfig, validateWalletManifest } from './planner.mjs';

const HELP = `公开地址注册计划（不控制浏览器、不读取保险库）
node scripts/registration/cli.mjs plan|status|merge --config FILE --wallets FILE [--progress FILE ...] [--output FILE]
--config 可省略：默认 10000→1，单分片。
--wallets 为 [{ "walletNumber": 1, "address": "0x..." }] 公开 JSON 清单。
--progress 可重复，接受 NDJSON 或 JSON 数组；显式文件不存在会报错。
--output 只创建新文件，已有文件不覆盖；省略时输出到 stdout。
merge 输出规范 NDJSON，其余输出 JSON。所有相对路径以当前目录为准；
配置文件中的路径以配置文件所在目录为准。`;
const FILE_KEYS = new Set(['bounds', 'start', 'end', 'direction', 'laneCount', 'laneIndex', 'walletsPath', 'progressPaths', 'progressPath', 'usernamePrefix', 'browser']);

async function publicText(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('输入必须为不超过 64 MiB 的公开文件');
  return (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
}
function json(text, message) {
  try { return JSON.parse(text); } catch { throw new Error(message); }
}
export function parseProgress(text) {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const records = json(trimmed, '进度 JSON 无效');
    if (!Array.isArray(records)) throw new Error('进度 JSON 必须是数组');
    return records;
  }
  return trimmed.split(/\r?\n/).filter(line => line.trim()).map((line, index) => json(line, `第 ${index + 1} 行进度 JSON 无效`));
}

export async function runCli(args, stdout = text => process.stdout.write(text)) {
  if (!args.length || args.includes('--help') || args.includes('-h')) { stdout(HELP + '\n'); return; }
  const command = args[0];
  if (!['plan', 'status', 'merge'].includes(command)) throw new Error('命令只能是 plan、status 或 merge');
  const options = { progress: [] };
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    if (!['--config', '--wallets', '--progress', '--output'].includes(flag) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('命令参数无效，请查看 --help');
    const name = flag.slice(2);
    if (name === 'progress') options.progress.push(args[index + 1]);
    else if (options[name] !== undefined) throw new Error('命令参数重复');
    else options[name] = args[index + 1];
  }
  let fileConfig = {};
  let base = process.cwd();
  if (options.config) {
    const configPath = resolve(options.config);
    base = dirname(configPath);
    fileConfig = json(await publicText(configPath), '配置 JSON 无效');
    if (!fileConfig || typeof fileConfig !== 'object' || Array.isArray(fileConfig) || Object.keys(fileConfig).some(key => !FILE_KEYS.has(key))) throw new Error('配置含未知字段或不是对象');
  }
  const planInput = {};
  for (const key of ['bounds', 'start', 'end', 'direction', 'laneCount', 'laneIndex']) if (fileConfig[key] !== undefined) planInput[key] = fileConfig[key];
  const config = normalizeConfig(planInput);
  if (fileConfig.browser !== undefined && !['iab', 'chrome', 'edge'].includes(fileConfig.browser)) throw new Error('配置 browser 无效');
  if (fileConfig.usernamePrefix !== undefined && (typeof fileConfig.usernamePrefix !== 'string' || !/^[A-Za-z0-9_.]{1,14}$/.test(fileConfig.usernamePrefix))) throw new Error('配置 usernamePrefix 无效');
  for (const key of ['walletsPath', 'progressPath']) if (fileConfig[key] !== undefined && (typeof fileConfig[key] !== 'string' || !fileConfig[key])) throw new Error('配置文件路径无效');
  if (fileConfig.progressPaths !== undefined && (!Array.isArray(fileConfig.progressPaths) || fileConfig.progressPaths.some(path => typeof path !== 'string' || !path))) throw new Error('配置 progressPaths 无效');
  const walletsPath = options.wallets ? resolve(options.wallets) : fileConfig.walletsPath ? resolve(base, fileConfig.walletsPath) : undefined;
  if (!walletsPath) throw new Error('请通过 --wallets 或 walletsPath 指定公开地址清单');
  const manifest = validateWalletManifest(json(await publicText(walletsPath), '公开地址清单 JSON 无效'));
  const configuredProgress = fileConfig.progressPaths ?? (fileConfig.progressPath ? [fileConfig.progressPath] : []);
  const paths = options.progress.length ? options.progress.map(path => resolve(path)) : configuredProgress.map(path => resolve(base, path));
  const sources = await Promise.all(paths.map(async path => parseProgress(await publicText(path))));
  const merged = mergeProgress(sources, manifest);
  const output = command === 'merge'
    ? merged.map(record => JSON.stringify(record)).join('\n') + (merged.length ? '\n' : '')
    : JSON.stringify(command === 'plan' ? createPlan(config, manifest, merged) : getStatus(config, manifest, merged), null, 2) + '\n';
  if (options.output) await writeFile(resolve(options.output), output, { encoding: 'utf8', flag: 'wx' });
  else stdout(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).catch(error => {
    // Parser messages are fixed; filesystem errors only expose their public path/code, never file contents.
    process.stderr.write(`计划未完成：${error?.code ? String(error.code) : error.message}\n`);
    process.exitCode = 1;
  });
}
