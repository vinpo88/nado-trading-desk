import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const probe = spawnSync('git', ['rev-parse', '--show-toplevel'], {
  cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
});
const samePath = (value) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
if (probe.status === 0 && samePath(probe.stdout.trim()) === samePath(cwd)) {
  const result = spawnSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], {
    cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (result.status !== 0) console.warn('Git hooks were not installed; run the redaction checks before committing.');
}
