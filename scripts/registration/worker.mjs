#!/usr/bin/env node
// A dedicated local browser worker. Never attaches to a user's existing profile.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  WorkerError, safeErrorCode, loadWorkerConfig, readPublicJson, pidAlive,
  runWorker, workerStatus, requestWorkerStop, requestWorkerResume, acceptWorkerTerms, recoverWorkerLocks,
} from './runtime.mjs';
import { validateWalletManifest } from './planner.mjs';
import { tryAutoUnlock } from './local-credentials.mjs';

const ENTRY = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(ENTRY), '../..');
const HELP = `本地独立注册执行器（仅使用新的专用浏览器）
node scripts/registration/worker.mjs open|start|run|status|stop --config FILE
node scripts/registration/worker.mjs accept-terms --config FILE --digest SHA256
node scripts/registration/worker.mjs resume-connection --config FILE --attention-id UUID
node scripts/registration/worker.mjs recover-locks --config FILE --confirm-closed
open：打开专用浏览器，供手动恢复保险库和导出公开地址清单；不会注册或签名。
start：隐藏后台 Node 进程，显示专用浏览器；run：在当前终端运行。
stop：完成当前钱包并保存后停止；等待解锁、条款或人工检查时及时停止。
waiting_attention：保留已安全断开的专用浏览器供检查，不会自动重试；stop 或关闭窗口后结束。
resume-connection：仅对状态明确提供 canResumeConnection=true 的本次暂停恢复连接，保留同一钱包和原调度器，不影响其他成员。
status：只读进程和进度；accept-terms：明确确认当前运行候选文件中的六项声明。
可选 approvedTermsDigest 固定已批准的条款内容摘要，内容匹配时自动生成本次确认；声明或链接变化仍等待确认。
必须自行恢复保险库；默认手动解锁，可选 Windows 本机加密凭据自动解锁，不复制其他浏览器的数据。
默认从 10000 倒序，采用配置中的公开清单和已核验进度。`;
const ERROR_TEXT = {
  CONFIG_INVALID: '配置无效，请使用 registration.worker.example.json 的字段。',
  PUBLIC_FILE_INVALID: '公开地址清单或进度文件无效；首次使用请先运行 open 并自行导出清单。',
  WORKER_ALREADY_RUNNING: '已有执行器占用专用浏览器或系统剪贴板，请先查看状态。',
  WORKER_LOCK_STALE: '检测到未正常释放的进程锁；请确认旧执行器和专用浏览器都已关闭后，由人工清理锁文件。',
  PROFILE_NOT_DEDICATED: '目录不是本程序创建的专用浏览器目录，已拒绝使用。',
  BROWSER_START_FAILED: '专用浏览器未能启动或页面未就绪，请检查浏览器安装与本地服务。',
  STORAGE_ERROR: '本地运行状态或进度无法安全保存，已停止。',
  NOT_RUNNING: '此配置没有正在运行的执行器。',
  CONFIRMATION_INVALID: '条款候选、摘要或当前运行不匹配，未确认。',
};
const print = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const delay = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));

export function parseWorkerArgs(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) return { help: true };
  const command = args[0];
  if (!['open', 'start', 'run', 'status', 'stop', 'accept-terms', 'recover-locks', 'resume-connection'].includes(command)) throw new WorkerError('CONFIG_INVALID');
  const result = { command };
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--setup' && command === 'run' && !result.setup) { result.setup = true; continue; }
    if (flag === '--confirm-closed' && command === 'recover-locks' && !result.confirmClosed) { result.confirmClosed = true; continue; }
    if (!['--config', '--digest', '--run-id', '--attention-id'].includes(flag) || !args[index + 1] || args[index + 1].startsWith('--')) throw new WorkerError('CONFIG_INVALID');
    const key = flag.slice(2);
    if (result[key] !== undefined) throw new WorkerError('CONFIG_INVALID');
    result[key] = args[++index];
  }
  if (!result.config || (result.digest !== undefined && command !== 'accept-terms')
    || (command === 'resume-connection' && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(result['attention-id'] ?? ''))
    || (result['attention-id'] !== undefined && command !== 'resume-connection')
    || (result['run-id'] !== undefined && (command !== 'run' || !/^[a-f0-9-]{36}$/.test(result['run-id'])))) throw new WorkerError('CONFIG_INVALID');
  return result;
}

