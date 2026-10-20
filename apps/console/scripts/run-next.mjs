import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
const port = process.env.PORT || '18270';
if (!['dev', 'start'].includes(mode)) {
  console.error('Usage: node scripts/run-next.mjs <dev|start>');
  process.exit(1);
}
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  console.error('PORT must be an integer between 1 and 65535.');
  process.exit(1);
}

const require = createRequire(import.meta.url);
const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), mode, '-H', '127.0.0.1', '-p', port], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: 'inherit',
  windowsHide: true,
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => {
  console.error(`Could not launch Next.js: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
