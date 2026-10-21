import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createPlaywrightNadoRunner, makeUsernameAlternative, usernameBelongsToWallet } from '../playwright-runner.mjs';
import { createUiCoordinator } from '../ui-coordinator.mjs';

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

async function fixture(t, { conflict = false, unknownAfterSave = false, existingAfterTerms = false, startComplete = null, onEvent, resumeAttempt,
  browserInstance = browser, withUi, sharedClipboard, pairingTag = 'ab', deferPairingLink = false, deferOnboarding = false, timeoutMs,
  startStaleTerms = false, staleTermsCloseCount = 1, unrelatedDialogClose = false, staleCloseSignsOut = true,
  initialAuthorized = false, staleOnboardingProfile = false, deferApprovalCompletion = false, deferProposal = false,
  startupDelayed = false, deferredBridgeInitialization = false } = {}) {
  const context = await browserInstance.newContext();
  t.after(() => context.close());
  // In-memory fixture clipboard with focus semantics; never touches OS clipboard.
  if (sharedClipboard) {
    await context.exposeBinding('fixtureClipboard', async (_, method, value) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      if (method === 'write') sharedClipboard.text = value;
      else if (method === 'read') return sharedClipboard.text;
      else assert.fail('Unknown fixture clipboard method');
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        async writeText(value) { if (!document.hasFocus()) throw new Error('Synthetic clipboard not focused'); await window.fixtureClipboard('write', value); },
        async readText() { if (!document.hasFocus()) throw new Error('Synthetic clipboard not focused'); return window.fixtureClipboard('read'); },
      } });
    });
  } else await context.addInitScript(() => {
    let text = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      async writeText(value) { if (!document.hasFocus()) throw new Error('Synthetic clipboard not focused'); text = value; },
      async readText() { if (!document.hasFocus()) throw new Error('Synthetic clipboard not focused'); return text; },
    } });
  });
  const counters = { signins: 0, walletconnect: 0, copies: 0, saves: 0, terms: 0, proposals: 0, approvals: 0,
    staleTermsCloses: 0, staleTermsAgreements: 0, forbidden: 0, navigations: 0 };
  const actions = [];
  let staleTermsVisible = startStaleTerms;
  let proposalWalletNumber = null;
  let pairingUri;
  let localPage; let nadoPage;
  const address = number => manifest[number - 1].address;
  const profile = (number, username) => `<button onclick="fixtureAction({type:'menu'})"><img alt="Ink" width="18" height="18" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="> ${address(number).slice(0, 6)}…${address(number).slice(-4)}<br>${esc(username)}</button>`;
  const signedOut = '<button style="display:none">Sign In</button><button onclick="fixtureAction({type:\'signin\'})">Sign In</button>';
  const terms = `<section role="dialog"><h2>Terms of Use</h2><p>You hereby agree and warrant that:</p><ul>${declarations.map(text => `<li>${text}</li>`).join('')}</ul><a href="${confirmation.termsUrl}">Terms</a><a href="${confirmation.privacyUrl}">Privacy</a><button data-testid="terms-of-use-dialog-agree-to-terms-button" onclick="fixtureAction({type:'agree'})">Agree to Terms</button></section>`;
  const staleTerms = terms.replace('</section>', Array.from({ length: staleTermsCloseCount },
    () => '<button data-testid="close-dialog-button" onclick="fixtureAction({type:\'close_stale\'})">Close Terms</button>').join('') + '</section>')
    + (unrelatedDialogClose ? '<section role="dialog"><h2>Unrelated dialog</h2><button data-testid="close-dialog-button" onclick="fixtureAction({type:\'forbidden\'})">Close unrelated dialog</button></section>' : '');
  const nameForm = `<form onsubmit="return false"><h2>Set Username</h2><input id="displayName" aria-describedby="name-feedback" oninput="
    const candidate=this.value; this.setAttribute('aria-busy','true'); document.getElementById('name-feedback').textContent='Checking username'; document.getElementById('save-name').disabled=true;
    setTimeout(() => { if(this.value!==candidate)return; this.setAttribute('aria-busy','false');
      const taken=${conflict ? 'candidate===\'demo2\'' : 'false'};
      document.getElementById('name-feedback').textContent=taken?'Username is already taken':'';
      this.setAttribute('aria-invalid',String(taken));document.getElementById('save-name').disabled=taken;
    },35)">
    <p role="alert" id="name-feedback"></p><button id="save-name" disabled onclick="fixtureAction({type:'save',username:document.getElementById('displayName').value})">Save</button></form>`;
  const localHTML = `<!doctype html><html><body>
    <label>钱包编号（从 1 开始）<input id="wallet-number" type="number" value="${startComplete ? 2 : 1}" oninput="
      const value=this.value;document.getElementById('local-username').value='demo'+value;
      setTimeout(()=>{if(this.value===value)document.getElementById('wallet-address').textContent=${JSON.stringify(manifest.map(item => item.address)).replaceAll('"', '&quot;')}[Number(value)-1]},40)">
    </label><p id="wallet-address" data-testid="connect-wallet-address">${address(startComplete ? 2 : 1)}</p>
    <label>本次官网用户名<input id="local-username" value="demo${startComplete ? 2 : 1}"></label>
    <label><input id="username-auth" type="checkbox"${initialAuthorized ? ' checked' : ''}>自动确认一次此用户名签名</label>
    <section aria-labelledby="pairing"><h2 id="pairing">从 Nado 发起连接</h2>
    <label>WalletConnect 连接码<input id="pairing-uri" type="password"></label>
    <button id="receive-proposal" onclick="fixtureAction({type:'proposal'})">接收官网连接请求</button>
    <button onclick="document.getElementById('username-auth').checked=false;document.getElementById('local-status').textContent='尚未连接';document.getElementById('proposal').innerHTML='';this.closest('section').querySelectorAll('[role=alert]').forEach(node=>node.remove())">断开连接</button>
    <p id="local-status" data-testid="connect-status">${startComplete ? '钱包已连接，等待官网请求' : '尚未连接'}</p><p id="outcome"></p>
    </section><div id="proposal"></div>
    </body></html>`;
  const initialWebsite = startStaleTerms ? staleTerms : startComplete ? profile(2, startComplete) : signedOut;
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url === NADO && route.request().isNavigationRequest()) counters.navigations++;
    const html = url === LOCAL ? localHTML : url === NADO ? `<!doctype html><body>${startupDelayed ? '<p role="status">Loading website…</p>' : initialWebsite}</body>` : '<!doctype html><body>Blocked fixture route</body>';
    return route.fulfill({ status: url === LOCAL || url === NADO ? 200 : 404, contentType: 'text/html; charset=utf-8', body: html });
  });
  const renderNado = html => nadoPage.locator('body').evaluate((body, value) => { body.innerHTML = value; }, html);
  const releaseStartup = () => renderNado(initialWebsite);
  const releasePairingLink = () => renderNado(`<button onclick="fixtureAction({type:'copy'}).then(() => navigator.clipboard.writeText('${pairingUri}'))">Copy link</button>`);
  const releaseOnboarding = () => { staleTermsVisible = false; return renderNado(terms); };
  const releaseProfile = (number, username = `demo${number}`) => renderNado(profile(number, username));
  const releaseApprovalCompletion = () => localPage.getByTestId('connect-status')
    .evaluate(node => { node.textContent = '钱包已连接，等待官网请求'; });
  const releaseProposal = async () => {
    assert.notEqual(proposalWalletNumber, null);
    await localPage.locator('#proposal').evaluate((node, currentAddress) => {
      node.innerHTML = `<section aria-labelledby="proposal-title"><h2 id="proposal-title">确认连接请求</h2><p>已核验的网站来源：https://app.nado.xyz</p><p>钱包：${currentAddress}</p><p>网络：Ink 主网（57073）</p><button onclick="fixtureAction({type:'approve'})">同意连接此钱包</button></section>`;
    }, address(proposalWalletNumber));
    await localPage.getByTestId('connect-status').evaluate(node => { node.textContent = '请确认网站连接'; });
  };
  const releaseBridgeInitialization = async () => {
    await localPage.locator('#receive-proposal').evaluate(button => {
      button.disabled = false; button.removeAttribute('aria-busy');
    });
    await localPage.getByTestId('connect-status').evaluate(node => { node.textContent = '正在等待官网连接请求'; });
    if (!deferProposal) await releaseProposal();
  };
  await context.exposeBinding('fixtureAction', async (_, action) => {
    actions.push(action.type);
    if (action.type === 'close_stale') {
      counters.staleTermsCloses++;
      staleTermsVisible = false;
      return renderNado(staleCloseSignsOut ? signedOut : '<p>Previous session still active</p>');
    }
    if (action.type === 'signin') {
      counters.signins++;
      return renderNado('<button onclick="fixtureAction({type:\'walletconnect\'})">WalletConnect</button>');
    }
    if (action.type === 'walletconnect') {
      counters.walletconnect++;
      // Each visible new pairing supplies a fresh, synthetic code. The receive
      // handler compares it in memory, so replaying the previous code fails.
      pairingUri = `wc:${pairingTag.repeat(31)}${counters.walletconnect.toString(16).padStart(2, '0')}@2?symKey=${'cd'.repeat(32)}&expiryTimestamp=${Math.floor(Date.now() / 1000) + 600}`;
      return deferPairingLink ? renderNado('<p role="status">Preparing connection link…</p>') : releasePairingLink();
    }
    if (action.type === 'copy') { counters.copies++; return; }
    const number = Number(await localPage.getByLabel('钱包编号（从 1 开始）').inputValue());
    if (action.type === 'proposal') {
      assert.equal(await localPage.getByLabel('WalletConnect 连接码').inputValue(), pairingUri);
      counters.proposals++;
      proposalWalletNumber = number;
      if (deferredBridgeInitialization) {
        await localPage.locator('#receive-proposal').evaluate(button => {
          button.disabled = true; button.setAttribute('aria-busy', 'true');
        });
        await localPage.getByTestId('connect-status').evaluate(node => { node.textContent = '尚未连接'; });
        return;
      }
      await localPage.getByTestId('connect-status').evaluate(node => { node.textContent = '正在等待官网连接请求'; });
      if (!deferProposal) return releaseProposal();
      return;
    }
    if (action.type === 'approve') {
      counters.approvals++;
      await localPage.locator('#local-status').evaluate((node, delayed) => {
        node.textContent = delayed ? '正在等待官网连接请求' : '钱包已连接，等待官网请求';
      }, deferApprovalCompletion);
      await localPage.locator('#proposal').evaluate(node => { node.innerHTML = ''; });
      if (staleOnboardingProfile) return releaseProfile(number === 1 ? 2 : 1);
      return deferOnboarding ? renderNado('<p role="status">Loading registration page…</p>') : releaseOnboarding();
    }
    if (action.type === 'agree') {
      if (staleTermsVisible) counters.staleTermsAgreements++;
      counters.terms++;
      return renderNado(existingAfterTerms ? profile(number, 'demo' + number) : `<h2>We're Introducing Usernames</h2><button onclick="fixtureAction({type:'next'})">Next</button>`);
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
  const runner = createPlaywrightNadoRunner({ localPage, nadoPage, walletManifest: manifest, timeoutMs: timeoutMs ?? (sharedClipboard ? 5000 : 1500), withUi,
    onEvent: onEvent ?? (event => { if (process.env.NADO_FIXTURE_DEBUG === '1') console.error(event.stage); }), resumeAttempt });
  return { runner, localPage, nadoPage, counters, actions, releasePairingLink, releaseOnboarding, releaseProfile, releaseApprovalCompletion, releaseProposal, releaseStartup, releaseBridgeInitialization };
}

test('username alternatives preserve letters and wallet suffix and do not match another wallet', () => {
  assert.equal(makeUsernameAlternative('demo61', 61, '27', 2), 'de27mo61');
  assert.equal(usernameBelongsToWallet('de27mo61', 'demo61', 61), true);
  assert.equal(usernameBelongsToWallet('demo610', 'demo61', 61), false);
  assert.throws(() => makeUsernameAlternative('demo61', 61, 'x', 1));
});

test('real Playwright fixture: explicit terms, delayed address/render, clipboard focus, one Save, and next wallet', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.runner.runWallet(2), error => error.code === 'TERMS_CONFIRMATION_REQUIRED');
  assert.equal(f.counters.terms, 0);
  assert.equal(f.counters.saves, 0);
  assert.deepEqual((await f.runner.readTermsCandidate()).declarations, declarations);
  const record = await f.runner.runWallet(2, confirmation);
  assert.equal(record.walletNumber, 2);
  assert.equal(record.username, 'demo2');
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
  assert.notEqual(record.username, 'demo2');
  assert.equal(usernameBelongsToWallet(record.username, 'demo2', 2), true);
  assert.equal(f.counters.saves, 1);
});