export async function launchDedicatedBrowser(config, { chromium } = {}) {
  // Resolve the pinned workspace dependency, without downloading tools at runtime.
  if (!chromium) {
    const require = createRequire(resolve(REPO, 'apps/console/package.json'));
    ({ chromium } = require('@playwright/test'));
  }
  let context;
  try {
    context = await chromium.launchPersistentContext(config.profileDir, {
      ...(config.browser === 'chromium' ? {} : { channel: config.browser === 'edge' ? 'msedge' : 'chrome' }),
      headless: false,
      viewport: { width: 1440, height: 1000 },
      // Intentionally no trace, HAR, video, CDP connection, storageState or extension.
    });
    let closed = false;
    context.on('close', () => { closed = true; });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://app.nado.xyz' });
    const localPage = await context.newPage();
    const nadoPage = await context.newPage();
    // Close only tabs belonging to this marked, dedicated profile. This prevents
    // an old local authorization page from surviving alongside a new worker.
    for (const page of context.pages()) if (page !== localPage && page !== nadoPage) await page.close({ runBeforeUnload: false });
    await localPage.goto(config.localUrl, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
    // Failure leaves the existing vault locked for manual input. Never log a
    // Playwright error from this operation: it could include the input value.
    await tryAutoUnlock(config, { localPage });
    await nadoPage.goto('https://app.nado.xyz/perpetuals?market=BTC', { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
    await localPage.bringToFront();
    return {
      localPage, nadoPage,
      isClosed: () => closed || localPage.isClosed() || nadoPage.isClosed(),
      close: () => context.close(),
    };
  } catch {
    const error = new WorkerError('BROWSER_START_FAILED');
    error.browserCloseConfirmed = false;
    // A rejected launch can have spawned a browser before returning a context.
    // Only an awaited close on a context we actually own proves it is gone.
    if (context) {
      try { await context.close(); error.browserCloseConfirmed = true; }
      catch {}
    }
    throw error;
  }
}

export async function prepareManifestFromVisibleUi(config, browser, { shouldStop, onStage }) {
  const page = browser.localPage;
  let stage;
  const setStage = async next => { if (stage !== next) { stage = next; await onStage(next); } };
  try {
    while (!(await shouldStop())) {
      const url = new URL(page.url());
      if (url.href !== config.localUrl) throw new WorkerError('ORIGIN_MISMATCH');
      if (!await page.getByTestId('connect-wallet-address').isVisible()) {
        await setStage('waiting_unlock');
        await delay(config.pollIntervalMs);
        continue;
      }
      const exportButton = page.getByRole('button', { name: '导出编号与地址清单', exact: true });
      if (await exportButton.count() !== 1 || !await exportButton.isVisible() || !await exportButton.isEnabled()) {
        await setStage('waiting_manifest_export');
        await delay(config.pollIntervalMs);
        continue;
      }
      if (await shouldStop()) return null;
      await setStage('exporting_manifest');
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: config.timeoutMs }),
        exportButton.click({ timeout: config.timeoutMs }),
      ]);
      const stream = await download.createReadStream();
      if (!stream) throw new WorkerError('PUBLIC_FILE_INVALID');
      const chunks = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > 64 * 1024 * 1024 || await shouldStop()) {
          stream.destroy();
          if (size > 64 * 1024 * 1024) throw new WorkerError('PUBLIC_FILE_INVALID');
          return null;
        }
        chunks.push(chunk);
      }
      return validateWalletManifest(JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')));
    }
    return null;
  } catch (error) {
    if (await shouldStop()) return null;
    throw new WorkerError(error instanceof WorkerError ? error.code : 'PUBLIC_FILE_INVALID');
  }
}

async function startDetached(config, setup) {
  const lock = await readPublicJson(config.globalLockPath, { optional: true });
  if (lock) throw new WorkerError(pidAlive(lock.pid) ? 'WORKER_ALREADY_RUNNING' : 'WORKER_LOCK_STALE');
  const runId = randomUUID();
  const args = [ENTRY, 'run', '--config', config.configPath, '--run-id', runId, ...(setup ? ['--setup'] : [])];
  const child = spawn(process.execPath, args, { cwd: REPO, detached: true, windowsHide: true, stdio: 'ignore' });
  let failed = false;
  child.on('error', () => { failed = true; });
  child.unref();
  for (let attempt = 0; attempt < 50; attempt++) {
    if (failed) throw new WorkerError('BROWSER_START_FAILED');
    const status = await workerStatus(config);
    if (status.runId === runId) return { ...status, mode: setup ? 'setup' : 'registration' };
    if (child.pid && !pidAlive(child.pid)) {
      const owner = await readPublicJson(config.globalLockPath, { optional: true });
      throw new WorkerError(owner ? 'WORKER_ALREADY_RUNNING' : 'RUNNER_FAILED');
    }
    await delay(100);
  }
  // A delayed child is not restarted. Its PID is reported for a later read-only check.
  return { phase: 'starting', runId, pid: child.pid, mode: setup ? 'setup' : 'registration' };
}

export async function runWorkerCli(args, output = print) {
  const options = parseWorkerArgs(args);
  if (options.help) { process.stdout.write(HELP + '\n'); return; }
  const config = await loadWorkerConfig(resolve(options.config), REPO);
  if (options.command === 'status') { output(await workerStatus(config)); return; }
  if (options.command === 'stop') { output(await requestWorkerStop(config)); return; }
  if (options.command === 'resume-connection') { output(await requestWorkerResume(config, options['attention-id'])); return; }
  if (options.command === 'accept-terms') { output(await acceptWorkerTerms(config, options.digest)); return; }
  if (options.command === 'recover-locks') { output(await recoverWorkerLocks(config, options.confirmClosed)); return; }
  if (options.command === 'start' || options.command === 'open') {
    output(await startDetached(config, options.command === 'open')); return;
  }
  let stop = false;
  const stopSignal = () => { stop = true; };
  process.on('SIGINT', stopSignal); process.on('SIGTERM', stopSignal);
  try {
    const { createPlaywrightNadoRunner } = await import('./playwright-runner.mjs');
    const state = await runWorker(config, {
      launch: launchDedicatedBrowser, prepareManifest: prepareManifestFromVisibleUi,
      createRunner: createPlaywrightNadoRunner, shouldStop: () => stop,
    }, { setup: options.setup, runId: options['run-id'] });
    output(state);
    if (state.phase === 'failed') process.exitCode = 1;
  } finally {
    process.off('SIGINT', stopSignal); process.off('SIGTERM', stopSignal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Unknown exceptions are deliberately never printed or serialized.
  runWorkerCli(process.argv.slice(2)).catch(error => {
    const code = safeErrorCode(error);
    print({ phase: 'failed', errorCode: code, message: ERROR_TEXT[code] ?? '状态无法安全核实，已停止；请人工检查后再启动。' });
    process.exitCode = 1;
  });
}
