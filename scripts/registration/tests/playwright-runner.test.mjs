import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createPlaywrightNadoRunner, makeUsernameAlternative, usernameBelongsToWallet } from '../playwright-runner.mjs';

// Real, ephemeral browser; every request is fulfilled by this synthetic fixture.
// No real profile, vault, wallet, signing operation, clipboard, or remote site is used.
const require = createRequire(new URL('../../../apps/console/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const LOCAL = 'http://127.0.0.1:18771/connect';
const NADO = 'https://app.nado.xyz/perpetuals?market=BTC';
const manifest = [1, 2, 3].map(number => ({ walletNumber: number, address: '0x' + String(number).repeat(40) }));
const declarations = [1, 2, 3, 4, 5, 6].map(number => `Synthetic reviewed declaration ${number}.`);
const confirmation = {
  confirmed: true, context: 'Synthetic fixture consent, never real consent.', declarations,
  termsUrl: 'https://nado.xyz/legal-docs/terms-of-use', privacyUrl: 'https://nado.xyz/legal-docs/privacy-policy',
};
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
let browser;
before(async () => {
  const channel = process.env.NADO_FIXTURE_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined);
  browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
});
after(async () => { await browser?.close(); });

async function fixture(t, { conflict = false, unknownAfterSave = false, existingAfterTerms = false, startComplete = null, onEvent, resumeAttempt } = {}) {
  const context = await browser.newContext();
  t.after(() => context.close());
  // In-memory fixture clipboard with focus semantics; never touches OS clipboard.
  await context.addInitScript(() => {
    let text = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      async writeText(value) { if (!document.hasFocus()) throw new Error('Synthetic clipboard not focused'); text = value; },
      async readText() { if (!document.hasFocus()) throw new Error('Synthetic clipboard not focused'); return text; },
    } });
  });
  const counters = { saves: 0, terms: 0, proposals: 0, forbidden: 0 };
  let localPage; let nadoPage;
  const address = number => manifest[number - 1].address;
  const profile = (number, username) => `<button onclick="fixtureAction({type:'menu'})"><img alt="Ink" width="18" height="18" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="> ${address(number).slice(0, 6)}…${address(number).slice(-4)}<br>${esc(username)}</button>`;
  const signedOut = '<button style="display:none">Sign In</button><button onclick="fixtureAction({type:\'signin\'})">Sign In</button>';
  const terms = `<section role="dialog"><h2>Terms of Use</h2><p>You hereby agree and warrant that:</p><ul>${declarations.map(text => `<li>${text}</li>`).join('')}</ul><a href="${confirmation.termsUrl}">Terms</a><a href="${confirmation.privacyUrl}">Privacy</a><button onclick="fixtureAction({type:'agree'})">Agree to Terms</button></section>`;
  const nameForm = `<form onsubmit="return false"><h2>Set Username</h2><input id="displayName" aria-describedby="name-feedback" oninput="
    const candidate=this.value; this.setAttribute('aria-busy','true'); document.getElementById('name-feedback').textContent='Checking username'; document.getElementById('save-name').disabled=true;
    setTimeout(() => { if(this.value!==candidate)return; this.setAttribute('aria-busy','false');
      const taken=${conflict ? 'candidate===\'ybtl2\'' : 'false'};
      document.getElementById('name-feedback').textContent=taken?'Username is already taken':'';
      this.setAttribute('aria-invalid',String(taken));document.getElementById('save-name').disabled=taken;
    },35)">
    <p role="alert" id="name-feedback"></p><button id="save-name" disabled onclick="fixtureAction({type:'save',username:document.getElementById('displayName').value})">Save</button></form>`;
  const localHTML = `<!doctype html><html><body>
    <label>钱包编号（从 1 开始）<input id="wallet-number" type="number" value="${startComplete ? 2 : 1}" oninput="
      const value=this.value;document.getElementById('local-username').value='ybtl'+value;
      setTimeout(()=>{if(this.value===value)document.getElementById('wallet-address').textContent=${JSON.stringify(manifest.map(item => item.address)).replaceAll('"', '&quot;')}[Number(value)-1]},40)">
    </label><p id="wallet-address" data-testid="connect-wallet-address">${address(startComplete ? 2 : 1)}</p>
    <label>本次官网用户名<input id="local-username" value="ybtl${startComplete ? 2 : 1}"></label>
    <label><input id="username-auth" type="checkbox">自动确认一次此用户名签名</label>
    <label>WalletConnect 连接码<input id="pairing-uri" type="password"></label>
    <button onclick="fixtureAction({type:'proposal'})">接收官网连接请求</button>
    <button onclick="document.getElementById('username-auth').checked=false;document.getElementById('local-status').textContent='尚未连接';document.getElementById('proposal').innerHTML=''">断开连接</button>
    <p id="local-status" data-testid="connect-status">${startComplete ? '钱包已连接，等待官网请求' : '尚未连接'}</p><div id="proposal"></div><p id="outcome"></p>
    </body></html>`;
  await context.route('**/*', route => {
    const url = route.request().url();
    const html = url === LOCAL ? localHTML : url === NADO ? `<!doctype html><body>${startComplete ? profile(2, startComplete) : signedOut}</body>` : '<!doctype html><body>Blocked fixture route</body>';
    return route.fulfill({ status: url === LOCAL || url === NADO ? 200 : 404, contentType: 'text/html; charset=utf-8', body: html });
  });
  const renderNado = html => nadoPage.locator('body').evaluate((body, value) => { body.innerHTML = value; }, html);
  await context.exposeBinding('fixtureAction', async (_, action) => {
    if (action.type === 'signin') return renderNado('<button onclick="fixtureAction({type:\'walletconnect\'})">WalletConnect</button>');
    if (action.type === 'walletconnect') {
      const uri = `wc:${'ab'.repeat(32)}@2?symKey=${'cd'.repeat(32)}&expiryTimestamp=${Math.floor(Date.now() / 1000) + 600}`;
      return renderNado(`<button onclick="navigator.clipboard.writeText('${uri}')">Copy link</button>`);
    }
    const number = Number(await localPage.getByLabel('钱包编号（从 1 开始）').inputValue());
    if (action.type === 'proposal') {
      counters.proposals++;
      await localPage.locator('#proposal').evaluate((node, currentAddress) => { node.innerHTML = `<section aria-labelledby="proposal-title"><h2 id="proposal-title">确认连接请求</h2><p>已核验的网站来源：https://app.nado.xyz</p><p>钱包：${currentAddress}</p><p>网络：Ink 主网（57073）</p><button onclick="fixtureAction({type:'approve'})">同意连接此钱包</button></section>`; }, address(number));
      return;
    }
    if (action.type === 'approve') {
      await localPage.locator('#local-status').evaluate(node => { node.textContent = '钱包已连接，等待官网请求'; });
      await localPage.locator('#proposal').evaluate(node => { node.innerHTML = ''; });
      return renderNado(terms);
    }
    if (action.type === 'agree') {
      counters.terms++;
      return renderNado(existingAfterTerms ? profile(number, 'ybtl' + number) : `<h2>We're Introducing Usernames</h2><button onclick="fixtureAction({type:'next'})">Next</button>`);
    }
    if (action.type === 'next') return renderNado(nameForm);
    if (action.type === 'save') {
      counters.saves++;
      assert.equal(await localPage.getByRole('checkbox', { name: '自动确认一次此用户名签名' }).isChecked(), true);
      assert.equal(await localPage.getByLabel('本次官网用户名').inputValue(), action.username);
      await localPage.locator('#username-auth').evaluate(node => { node.checked = false; });
      await localPage.locator('#local-status').evaluate(node => { node.textContent = '正在处理已确认的请求'; });
      await renderNado(unknownAfterSave ? '<h2>Unexpected result</h2><button onclick="fixtureAction({type:\'forbidden\'})">Deposit</button>' : profile(number, action.username));
      await localPage.locator('#outcome').evaluate((node, name) => {
        setTimeout(() => { node.textContent = '已按本次授权签署用户名：' + name + '，请在官网核对保存结果。'; document.getElementById('local-status').textContent = '钱包已连接，等待官网请求'; }, 70);
      }, action.username);
      return;
    }
    if (action.type === 'menu') return nadoPage.locator('body').evaluate(body => { body.insertAdjacentHTML('beforeend', '<div role="menu"><button role="menuitem" onclick="fixtureAction({type:\'signout\'})">Sign Out</button></div>'); });
    if (action.type === 'signout') return renderNado(signedOut);
    counters.forbidden++;
  });
  localPage = await context.newPage(); await localPage.goto(LOCAL);
  nadoPage = await context.newPage(); await nadoPage.goto(NADO);
  localPage.setDefaultTimeout(2000); nadoPage.setDefaultTimeout(2000);
  await localPage.bringToFront(); // Copier must explicitly focus Nado.
  const runner = createPlaywrightNadoRunner({ localPage, nadoPage, walletManifest: manifest, timeoutMs: 1500,
    onEvent: onEvent ?? (event => { if (process.env.NADO_FIXTURE_DEBUG === '1') console.error(event.stage); }), resumeAttempt });
  return { runner, localPage, nadoPage, counters };
}