test('real Playwright fixture: existing name after Terms completes without any username Save', async t => {
  const f = await fixture(t, { existingAfterTerms: true });
  const record = await f.runner.runWallet(2, confirmation);
  assert.equal(record.username, 'demo2');
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
  const resumeAttempt = { walletNumber: 2, address: manifest[1].address, username: 'demo2', saveAttempted: true };
  const good = await fixture(t, { startComplete: 'demo2', resumeAttempt });
  assert.equal((await good.runner.runWallet(2, confirmation)).loginComplete, true);
  assert.equal(good.counters.saves, 0);
  const wrong = await fixture(t, { startComplete: 'de7mo2', resumeAttempt });
  await assert.rejects(() => wrong.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.equal(wrong.counters.saves, 0);
});

test('Edge and Chrome concurrent fixture: shared clipboard and UI scheduler preserve both wallet identities', async t => {
  const peerChannel = process.platform === 'win32' ? 'chrome' : undefined;
  const peerBrowser = await chromium.launch({ headless: true, ...(peerChannel ? { channel: peerChannel } : {}) });
  t.after(() => peerBrowser.close());
  const coordinator = createUiCoordinator();
  const sharedClipboard = { text: '' };
  const a = await fixture(t, { withUi: coordinator.run, sharedClipboard, pairingTag: 'ab' });
  const b = await fixture(t, { browserInstance: peerBrowser, withUi: coordinator.run, sharedClipboard, pairingTag: 'ef' });
  const [first, second] = await Promise.all([
    a.runner.runWallet(2, confirmation), b.runner.runWallet(3, confirmation),
  ]);
  assert.deepEqual([first.walletNumber, second.walletNumber], [2, 3]);
  assert.deepEqual([first.address, second.address], [manifest[1].address, manifest[2].address]);
  assert.deepEqual([first.username, second.username], ['demo2', 'demo3']);
  assert.equal(sharedClipboard.text, '');
  assert.deepEqual([a.counters.saves, b.counters.saves, a.counters.forbidden, b.counters.forbidden], [1, 1, 0, 0]);
  await Promise.all([a.runner.cleanup(), b.runner.cleanup()]);
});

test('delayed pairing link: repeated pending rounds keep the vault open and resume without duplicate login clicks', async t => {
  const f = await fixture(t, { deferPairingLink: true, timeoutMs: 500 });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'PAIRING_LINK_PENDING');
    assert.equal(f.localPage.isClosed(), false);
    assert.equal(await f.localPage.getByTestId('connect-wallet-address').isVisible(), true);
    assert.equal(await f.localPage.getByRole('checkbox', { name: '自动确认一次此用户名签名' }).isChecked(), false);
    assert.deepEqual([f.counters.signins, f.counters.walletconnect, f.counters.copies, f.counters.proposals, f.counters.saves], [1, 1, 0, 0, 0]);
  }
  await f.releasePairingLink();
  const record = await f.runner.runWallet(2, confirmation);
  assert.equal(record.walletNumber, 2);
  assert.equal(record.address, manifest[1].address);
  assert.equal(record.username, 'demo2');
  assert.equal(record.loginComplete, true);
  assert.deepEqual([f.counters.signins, f.counters.walletconnect, f.counters.copies, f.counters.proposals, f.counters.saves], [1, 1, 1, 1, 1]);
  assert.equal(f.counters.forbidden, 0);
});

