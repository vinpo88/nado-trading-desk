import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProgress, runCli } from '../cli.mjs';

const manifest = Array.from({ length: 3 }, (_, i) => ({ walletNumber: i + 1, address: '0x' + String(i + 1).padStart(40, '0') }));
const done = number => ({ walletNumber: number, address: manifest[number - 1].address, status: 'verified_login_and_ink', loginComplete: true });
async function files(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nado-public-plan-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'wallets.json'), JSON.stringify(manifest));
  await writeFile(join(dir, 'progress.ndjson'), JSON.stringify(done(3)) + '\n');
  await writeFile(join(dir, 'config.json'), JSON.stringify({ bounds: { min: 1, max: 3 }, walletsPath: 'wallets.json', progressPath: 'progress.ndjson' }));
  return dir;
}
test('public progress parser supports BOM, empty NDJSON and JSON arrays', () => {
  assert.deepEqual(parseProgress('\uFEFF \n'), []);
  assert.deepEqual(parseProgress('\uFEFF' + JSON.stringify([done(1)])), [done(1)]);
  assert.deepEqual(parseProgress(JSON.stringify(done(1)) + '\n\n' + JSON.stringify(done(2))), [done(1), done(2)]);
  assert.throws(() => parseProgress('{"secret":'), /JSON/);
});
test('CLI resolves config paths against config directory and resumes progressPath', async t => {
  const dir = await files(t);
  let output = '';
  await runCli(['plan', '--config', join(dir, 'config.json')], text => { output += text; });
  assert.deepEqual(JSON.parse(output).items.map(item => item.walletNumber), [2, 1]);
  assert.equal(JSON.parse(output).completed, 1);
  output = '';
  await runCli(['status', '--config', join(dir, 'config.json')], text => { output += text; });
  assert.equal(JSON.parse(output).remaining, 2);
  assert.equal('items' in JSON.parse(output), false);
});
test('merge output round trips; output refuses to overwrite any existing file', async t => {
  const dir = await files(t);
  const another = join(dir, 'second.ndjson'); const output = join(dir, 'merged.ndjson');
  await writeFile(another, JSON.stringify({ ...done(2), serverProfileVerified: true, intendedUsername: 'ybtl2' }) + '\n');
  const args = ['merge', '--config', join(dir, 'config.json'), '--progress', join(dir, 'progress.ndjson'), '--progress', another, '--output', output];
  await runCli(args);
  const records = parseProgress(await readFile(output, 'utf8'));
  assert.deepEqual(records.map(record => record.walletNumber), [3, 2]);
  assert.equal(records[1].serverProfileVerified, true);
  await assert.rejects(() => runCli(args), error => error.code === 'EEXIST');
});
test('missing checkpoint and secret-shaped records fail without reflecting contents', async t => {
  const dir = await files(t);
  await assert.rejects(() => runCli(['status', '--config', join(dir, 'config.json'), '--progress', join(dir, 'missing.ndjson')]), error => error.code === 'ENOENT');
  const secret = 'fixture-secret-never-echo';
  await writeFile(join(dir, 'bad.ndjson'), JSON.stringify({ ...done(1), privateKey: secret }));
  await assert.rejects(() => runCli(['merge', '--config', join(dir, 'config.json'), '--progress', join(dir, 'bad.ndjson')]), error => !error.message.includes(secret));
});
