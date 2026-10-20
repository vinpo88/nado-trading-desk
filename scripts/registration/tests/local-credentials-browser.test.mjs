import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLocalCredentialManager } from '../local-credentials.mjs';

// All page responses are synthetic. No existing profile, credential file, vault,
// remote request, screenshot, trace, or actual DPAPI helper is used.
const require = createRequire(new URL('../../../apps/console/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const LOCAL_URL = 'http://127.0.0.1:18773/connect';
const repoDir = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
let browser;
before(async () => {
  const channel = process.env.NADO_FIXTURE_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined);
  browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
});
after(async () => { await browser?.close(); });

async function fixture(t, { wrongPassword = false, create = false, dialog = false } = {}) {
  const context = await browser.newContext();
  t.after(() => context.close());
  let submits = 0; let loads = 0; let external = 0;
  const password = randomBytes(24).toString('hex');
  await context.exposeBinding('fixtureSubmit', async () => { submits++; });
  const html = `<!doctype html><html><body>
    <h1>Nado 交易台 · ${create ? '创建保险库' : '解锁'}</h1>
    <form onsubmit="event.preventDefault(); fixtureSubmit(); ${
      wrongPassword ? `document.getElementById('error').textContent='密码错误，无法解锁保险库。'` :
      `setTimeout(()=>{document.body.innerHTML='<p data-testid=connect-wallet-address>0x'+'1'.repeat(40)+'</p>'},80)`
    }">
      <fieldset>
        <label>保险库密码<input type="password" autocomplete="${create ? 'new-password' : 'current-password'}"
          oninput="document.querySelector('button[type=submit]').disabled=!this.value"></label>
        ${create ? '<label>确认保险库密码<input type="password" autocomplete="new-password"></label>' : ''}
        <p id="error"></p><button type="submit" disabled>${create ? '创建保险库' : '解锁'}</button>
      </fieldset>
    </form>${dialog ? '<section role="dialog">清除此保险库？</section>' : ''}
  </body></html>`;
  await context.route('**/*', route => {
    if (route.request().url() !== LOCAL_URL) external++;
    return route.fulfill({ status: route.request().url() === LOCAL_URL ? 200 : 404,
      contentType: 'text/html; charset=utf-8', body: route.request().url() === LOCAL_URL ? html : '' });
  });
  const page = await context.newPage();
  await page.goto(LOCAL_URL);
  const manager = createLocalCredentialManager({
    platform: 'win32',
    invoke: async request => {
      assert.equal(request.action, 'load'); loads++;
      return { formatVersion: 1, credentialName: 'synthetic-test',
        profiles: ['synthetic-profile'], password };
    },
  });
  const config = { repoDir, profileName: 'synthetic-profile', autoUnlockCredential: 'synthetic-test',
    localUrl: LOCAL_URL, timeoutMs: 1000 };
  return { page, manager, config, stats: () => ({ submits, loads, external }) };
}

test('synthetic real browser unlock submits only once and requires visible wallet success', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.manager.tryAutoUnlock(f.config, { localPage: f.page }), { attempted: true, unlocked: true });
  assert.equal(await f.page.getByTestId('connect-wallet-address').isVisible(), true);
  await f.manager.tryAutoUnlock(f.config, { localPage: f.page });
  assert.deepEqual(f.stats(), { submits: 1, loads: 1, external: 0 });
});

test('synthetic real browser wrong password clears the field, keeps the page open and does not retry', async t => {
  const f = await fixture(t, { wrongPassword: true });
  assert.deepEqual(await f.manager.tryAutoUnlock(f.config, { localPage: f.page }),
    { attempted: true, unlocked: false, errorCode: 'AUTO_UNLOCK_FAILED' });
  assert.equal(f.page.isClosed(), false);
  assert.equal(await f.page.getByLabel('保险库密码', { exact: true }).inputValue(), '');
  assert.equal(await f.page.getByText('密码错误，无法解锁保险库。', { exact: true }).isVisible(), true);
  await f.manager.tryAutoUnlock(f.config, { localPage: f.page });
  assert.deepEqual(f.stats(), { submits: 1, loads: 1, external: 0 });
});

test('synthetic real browser never decrypts or fills a create-vault form or a dialog-obstructed page', async t => {
  for (const options of [{ create: true }, { dialog: true }]) {
    const f = await fixture(t, options);
    const result = await f.manager.tryAutoUnlock(f.config, { localPage: f.page });
    assert.equal(result.attempted, false);
    assert.equal(result.unlocked, false);
    assert.equal(await f.page.getByLabel('保险库密码', { exact: true }).inputValue(), '');
    assert.equal(f.page.isClosed(), false);
    assert.deepEqual(f.stats(), { submits: 0, loads: 0, external: 0 });
  }
});