test('delayed pairing link: another requested wallet cannot replace the pending wallet', async t => {
  const f = await fixture(t, { deferPairingLink: true, timeoutMs: 500 });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'PAIRING_LINK_PENDING');
  await assert.rejects(() => f.runner.runWallet(3, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.deepEqual([f.counters.signins, f.counters.walletconnect, f.counters.copies, f.counters.proposals, f.counters.saves], [1, 1, 0, 0, 0]);
});

test('delayed pairing link: changing the local wallet during pending is rejected before copy or proposal', async t => {
  const f = await fixture(t, { deferPairingLink: true, timeoutMs: 500 });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'PAIRING_LINK_PENDING');
  await f.localPage.bringToFront();
  await f.localPage.getByLabel('钱包编号（从 1 开始）', { exact: true }).fill('3');
  await f.localPage.getByTestId('connect-wallet-address').filter({ hasText: manifest[2].address }).waitFor({ state: 'visible' });
  await f.releasePairingLink();
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.deepEqual([f.counters.signins, f.counters.walletconnect, f.counters.copies, f.counters.proposals, f.counters.saves], [1, 1, 0, 0, 0]);
});

test('delayed pairing link: a peer runner completes while the pending runner releases the UI coordinator', { timeout: 20000 }, async t => {
  const peerChannel = process.platform === 'win32' ? 'chrome' : undefined;
  const peerBrowser = await chromium.launch({ headless: true, ...(peerChannel ? { channel: peerChannel } : {}) });
  t.after(() => peerBrowser.close());
  const coordinator = createUiCoordinator();
  const sharedClipboard = { text: '' };
  const pending = await fixture(t, {
    withUi: coordinator.run, sharedClipboard, pairingTag: 'ab', deferPairingLink: true, timeoutMs: 500,
  });
  const healthy = await fixture(t, { browserInstance: peerBrowser, withUi: coordinator.run, sharedClipboard, pairingTag: 'ef' });
  const [, record] = await Promise.all([
    assert.rejects(() => pending.runner.runWallet(2, confirmation), error => error.code === 'PAIRING_LINK_PENDING'),
    healthy.runner.runWallet(3, confirmation),
  ]);
  assert.equal(record.walletNumber, 3);
  assert.equal(record.address, manifest[2].address);
  assert.equal(record.loginComplete, true);
  await assert.rejects(() => pending.runner.runWallet(2, confirmation), error => error.code === 'PAIRING_LINK_PENDING');
  assert.deepEqual([pending.counters.signins, pending.counters.walletconnect, pending.counters.copies, pending.counters.proposals, pending.counters.saves], [1, 1, 0, 0, 0]);
  assert.equal(healthy.counters.saves, 1);
  assert.equal(pending.localPage.isClosed(), false);
  assert.equal(sharedClipboard.text, '');
  await Promise.all([pending.runner.cleanup(), healthy.runner.cleanup()]);
});

test('journal reconnect: signed-out wallet with a prior Save reconnects and verifies existing name without another Save', async t => {
  const resumeAttempt = { walletNumber: 2, address: manifest[1].address, username: 'demo2', saveAttempted: true };
  const f = await fixture(t, { existingAfterTerms: true, resumeAttempt });
  const record = await f.runner.runWallet(2, confirmation);
  assert.equal(record.walletNumber, 2);
  assert.equal(record.address, manifest[1].address);
  assert.equal(record.username, 'demo2');
  assert.equal(record.loginComplete, true);
  assert.equal(record.usernameAutoSigned, false);
  assert.deepEqual([f.counters.signins, f.counters.walletconnect, f.counters.proposals, f.counters.saves], [1, 1, 1, 0]);
});

test('journal reconnect: delayed link with a prior Save requires attention instead of automatic pending retry', async t => {
  const resumeAttempt = { walletNumber: 2, address: manifest[1].address, username: 'demo2', saveAttempted: true };
  const f = await fixture(t, { deferPairingLink: true, resumeAttempt, timeoutMs: 500 });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.deepEqual([f.counters.signins, f.counters.walletconnect, f.counters.copies, f.counters.proposals, f.counters.saves], [1, 1, 0, 0, 0]);
  assert.equal(await f.localPage.getByRole('checkbox', { name: '自动确认一次此用户名签名' }).isChecked(), false);
});

test('delayed onboarding: repeated pending rounds preserve the approved connection and resume without repeated actions', async t => {
  const f = await fixture(t, { deferOnboarding: true, timeoutMs: 500 });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'ONBOARDING_PENDING');
    assert.equal(f.localPage.isClosed(), false);
    assert.equal(await f.localPage.getByTestId('connect-status').innerText(), '钱包已连接，等待官网请求');
    assert.equal(await f.localPage.getByRole('checkbox', { name: '自动确认一次此用户名签名' }).isChecked(), false);
    assert.deepEqual([f.counters.signins, f.counters.walletconnect, f.counters.copies, f.counters.proposals,
      f.counters.approvals, f.counters.terms, f.counters.saves], [1, 1, 1, 1, 1, 0, 0]);
  }
  await f.releaseOnboarding();
  const record = await f.runner.runWallet(2, confirmation);
  assert.equal(record.walletNumber, 2);
  assert.equal(record.address, manifest[1].address);
  assert.equal(record.username, 'demo2');
  assert.equal(record.loginComplete, true);
  assert.deepEqual([f.counters.signins, f.counters.walletconnect, f.counters.copies, f.counters.proposals,
    f.counters.approvals, f.counters.terms, f.counters.saves], [1, 1, 1, 1, 1, 1, 1]);
});

test('delayed onboarding: changing the bound local wallet rejects retry before accepting Terms or saving', async t => {
  const f = await fixture(t, { deferOnboarding: true, timeoutMs: 500 });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'ONBOARDING_PENDING');
  await f.localPage.bringToFront();
  await f.localPage.getByLabel('钱包编号（从 1 开始）', { exact: true }).fill('3');
  await f.localPage.getByTestId('connect-wallet-address').filter({ hasText: manifest[2].address }).waitFor({ state: 'visible' });
  await f.releaseOnboarding();
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.deepEqual([f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 1, 0, 0]);
});

test('delayed onboarding: a local pending signature request requires attention instead of retry or approval', async t => {
  const f = await fixture(t, { deferOnboarding: true, timeoutMs: 500 });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'ONBOARDING_PENDING');
  await f.localPage.getByTestId('connect-status').evaluate(node => { node.textContent = '有请求等待你确认'; });
  await f.localPage.locator('body').evaluate(body => {
    body.insertAdjacentHTML('beforeend', '<button onclick="fixtureAction({type:\'forbidden\'})">确认并签名</button>');
  });
  await f.releaseOnboarding();
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.deepEqual([f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves, f.counters.forbidden], [1, 1, 0, 0, 0]);
});