test('username alternatives preserve letters and wallet suffix and do not match another wallet', () => {
  assert.equal(makeUsernameAlternative('ybtl61', 61, '27', 2), 'yb27tl61');
  assert.equal(usernameBelongsToWallet('yb27tl61', 'ybtl61', 61), true);
  assert.equal(usernameBelongsToWallet('ybtl610', 'ybtl61', 61), false);
  assert.throws(() => makeUsernameAlternative('ybtl61', 61, 'x', 1));
});

test('real Playwright fixture: explicit terms, delayed address/render, clipboard focus, one Save, and next wallet', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.runner.runWallet(2), error => error.code === 'TERMS_CONFIRMATION_REQUIRED');
  assert.equal(f.counters.terms, 0);
  assert.equal(f.counters.saves, 0);
  assert.deepEqual((await f.runner.readTermsCandidate()).declarations, declarations);
  const record = await f.runner.runWallet(2, confirmation);
  assert.equal(record.walletNumber, 2);
  assert.equal(record.username, 'ybtl2');
  assert.equal(record.loginComplete, true);
  assert.equal(f.counters.saves, 1);
  assert.equal(await f.localPage.getByRole('checkbox', { name: '自动确认一次此用户名签名' }).isChecked(), false);
  const next = await f.runner.runWallet(3, confirmation);
  assert.equal(next.walletNumber, 3);
  assert.equal(f.counters.saves, 2);
  assert.equal(f.counters.forbidden, 0);
  await f.runner.cleanup();
});