test('delayed onboarding: a prior Save journal forbids automatic onboarding retry', async t => {
  const resumeAttempt = { walletNumber: 2, address: manifest[1].address, username: 'demo2', saveAttempted: true };
  const f = await fixture(t, { deferOnboarding: true, resumeAttempt, timeoutMs: 500 });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.deepEqual([f.counters.signins, f.counters.walletconnect, f.counters.copies, f.counters.proposals,
    f.counters.approvals, f.counters.terms, f.counters.saves], [1, 1, 1, 1, 1, 0, 0]);
  assert.equal(await f.localPage.getByRole('checkbox', { name: '自动确认一次此用户名签名' }).isChecked(), false);
});

test('stale Terms recovery: close only the exact old dialog, then pair freshly before agreeing', async t => {
  const f = await fixture(t, { startStaleTerms: true, unrelatedDialogClose: true });
  const record = await f.runner.runWallet(2, confirmation);
  assert.equal(record.walletNumber, 2);
  assert.equal(record.address, manifest[1].address);
  assert.equal(record.loginComplete, true);
  assert.deepEqual(f.actions, ['close_stale', 'signin', 'walletconnect', 'copy', 'proposal', 'approve', 'agree', 'next', 'save']);
  assert.deepEqual([f.counters.staleTermsCloses, f.counters.staleTermsAgreements, f.counters.proposals,
    f.counters.approvals, f.counters.saves, f.counters.forbidden], [1, 0, 1, 1, 1, 0]);
});

test('stale Terms recovery: a Save journal prevents closing or accepting the old dialog', async t => {
  const resumeAttempt = { walletNumber: 2, address: manifest[1].address, username: 'demo2', saveAttempted: true };
  const f = await fixture(t, { startStaleTerms: true, resumeAttempt });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.deepEqual([f.counters.staleTermsCloses, f.counters.terms, f.counters.signins, f.counters.proposals, f.counters.saves], [0, 0, 0, 0, 0]);
  assert.equal(await f.nadoPage.getByRole('button', { name: 'Agree to Terms', exact: true }).isVisible(), true);
});

test('stale Terms recovery: existing username authorization prevents closing or accepting the old dialog', async t => {
  const f = await fixture(t, { startStaleTerms: true, initialAuthorized: true });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.deepEqual([f.counters.staleTermsCloses, f.counters.terms, f.counters.signins, f.counters.proposals, f.counters.saves], [0, 0, 0, 0, 0]);
  assert.equal(await f.localPage.getByRole('checkbox', { name: '自动确认一次此用户名签名' }).isChecked(), false);
});

test('stale Terms recovery: ambiguous close buttons are rejected without clicking either', async t => {
  const f = await fixture(t, { startStaleTerms: true, staleTermsCloseCount: 2 });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.deepEqual([f.counters.staleTermsCloses, f.counters.terms, f.counters.signins, f.counters.proposals, f.counters.saves], [0, 0, 0, 0, 0]);
});

test('stale Terms recovery: closing must produce signed-out UI before any new login attempt', async t => {
  const f = await fixture(t, { startStaleTerms: true, staleCloseSignsOut: false, timeoutMs: 500 });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.deepEqual([f.counters.staleTermsCloses, f.counters.terms, f.counters.signins, f.counters.proposals, f.counters.saves], [1, 0, 0, 0, 0]);
});

test('stale onboarding profile: ignore the previous wallet until the expected address arrives', async t => {
  const f = await fixture(t, { staleOnboardingProfile: true, timeoutMs: 500 });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'ONBOARDING_PENDING');
  assert.equal(f.localPage.isClosed(), false);
  assert.deepEqual([f.counters.signins, f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 1, 1, 0, 0]);
  await f.releaseProfile(2, 'demo2');
  const record = await f.runner.runWallet(2, confirmation);
  assert.equal(record.walletNumber, 2);
  assert.equal(record.address, manifest[1].address);
  assert.equal(record.username, 'demo2');
  assert.equal(record.usernameAutoSigned, false);
  assert.equal(record.loginComplete, true);
  assert.deepEqual([f.counters.signins, f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 1, 1, 0, 0]);
});

test('delayed approval completion: visible Terms cannot bypass the still-connecting local session', async t => {
  const f = await fixture(t, { deferApprovalCompletion: true, timeoutMs: 500 });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'ONBOARDING_PENDING');
    assert.equal(f.localPage.isClosed(), false);
    assert.equal(await f.localPage.getByTestId('connect-status').innerText(), '正在等待官网连接请求');
    assert.equal(await f.nadoPage.getByRole('button', { name: 'Agree to Terms', exact: true }).isVisible(), true);
    assert.deepEqual([f.counters.signins, f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 1, 1, 0, 0]);
  }
  await f.releaseApprovalCompletion();
  const record = await f.runner.runWallet(2, confirmation);
  assert.equal(record.walletNumber, 2);
  assert.equal(record.address, manifest[1].address);
  assert.equal(record.loginComplete, true);
  assert.deepEqual([f.counters.signins, f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 1, 1, 1, 1]);
});

test('delayed approval completion: unexpected request or connection error cannot be automatically retried', async t => {
  for (const status of ['有请求等待你确认', '连接未完成']) {
    const f = await fixture(t, { deferApprovalCompletion: true, timeoutMs: 500 });
    await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'ONBOARDING_PENDING');
    await f.localPage.getByTestId('connect-status').evaluate((node, text) => { node.textContent = text; }, status);
    await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
    assert.deepEqual([f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves, f.counters.forbidden], [1, 1, 0, 0, 0]);
  }
});

test('delayed approval completion: a prior Save journal requires attention instead of pending retry', async t => {
  const resumeAttempt = { walletNumber: 2, address: manifest[1].address, username: 'demo2', saveAttempted: true };
  const f = await fixture(t, { deferApprovalCompletion: true, resumeAttempt, timeoutMs: 500 });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.deepEqual([f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 1, 0, 0]);
});

test('delayed connection proposal: repeated pending rounds receive only once and approve only after the proposal appears', async t => {
  const f = await fixture(t, { deferProposal: true, timeoutMs: 500 });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'CONNECTION_PROPOSAL_PENDING');
    assert.equal(f.localPage.isClosed(), false);
    assert.equal(await f.localPage.getByTestId('connect-status').innerText(), '正在等待官网连接请求');
    assert.equal(await f.localPage.getByRole('checkbox', { name: '自动确认一次此用户名签名' }).isChecked(), false);
    assert.deepEqual([f.counters.signins, f.counters.walletconnect, f.counters.copies, f.counters.proposals,
      f.counters.approvals, f.counters.terms, f.counters.saves], [1, 1, 1, 1, 0, 0, 0]);
  }
  await f.releaseProposal();
  const record = await f.runner.runWallet(2, confirmation);
  assert.equal(record.walletNumber, 2);
  assert.equal(record.address, manifest[1].address);
  assert.equal(record.loginComplete, true);
  assert.deepEqual([f.counters.signins, f.counters.walletconnect, f.counters.copies, f.counters.proposals,
    f.counters.approvals, f.counters.terms, f.counters.saves], [1, 1, 1, 1, 1, 1, 1]);
});

test('delayed connection proposal: another wallet cannot replace the pending connection target', async t => {
  const f = await fixture(t, { deferProposal: true, timeoutMs: 500 });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'CONNECTION_PROPOSAL_PENDING');
  await f.releaseProposal();
  await assert.rejects(() => f.runner.runWallet(3, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.deepEqual([f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 0, 0, 0]);
});

test('delayed connection proposal: a changed local wallet is rejected even after a valid original proposal arrives', async t => {
  const f = await fixture(t, { deferProposal: true, timeoutMs: 500 });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'CONNECTION_PROPOSAL_PENDING');
  await f.localPage.bringToFront();
  await f.localPage.getByLabel('钱包编号（从 1 开始）', { exact: true }).fill('3');
  await f.localPage.getByTestId('connect-wallet-address').filter({ hasText: manifest[2].address }).waitFor({ state: 'visible' });
  await f.releaseProposal();
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.deepEqual([f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 0, 0, 0]);
});

test('delayed connection proposal: unexpected request or connection error forbids retry', async t => {
  for (const status of ['有请求等待你确认', '连接未完成']) {
    const f = await fixture(t, { deferProposal: true, timeoutMs: 500 });
    await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'CONNECTION_PROPOSAL_PENDING');
    await f.localPage.getByTestId('connect-status').evaluate((node, text) => { node.textContent = text; }, status);
    await assert.rejects(() => f.runner.runWallet(2, confirmation), error => {
      assert.equal(error.code, 'NEEDS_ATTENTION');
      assert.deepEqual(error.uiState, {
        siteStage: 'pairing',
        localStatus: status === '连接未完成' ? 'error' : 'request',
        fault: 'ui_state',
        recoveryBlocker: 'failure_unconfirmed',
        walletMatches: true,
        usernameMatches: true,
        authorizationArmed: false,
      });
      // Exact fixed fields above also exclude raw DOM, addresses, names, and
      // connection URI/query contents from the failure observation.
      assert.equal(JSON.stringify(error.uiState).includes('symKey'), false);
      return true;
    });
    assert.deepEqual([f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 0, 0, 0]);
  }
});

test('delayed connection proposal: changed username or armed authorization forbids retry', async t => {
  for (const change of ['username', 'authorization']) {
    const f = await fixture(t, { deferProposal: true, timeoutMs: 500 });
    await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'CONNECTION_PROPOSAL_PENDING');
    await f.localPage.bringToFront();
    if (change === 'username') await f.localPage.getByLabel('本次官网用户名', { exact: true }).fill('other_name2');
    else await f.localPage.getByRole('checkbox', { name: '自动确认一次此用户名签名', exact: true }).check();
    await f.releaseProposal();
    await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
    assert.deepEqual([f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 0, 0, 0]);
    assert.equal(await f.localPage.getByRole('checkbox', { name: '自动确认一次此用户名签名' }).isChecked(), false);
  }
});

test('delayed connection proposal: a prior Save journal requires attention instead of pending retry', async t => {
  const resumeAttempt = { walletNumber: 2, address: manifest[1].address, username: 'demo2', saveAttempted: true };
  const f = await fixture(t, { deferProposal: true, resumeAttempt, timeoutMs: 500 });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.deepEqual([f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 0, 0, 0]);
});

test('delayed website startup: idle or disconnected wallet waits without actions, then starts once the site is ready', async t => {
  for (const status of ['尚未连接', '已断开连接']) {
    const f = await fixture(t, { startupDelayed: true, timeoutMs: 500 });
    await f.localPage.getByTestId('connect-status').evaluate((node, text) => { node.textContent = text; }, status);
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'WEBSITE_LOADING_PENDING');
      assert.equal(f.localPage.isClosed(), false);
      assert.equal(await f.localPage.getByLabel('钱包编号（从 1 开始）', { exact: true }).inputValue(), '1');
      assert.equal(await f.localPage.getByLabel('本次官网用户名', { exact: true }).inputValue(), 'demo1');
      assert.equal(await f.localPage.getByTestId('connect-status').innerText(), status);
      assert.deepEqual(f.actions, []);
      assert.deepEqual([f.counters.signins, f.counters.copies, f.counters.proposals,
        f.counters.approvals, f.counters.terms, f.counters.saves], [0, 0, 0, 0, 0, 0]);
    }
    await f.releaseStartup();
    const record = await f.runner.runWallet(2, confirmation);
    assert.equal(record.walletNumber, 2);
    assert.equal(record.address, manifest[1].address);
    assert.equal(record.loginComplete, true);
    assert.deepEqual([f.counters.signins, f.counters.proposals, f.counters.approvals, f.counters.saves], [1, 1, 1, 1]);
  }
});

test('delayed website startup: a prior Save journal forbids automatic loading retry', async t => {
  const resumeAttempt = { walletNumber: 2, address: manifest[1].address, username: 'demo2', saveAttempted: true };
  const f = await fixture(t, { startupDelayed: true, resumeAttempt, timeoutMs: 500 });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.deepEqual([f.counters.signins, f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [0, 0, 0, 0, 0]);
});

test('delayed website startup: armed authorization forbids automatic loading retry', async t => {
  const f = await fixture(t, { startupDelayed: true, initialAuthorized: true, timeoutMs: 500 });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.deepEqual([f.counters.signins, f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [0, 0, 0, 0, 0]);
  assert.equal(await f.localPage.getByRole('checkbox', { name: '自动确认一次此用户名签名' }).isChecked(), false);
});

test('delayed website startup: an active wrong wallet, pending request, or error does not become a loading retry', async t => {
  for (const status of ['钱包已连接，等待官网请求', '有请求等待你确认', '连接未完成']) {
    const f = await fixture(t, { startupDelayed: true, timeoutMs: 500 });
    await f.localPage.getByTestId('connect-status').evaluate((node, text) => { node.textContent = text; }, status);
    await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
    assert.deepEqual([f.counters.signins, f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [0, 0, 0, 0, 0]);
  }
});

test('delayed website startup: eventual stale Terms still require reset and a fresh connection before agreement', async t => {
  const f = await fixture(t, { startupDelayed: true, startStaleTerms: true, timeoutMs: 500 });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'WEBSITE_LOADING_PENDING');
  assert.deepEqual(f.actions, []);
  await f.releaseStartup();
  const record = await f.runner.runWallet(2, confirmation);
  assert.equal(record.loginComplete, true);
  assert.deepEqual(f.actions, ['close_stale', 'signin', 'walletconnect', 'copy', 'proposal', 'approve', 'agree', 'next', 'save']);
  assert.deepEqual([f.counters.staleTermsCloses, f.counters.staleTermsAgreements, f.counters.proposals,
    f.counters.approvals, f.counters.saves], [1, 0, 1, 1, 1]);
});

test('delayed bridge initialization: busy disabled receive button permits idle pending without another receive click', async t => {
  const f = await fixture(t, { deferredBridgeInitialization: true, deferProposal: true, timeoutMs: 500 });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'CONNECTION_PROPOSAL_PENDING');
    assert.equal(await f.localPage.getByTestId('connect-status').innerText(), '尚未连接');
    assert.equal(await f.localPage.locator('#receive-proposal').getAttribute('aria-busy'), 'true');
    assert.equal(await f.localPage.locator('#receive-proposal').isDisabled(), true);
    assert.deepEqual([f.counters.signins, f.counters.copies, f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 1, 1, 0, 0, 0]);
  }
  await f.releaseBridgeInitialization();
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'CONNECTION_PROPOSAL_PENDING');
  assert.equal(await f.localPage.getByTestId('connect-status').innerText(), '正在等待官网连接请求');
  await f.releaseProposal();
  const record = await f.runner.runWallet(2, confirmation);
  assert.equal(record.walletNumber, 2);
  assert.equal(record.loginComplete, true);
  assert.deepEqual([f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 1, 1, 1]);
});

test('delayed bridge initialization: idle without a busy disabled receive button cannot keep retrying', async t => {
  const f = await fixture(t, { deferredBridgeInitialization: true, deferProposal: true, timeoutMs: 500 });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'CONNECTION_PROPOSAL_PENDING');
  await f.localPage.locator('#receive-proposal').evaluate(button => {
    button.disabled = false; button.removeAttribute('aria-busy');
  });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.deepEqual([f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 0, 0, 0]);
});