test('real Playwright fixture: visible name conflict picks an inserted-digit name before signing once', async t => {
  const f = await fixture(t, { conflict: true });
  const record = await f.runner.runWallet(2, confirmation);
  assert.notEqual(record.username, 'ybtl2');
  assert.equal(usernameBelongsToWallet(record.username, 'ybtl2', 2), true);
  assert.equal(f.counters.saves, 1);
});

test('real Playwright fixture: existing name after Terms completes without any username Save', async t => {
  const f = await fixture(t, { existingAfterTerms: true });
  const record = await f.runner.runWallet(2, confirmation);
  assert.equal(record.username, 'ybtl2');
  assert.equal(record.usernameAutoSigned, false);
  assert.equal(f.counters.saves, 0);
});

test('real Playwright fixture: unknown result stops, revokes, and never retries Save or clicks Deposit', async t => {
  const f = await fixture(t, { unknownAfterSave: true });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION' && !error.message.includes('symKey'));
  assert.equal(f.counters.saves, 1);
  assert.equal(f.counters.forbidden, 0);
  assert.equal(await f.localPage.getByRole('checkbox', { name: '自动确认一次此用户名签名' }).isChecked(), false);
  await assert.rejects(() => f.runner.runWallet(2, confirmation));
  assert.equal(f.counters.saves, 1);
});

test('real Playwright fixture: failed write-ahead event prevents Save and revokes authorization', async t => {
  let reachedSavePending = false;
  const f = await fixture(t, { onEvent: async event => { if (event.stage === 'save_pending') { reachedSavePending = true; throw new Error('Synthetic disk failure with private contents'); } } });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION' && !error.message.includes('private contents'));
  assert.equal(reachedSavePending, true);
  assert.equal(f.counters.saves, 0);
  assert.equal(await f.localPage.getByRole('checkbox', { name: '自动确认一次此用户名签名' }).isChecked(), false);
});

test('real Playwright fixture: crash recovery requires the exact journal username and never signs again', async t => {
  const resumeAttempt = { walletNumber: 2, address: manifest[1].address, username: 'ybtl2', saveAttempted: true };
  const good = await fixture(t, { startComplete: 'ybtl2', resumeAttempt });
  assert.equal((await good.runner.runWallet(2, confirmation)).loginComplete, true);
  assert.equal(good.counters.saves, 0);
  const wrong = await fixture(t, { startComplete: 'yb7tl2', resumeAttempt });
  await assert.rejects(() => wrong.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.equal(wrong.counters.saves, 0);
});