test('delayed bridge initialization: a visible alert blocks idle retry even while receive is busy', async t => {
  const f = await fixture(t, { deferredBridgeInitialization: true, deferProposal: true, timeoutMs: 500 });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'CONNECTION_PROPOSAL_PENDING');
  await f.localPage.locator('section[aria-labelledby="pairing"]').evaluate(section => {
    section.insertAdjacentHTML('beforeend', '<p role="alert">Synthetic connection initialization error</p>');
  });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.deepEqual([f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 0, 0, 0]);
});

test('delayed prepared page: finish waits for Terms to return without replaying the connection', async t => {
  const f = await fixture(t);
  const prepared = await f.runner.prepare(2);
  assert.deepEqual([f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 1, 0, 0]);
  await f.nadoPage.locator('body').evaluate(body => {
    const terms = body.innerHTML;
    body.innerHTML = '<p role="status">Refreshing registration page…</p>';
    setTimeout(() => { body.innerHTML = terms; }, 350);
  });
  const record = await f.runner.finish(prepared, confirmation);
  assert.equal(record.walletNumber, 2);
  assert.equal(record.address, manifest[1].address);
  assert.equal(record.loginComplete, true);
  assert.deepEqual([f.counters.signins, f.counters.walletconnect, f.counters.copies,
    f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 1, 1, 1, 1, 1, 1]);
});

test('delayed Ink profile: hiding Switch to Ink does not complete before the profile chain updates', async t => {
  const f = await fixture(t, { startComplete: 'demo2' });
  await f.nadoPage.locator('body').evaluate(body => {
    const chain = body.querySelector('img');
    chain.alt = 'Other';
    const switchButton = document.createElement('button');
    switchButton.textContent = 'Switch to Ink';
    switchButton.onclick = () => {
      switchButton.remove();
      setTimeout(() => { chain.alt = 'Ink'; }, 350);
    };
    body.append(switchButton);
  });
  const record = await f.runner.runWallet(2, confirmation);
  assert.equal(record.walletNumber, 2);
  assert.equal(record.address, manifest[1].address);
  assert.equal(record.username, 'demo2');
  assert.equal(record.websiteNetwork, 'Ink');
  assert.equal(record.loginComplete, true);
  assert.equal(await f.nadoPage.locator('img').getAttribute('alt'), 'Ink');
  assert.deepEqual(f.actions, []);
  assert.deepEqual([f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [0, 0, 0, 0]);
});

test('unnamed Account 1 profile: stale website session signs out and pairs freshly before completing', async t => {
  const f = await fixture(t, { startComplete: 'Account 1' });
  await f.localPage.getByTestId('connect-status').evaluate(node => { node.textContent = '尚未连接'; });
  const record = await f.runner.runWallet(2, confirmation);
  assert.equal(record.walletNumber, 2);
  assert.equal(record.address, manifest[1].address);
  assert.equal(record.username, 'demo2');
  assert.equal(record.usernameAutoSigned, true);
  assert.equal(record.loginComplete, true);
  assert.deepEqual(f.actions, ['menu', 'signout', 'signin', 'walletconnect', 'copy', 'proposal', 'approve', 'agree', 'next', 'save']);
  assert.deepEqual([f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 1, 1, 1]);
});

test('unnamed Account 1 after pairing stops waiting and never records a completed registration', async t => {
  const f = await fixture(t, { deferOnboarding: true, timeoutMs: 500 });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'ONBOARDING_PENDING');
  await f.releaseProfile(2, 'Account 1');
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => {
    assert.equal(error.code, 'NEEDS_ATTENTION');
    assert.equal(error.stage, 'waiting_onboarding');
    assert.equal(error.uiState.siteStage, 'connected_unnamed');
    assert.equal(error.retainedBrowserSafe, true);
    return true;
  });
  assert.equal(f.localPage.isClosed(), false);
  assert.equal(await f.localPage.getByTestId('connect-status').innerText(), '尚未连接');
  assert.equal(await f.localPage.getByRole('checkbox', { name: '自动确认一次此用户名签名' }).isChecked(), false);
  assert.deepEqual([f.counters.signins, f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 1, 1, 0, 0]);
});

test('safe retention requires visibly revoked authority and disconnected bridge', async t => {
  const f = await fixture(t, { deferProposal: true, timeoutMs: 500 });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'CONNECTION_PROPOSAL_PENDING');
  await f.localPage.getByRole('button', { name: '断开连接', exact: true })
    .evaluate(button => { button.onclick = () => {}; });
  await f.localPage.locator('section[aria-labelledby="pairing"]').evaluate(section => {
    section.insertAdjacentHTML('beforeend', '<p role="alert">Synthetic connection error</p>');
  });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => {
    assert.equal(error.code, 'NEEDS_ATTENTION');
    assert.equal(error.retainedBrowserSafe, false);
    return true;
  });
  assert.equal(f.localPage.isClosed(), true);
  assert.deepEqual([f.counters.proposals, f.counters.approvals, f.counters.saves], [1, 0, 0]);
});

for (const title of ['', 'Nado 交易台']) {
  test(`Next route announcer with ${title ? 'a route title' : 'empty text'} does not reject a pending connection`, async t => {
    const f = await fixture(t, { deferProposal: true, timeoutMs: 500 });
    await f.localPage.locator('body').evaluate((body, text) => {
      // Match Next 15 app-router-announcer.js, including its open shadow root
      // and clipped 1px box. Playwright :visible matches this accessibility node.
      const container = document.createElement('next-route-announcer');
      container.style.cssText = 'position:absolute';
      const announcer = document.createElement('div');
      announcer.ariaLive = 'assertive';
      announcer.id = '__next-route-announcer__';
      announcer.role = 'alert';
      announcer.style.cssText = 'position:absolute;border:0;height:1px;margin:-1px;padding:0;width:1px;clip:rect(0 0 0 0);overflow:hidden;white-space:nowrap;word-wrap:normal';
      announcer.textContent = text;
      container.attachShadow({ mode: 'open' }).appendChild(announcer);
      body.appendChild(container);
    }, title);
    assert.equal(await f.localPage.locator('[role="alert"]:visible').count(), 1);
    assert.equal(await f.localPage.locator('#__next-route-announcer__').textContent(), title);
    assert.equal(await f.localPage.locator('section[aria-labelledby="pairing"] [role="alert"]').count(), 0);
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'CONNECTION_PROPOSAL_PENDING');
      assert.equal(f.localPage.isClosed(), false);
      assert.equal(await f.localPage.getByTestId('connect-status').innerText(), '正在等待官网连接请求');
      assert.deepEqual([f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 0, 0, 0]);
    }
    await f.releaseProposal();
    const record = await f.runner.runWallet(2, confirmation);
    assert.equal(record.walletNumber, 2);
    assert.equal(record.username, 'demo2');
    assert.equal(record.loginComplete, true);
    assert.deepEqual([f.counters.signins, f.counters.copies, f.counters.proposals,
      f.counters.approvals, f.counters.terms, f.counters.saves], [1, 1, 1, 1, 1, 1]);
  });
}

test('Terms continuation: a matching completed profile after waiting for consent is verified without Save', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.runner.runWallet(2), error => error.code === 'TERMS_CONFIRMATION_REQUIRED');
  assert.deepEqual((await f.runner.readTermsCandidate()).declarations, declarations);
  await f.releaseProfile(2, 'demo2');
  const record = await f.runner.runWallet(2, confirmation);
  assert.equal(record.walletNumber, 2);
  assert.equal(record.address, manifest[1].address);
  assert.equal(record.username, 'demo2');
  assert.equal(record.loginComplete, true);
  assert.equal(record.usernameAutoSigned, false);
  assert.deepEqual([f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 1, 0, 0]);
});

test('Terms continuation: changed declarations are rejected before Agree despite prior confirmation', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.runner.runWallet(2), error => error.code === 'TERMS_CONFIRMATION_REQUIRED');
  assert.deepEqual((await f.runner.readTermsCandidate()).declarations, confirmation.declarations);
  await f.nadoPage.getByRole('dialog').locator('li').first()
    .evaluate(node => { node.textContent = 'Changed synthetic declaration requiring new consent.'; });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
  assert.deepEqual([f.counters.proposals, f.counters.approvals, f.counters.terms, f.counters.saves], [1, 1, 0, 0]);
  assert.equal(await f.localPage.getByRole('checkbox', { name: '自动确认一次此用户名签名' }).isChecked(), false);
});

const connectionFailureMessages = [
  ['等待官网连接超时，请重新生成连接链接。', 'pair_timeout'],
  ['连接失败，请检查项目 ID、网络和官网连接链接后重试。', 'pair_failed'],
  ['连接申请已过期，请在官网重新连接。', 'proposal_expired'],
  ['连接申请已过期，请从官网重新生成链接。', 'proposal_expired'],
];
async function disconnectFixture(f, message = connectionFailureMessages[0][0]) {
  await f.localPage.locator('section[aria-labelledby="pairing"]').evaluate((section, text) => {
    section.querySelector('[data-testid="connect-status"]').textContent = '已断开连接';
    const alert = document.createElement('p'); alert.role = 'alert'; alert.textContent = text;
    section.appendChild(alert);
  }, message);
}
async function failDisconnected(f, number = 2) {
  let failure;
  await assert.rejects(() => f.runner.runWallet(number, confirmation), error => {
    assert.equal(error.code, 'NEEDS_ATTENTION'); failure = error; return true;
  });
  return failure;
}
async function recoverableFixture(t, message = connectionFailureMessages[0][0], options = {}) {
  const f = await fixture(t, { deferProposal: true, timeoutMs: 500, ...options });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'CONNECTION_PROPOSAL_PENDING');
  await disconnectFixture(f, message);
  return f;
}

test('explicit connection recovery: timeout resets only the website, then fresh pairing completes with one Save', async t => {
  const f = await recoverableFixture(t);
  const failure = await failDisconnected(f);
  assert.equal(failure.connectionRecoveryAllowed, true);
  assert.equal(failure.retainedBrowserSafe, true);
  assert.deepEqual(failure.uiState, {
    siteStage: 'pairing', localStatus: 'disconnected', fault: 'ui_state', disconnectReason: 'pair_timeout',
    walletMatches: true, usernameMatches: true, authorizationArmed: false,
  });
  const before = [...f.actions];
  assert.deepEqual(await f.runner.recoverConnection(2), { walletNumber: 2, recovered: true });
  assert.equal(f.nadoPage.url(), NADO);
  assert.equal(f.counters.navigations, 2);
  assert.deepEqual(f.actions, before); // Navigation itself never pairs, approves, accepts, or saves.
  assert.equal(await f.nadoPage.getByRole('button', { name: 'Sign In', exact: true }).and(f.nadoPage.locator(':visible')).count(), 1);
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'CONNECTION_PROPOSAL_PENDING');
  await f.releaseProposal();
  const record = await f.runner.runWallet(2, confirmation);
  assert.equal(record.walletNumber, 2);
  assert.equal(record.address, manifest[1].address);
  assert.equal(record.loginComplete, true);
  assert.deepEqual([f.counters.signins, f.counters.walletconnect, f.counters.copies, f.counters.proposals,
    f.counters.approvals, f.counters.terms, f.counters.saves], [2, 2, 2, 2, 1, 1, 1]);
  await assert.rejects(() => f.runner.recoverConnection(2), error => error.connectionRecoveryAllowed !== true);
  assert.equal(f.counters.navigations, 2);
  assert.equal(f.counters.saves, 1);
});

test('explicit connection recovery: exact failure and both expiry messages produce fixed public reason enums', async t => {
  for (const [message, reason] of connectionFailureMessages.slice(1)) {
    const f = await recoverableFixture(t, message);
    const failure = await failDisconnected(f);
    assert.equal(failure.connectionRecoveryAllowed, true);
    assert.equal(failure.uiState.disconnectReason, reason);
    assert.equal(JSON.stringify(failure.uiState).includes(message), false);
    await f.runner.recoverConnection(2);
    assert.deepEqual([f.counters.navigations, f.counters.approvals, f.counters.saves], [2, 0, 0]);
  }
});

test('explicit connection recovery: unknown, source rejection, near-match and ambiguous errors never authorize reset', async t => {
  for (const message of [
    'Synthetic unknown connection failure',
    '官网来源验证失败，拒绝连接。',
    connectionFailureMessages[0][0] + ' Extra unrecognized details',
    connectionFailureMessages[0][0],
  ]) {
    const f = await recoverableFixture(t, message);
    if (message === connectionFailureMessages[0][0]) {
      await f.localPage.locator('section[aria-labelledby="pairing"]').evaluate(section => {
        section.insertAdjacentHTML('beforeend', '<p role="alert">来源 UNKNOWN</p>');
      });
    }
    const failure = await failDisconnected(f);
    assert.notEqual(failure.connectionRecoveryAllowed, true);
    assert.equal(failure.uiState.disconnectReason, 'unknown');
    assert.equal(failure.uiState.recoveryBlocker, 'failure_unconfirmed');
    await assert.rejects(() => f.runner.recoverConnection(2), error => error.connectionRecoveryAllowed !== true);
    assert.deepEqual([f.counters.navigations, f.counters.approvals, f.counters.saves], [1, 0, 0]);
  }
});

test('explicit connection recovery: armed authority, wrong wallet or username, and active request are ineligible before cleanup', async t => {
  for (const change of ['authorization', 'number', 'address', 'username', 'request']) {
    const f = await recoverableFixture(t);
    await f.localPage.locator('body').evaluate((body, kind) => {
      if (kind === 'authorization') body.querySelector('#username-auth').checked = true;
      if (kind === 'number') body.querySelector('#wallet-number').value = '3';
      if (kind === 'address') body.querySelector('#wallet-address').textContent = '0x' + '3'.repeat(40);
      if (kind === 'username') body.querySelector('#local-username').value = 'other2';
      if (kind === 'request') body.querySelector('#proposal').innerHTML = '<section aria-labelledby="request-title"><h2 id="request-title">有请求等待你确认</h2></section>';
    }, change);
    const failure = await failDisconnected(f);
    assert.notEqual(failure.connectionRecoveryAllowed, true);
    assert.equal(failure.uiState.recoveryBlocker,
      change === 'authorization' ? 'authorization_armed' : change === 'request' ? 'active_request' : 'state_changed');
    assert.equal(failure.retainedBrowserSafe, true);
    assert.equal(await f.localPage.getByRole('checkbox').isChecked(), false);
    await assert.rejects(() => f.runner.recoverConnection(2));
    assert.deepEqual([f.counters.navigations, f.counters.approvals, f.counters.saves], [1, 0, 0]);
  }
});

test('explicit connection recovery: an existing Save journal cannot be reset even when disconnected with a known error', async t => {
  const resumeAttempt = { walletNumber: 2, address: manifest[1].address, username: 'demo2', saveAttempted: true };
  const f = await fixture(t, { deferProposal: true, timeoutMs: 500, resumeAttempt });
  await assert.rejects(() => f.runner.runWallet(2, confirmation), error => error.code === 'NEEDS_ATTENTION');
  await disconnectFixture(f);
  const failure = await failDisconnected(f);
  assert.notEqual(failure.connectionRecoveryAllowed, true);
  assert.equal(failure.uiState.recoveryBlocker, 'save_intent');
  await assert.rejects(() => f.runner.recoverConnection(2));
  assert.deepEqual([f.counters.navigations, f.counters.approvals, f.counters.saves], [1, 0, 0]);
});

test('explicit connection recovery: wrong recovery number consumes the candidate without any navigation', async t => {
  const f = await recoverableFixture(t);
  assert.equal((await failDisconnected(f)).connectionRecoveryAllowed, true);
  await assert.rejects(() => f.runner.recoverConnection(3), error => error.connectionRecoveryAllowed !== true);
  await assert.rejects(() => f.runner.recoverConnection(2), error => error.connectionRecoveryAllowed !== true);
  assert.deepEqual([f.counters.navigations, f.counters.approvals, f.counters.saves], [1, 0, 0]);
});

test('explicit connection recovery: rechecks wallet, username, authorization, active requests, alerts and website before navigation', async t => {
  for (const change of ['wallet', 'username', 'authorization', 'request', 'alert', 'site']) {
    const f = await recoverableFixture(t);
    assert.equal((await failDisconnected(f)).connectionRecoveryAllowed, true);
    if (change === 'site') await f.releaseProfile(2);
    else await f.localPage.locator('body').evaluate((body, kind) => {
      if (kind === 'wallet') body.querySelector('#wallet-address').textContent = '0x' + '3'.repeat(40);
      if (kind === 'username') body.querySelector('#local-username').value = 'other2';
      if (kind === 'authorization') body.querySelector('#username-auth').checked = true;
      if (kind === 'request') body.querySelector('#proposal').innerHTML = '<section aria-labelledby="request-title">有请求等待你确认</section>';
      if (kind === 'alert') body.querySelector('section[aria-labelledby="pairing"]').insertAdjacentHTML('beforeend', '<p role="alert">Unknown new failure</p>');
    }, change);
    await assert.rejects(() => f.runner.recoverConnection(2), error => error.connectionRecoveryAllowed !== true);
    await assert.rejects(() => f.runner.recoverConnection(2));
    assert.deepEqual([f.counters.navigations, f.counters.approvals, f.counters.saves], [1, 0, 0]);
  }
});

test('explicit connection recovery: failed cleanup never exposes a reset candidate', async t => {
  const f = await recoverableFixture(t);
  await f.localPage.getByRole('button', { name: '断开连接', exact: true }).evaluate(button => {
    button.onclick = () => { document.querySelector('[data-testid="connect-status"]').textContent = '正在等待官网连接请求'; };
  });
  const failure = await failDisconnected(f);
  assert.equal(failure.retainedBrowserSafe, false);
  assert.notEqual(failure.connectionRecoveryAllowed, true);
  assert.equal(f.localPage.isClosed(), true);
  await assert.rejects(() => f.runner.recoverConnection(2));
  assert.equal(f.counters.navigations, 1);
});

test('explicit connection recovery: failed signed-out verification consumes the reset and never signs', async t => {
  const f = await recoverableFixture(t);
  assert.equal((await failDisconnected(f)).connectionRecoveryAllowed, true);
  await f.nadoPage.route(NADO, route => route.fulfill({
    status: 200, contentType: 'text/html', body: '<p>Unrecognized page after navigation</p>',
  }));
  await assert.rejects(() => f.runner.recoverConnection(2), error => error.connectionRecoveryAllowed !== true);
  await assert.rejects(() => f.runner.recoverConnection(2));
  assert.equal(f.counters.approvals, 0);
  assert.equal(f.counters.saves, 0);
});

test('explicit connection recovery: the known Next shadow announcer on Nado cannot block a reset', async t => {
  const f = await recoverableFixture(t);
  await f.nadoPage.locator('body').evaluate(body => {
    const container = document.createElement('next-route-announcer');
    const announcer = document.createElement('div');
    announcer.id = '__next-route-announcer__'; announcer.role = 'alert';
    announcer.style.cssText = 'position:absolute;height:1px;width:1px;clip:rect(0 0 0 0);overflow:hidden';
    announcer.textContent = 'Nado';
    container.attachShadow({ mode: 'open' }).appendChild(announcer); body.appendChild(container);
  });
  assert.equal(await f.nadoPage.locator('[role="alert"]:visible').count(), 1);
  assert.equal((await failDisconnected(f)).connectionRecoveryAllowed, true);
  await f.runner.recoverConnection(2);
  assert.deepEqual([f.counters.navigations, f.counters.approvals, f.counters.saves], [2, 0, 0]);
});

test('explicit connection recovery: real website alerts and visible challenge frames block resetting', async t => {
  for (const obstruction of ['alert', 'iframe']) {
    const f = await recoverableFixture(t);
    await f.nadoPage.locator('body').evaluate((body, kind) => {
      const node = document.createElement(kind === 'alert' ? 'p' : 'iframe');
      if (kind === 'alert') { node.role = 'alert'; node.textContent = 'Synthetic access restriction'; }
      else node.title = 'Synthetic verification challenge';
      body.appendChild(node);
    }, obstruction);
    const failure = await failDisconnected(f);
    assert.notEqual(failure.connectionRecoveryAllowed, true);
    assert.equal(failure.uiState.recoveryBlocker, 'site_alert_or_frame');
    await assert.rejects(() => f.runner.recoverConnection(2));
    assert.deepEqual([f.counters.navigations, f.counters.approvals, f.counters.saves], [1, 0, 0]);
  }
});

test('recovery diagnostics: known pair failure with a still-busy receive button remains ineligible', async t => {
  const f = await recoverableFixture(t, connectionFailureMessages[1][0]);
  await f.localPage.getByRole('button', { name: '接收官网连接请求', exact: true })
    .evaluate(button => { button.setAttribute('aria-busy', 'true'); });
  const failure = await failDisconnected(f);
  assert.equal(failure.uiState.disconnectReason, 'pair_failed');
  assert.equal(failure.uiState.recoveryBlocker, 'local_busy');
  assert.equal(failure.retainedBrowserSafe, true);
  assert.notEqual(failure.connectionRecoveryAllowed, true);
  await assert.rejects(() => f.runner.recoverConnection(2));
  assert.deepEqual([f.counters.navigations, f.counters.proposals, f.counters.approvals, f.counters.saves], [1, 1, 0, 0]);
});

test('recovery diagnostics: an existing website profile blocks reset without exposing profile data', async t => {
  const f = await recoverableFixture(t);
  await f.releaseProfile(2);
  const failure = await failDisconnected(f);
  assert.equal(failure.uiState.recoveryBlocker, 'site_profile');
  assert.notEqual(failure.connectionRecoveryAllowed, true);
  await assert.rejects(() => f.runner.recoverConnection(2));
  assert.equal(JSON.stringify(failure.uiState).includes(manifest[1].address), false);
  assert.deepEqual([f.counters.navigations, f.counters.approvals, f.counters.saves], [1, 0, 0]);
});

test('recovery diagnostics: an inspection exception records only a fixed blocker and never retries', async t => {
  const f = await recoverableFixture(t);
  // The button's accessible name is absent, so the existing getAttribute check
  // times out. No additional observer or fallback read is introduced.
  f.localPage.setDefaultTimeout(100);
  await f.localPage.getByRole('button', { name: '接收官网连接请求', exact: true })
    .evaluate(button => { button.textContent = 'SYNTHETIC_PRIVATE_RECOVERY_SENTINEL'; });
  const failure = await failDisconnected(f);
  assert.equal(failure.uiState.recoveryBlocker, 'inspection_failed');
  assert.notEqual(failure.connectionRecoveryAllowed, true);
  assert.equal(JSON.stringify(failure.uiState).includes('SYNTHETIC_PRIVATE_RECOVERY_SENTINEL'), false);
  await assert.rejects(() => f.runner.recoverConnection(2));
  assert.deepEqual([f.counters.navigations, f.counters.approvals, f.counters.saves], [1, 0, 0]);
});
