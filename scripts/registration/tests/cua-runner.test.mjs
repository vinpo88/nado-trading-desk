import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNadoBatchRunner, createPlannedNadoRunner, parseTermsAX,
  validateTermsConfirmation, assertTermsMatch, validatePairingUri,
  withRegistrationClipboardLock,
} from '../cua-runner.mjs';

const declarations = Array.from({ length: 6 }, (_, i) => `Reviewed declaration ${i + 1}.`);
const links = ['https://nado.xyz/legal-docs/terms-of-use', 'https://nado.xyz/legal-docs/privacy-policy'];
const confirmation = { confirmed: true, context: 'Synthetic fixture confirmation only.', declarations, termsUrl: links[0], privacyUrl: links[1] };
const manifest = Array.from({ length: 4 }, (_, i) => ({ walletNumber: i + 1, address: '0x' + (i + 1).toString(16).padStart(40, '0') }));
const termsAX = () => ['\t21 container Terms of Use, ID: terms', '\t\t33 content list', ...declarations.flatMap((text, i) => [`\t\t\t${40 + i * 2} container`, `\t\t\t\t${41 + i * 2} text ${text}`]), '\t\t60 button Agree to Terms'].join('\n');
const element = values => ({ getClientRects: () => [1], textContent: '', innerText: '', ...values });

// A synthetic visible DOM and documented locator surface. No browser, wallet,
// relay, or external request is created by these tests.
function fakeTabs({ browser = 'chrome', sharedClipboard = { text: '' }, tag = 'ab', badFill = false, wrongOutcome = false, wrongAddress = false, chainAlt = 'Ink' } = {}) {
  let website = 'signin'; let local = 'idle'; let number = '1'; let username = 'demo1'; let displayName = ''; let capturedUri = '';
  const actions = [];
  const ownUri = `wc:${tag.repeat(32)}@2?symKey=${'cd'.repeat(32)}&expiryTimestamp=${Math.floor(Date.now() / 1000) + 600}`;
  const address = () => wrongAddress ? '0x' + 'f'.repeat(40) : manifest[Number(number) - 1].address;
  const publicLabel = () => `Ink ${address().slice(0, 6)}…${address().slice(-4)} ${displayName}`;
  const termsScope = element({
    tagName: 'SECTION', parentElement: element({ tagName: 'BODY' }),
    querySelectorAll(selector) {
      if (selector.includes('[role="heading"]')) return [element({ textContent: 'Terms of Use' })];
      if (selector === 'ul,ol,[role="list"]') return [element({
        childNodes: [], children: declarations.map(text => element({ tagName: 'LI', innerText: text })),
      })];
      if (selector === 'a[href]') return links.map(href => element({ href }));
      return [];
    },
  });
  const proposalScope = element({
    tagName: 'SECTION', parentElement: element({ tagName: 'BODY' }),
    querySelectorAll(selector) {
      if (selector.includes('[role="heading"]')) return [element({ textContent: '确认连接请求' })];
      if (selector === 'p') return [
        element({ textContent: '已核验的网站来源：https://app.nado.xyz' }),
        element({ textContent: '钱包：' + address() }),
        element({ textContent: '网络：Ink 主网（57073）' }),
      ];
      return [];
    },
  });
  function locator(side, type, name) {
    const item = {
      first() { return item; },
      and() { return item; },
      getByText(text) { return locator(side, 'button', text); },
      async waitFor() { if (name === 'Save' && website !== 'username') throw new Error('Wrong stage'); },
      async check() { actions.push('authorize:' + username); },
      async fill(value) {
        if (name === '钱包编号（从 1 开始）') { number = value; username = 'demo' + value; }
        else if (name === '本次官网用户名') username = value;
        else if (name === '#displayName') displayName = value;
        else if (name === 'WalletConnect 连接码') {
          if (badFill) throw new Error('locator.fill: secret=' + value);
          capturedUri = value;
          actions.push('fill-pairing');
        }
      },
      async click() {
        actions.push(String(name));
        if (name === 'Sign In') website = 'methods';
        if (name === 'WalletConnect') website = 'qr';
        if (name === 'Copy link') sharedClipboard.text = ownUri;
        if (name === '接收官网连接请求') local = 'proposal';
        if (name === '同意连接此钱包') { local = 'connected'; website = 'terms'; }
        if (name === 'Agree to Terms') website = 'intro';
        if (name === 'Next') website = 'username';
        if (name === 'Save') website = 'done';
        if (name === 'Sign Out') website = 'signin';
        if (name === '断开连接') local = 'idle';
      },
      async evaluate(fn) {
        if (name === '钱包编号（从 1 开始）') return fn(element({ value: number }));
        if (name === '本次官网用户名') return fn(element({ value: username }));
        if (name === '#displayName') return fn(element({ value: displayName }));
        if (name === 'connect-wallet-address') return fn(element({ textContent: address() }));
        if (name === 'Agree to Terms') return fn(element({ parentElement: termsScope }));
        if (name === '同意连接此钱包') return fn(element({ parentElement: proposalScope }));
        if (name === 'body') return fn(element({ querySelectorAll: selector => {
          if (side === 'local' && selector === 'p' && website === 'done') return [element({ textContent: '已按本次授权签署用户名：' + (wrongOutcome ? username + '0' : username) + '，请在官网核对保存结果。' })];
          return [];
        } }));
        if (name instanceof RegExp) return fn(element({
          // Actual Nado DOM puts Ink in the image alt, not the button innerText.
          innerText: `${address().slice(0, 6)}…${address().slice(-4)}\n${displayName}`,
          querySelectorAll: selector => selector === 'img[alt]' && chainAlt !== null
            ? [element({ getAttribute: name => name === 'alt' ? chainAlt : null })] : [],
        }));
        throw new Error('Unexpected synthetic locator evaluate: ' + name);
      },
    };
    return item;
  }
  const makeTab = side => ({
    playwright: {
      getByRole: (role, options = {}) => locator(side, role, options.name ?? role),
      getByLabel: name => locator(side, 'label', name),
      getByTestId: name => locator(side, 'testid', name),
      locator: name => locator(side, 'selector', name),
    },
    async getAXState() {
      if (side === 'local') return local === 'idle' ? '尚未连接' : local === 'proposal' ? '确认连接请求 网络：Ink 主网（57073）' : '钱包已连接，等待官网请求';
      if (website === 'terms') return browser === 'iab' ? termsAX() : 'heading "Terms of Use"\nbutton "Agree to Terms"';
      if (website === 'intro') return "We're Introducing Usernames\nbutton Next";
      if (website === 'done') return publicLabel();
      if (website === 'signin') return 'button Sign In';
      if (website === 'methods') return 'button WalletConnect';
      if (website === 'qr') return 'button Copy link';
      return 'text field displayName\nbutton Save';
    },
    async click(index) { assert.equal(index, 60); await locator(side, 'button', 'Agree to Terms').click(); },
    async reload() { throw new Error('Normal flow must not reload'); },
    clipboard: {
      async writeText(text) { sharedClipboard.text = text; await Promise.resolve(); },
      async readText() { await Promise.resolve(); return sharedClipboard.text; },
    },
  });
  return { localTab: makeTab('local'), nadoTab: makeTab('nado'), actions, ownUri, captured: () => capturedUri };
}
const fakeStyle = () => ({ visibility: 'visible', display: 'block' });

test('terms require explicit context, all six exact declarations, and official links', () => {
  assert.throws(() => validateTermsConfirmation(undefined));
  assert.throws(() => validateTermsConfirmation({ ...confirmation, confirmed: false }));
  assert.throws(() => validateTermsConfirmation({ ...confirmation, context: '' }));
  assert.throws(() => validateTermsConfirmation({ ...confirmation, declarations: declarations.slice(1) }));
  assert.throws(() => validateTermsConfirmation({ ...confirmation, termsUrl: 'https://evil.example/legal-docs/terms-of-use' }));
  assert.throws(() => assertTermsMatch({ declarations: [...declarations.slice(1), 'Changed.'], links }, confirmation));
  assert.throws(() => assertTermsMatch({ declarations, links: links.slice(1) }, confirmation));
  assert.equal(assertTermsMatch({ declarations, links }, confirmation).confirmed, true);
  assert.deepEqual(parseTermsAX(termsAX()), declarations);
  assert.throws(() => parseTermsAX(termsAX() + '\n\t\t70 content list'));
  assert.throws(() => parseTermsAX(termsAX().replace('\t\t60 button', '\t\t\t59 text Extra declaration\n\t\t60 button')));
});

test('pairing parser rejects missing/expired/nonfinite timestamps without reflecting secrets', () => {
  const now = 100000;
  const base = `wc:${'ab'.repeat(32)}@2?symKey=${'cd'.repeat(32)}&expiryTimestamp=`;
  validatePairingUri(base + '101', now);
  for (const tail of ['NaN', 'Infinity', '0', '99', '', '101&expiryTimestamp=102']) assert.throws(() => validatePairingUri(base + tail, now));
  assert.throws(() => validatePairingUri('wc:private-value'), error => !error.message.includes('private-value'));
});

test('FIFO clipboard lock serializes whole operations and releases after rejection', async () => {
  const events = [];
  const jobs = ['a', 'b', 'c'].map(name => withRegistrationClipboardLock(async () => {
    events.push(name + ':start'); await Promise.resolve(); events.push(name + ':end');
    if (name === 'b') throw new Error('synthetic rejection');
  }));
  const results = await Promise.allSettled(jobs);
  assert.deepEqual(events, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[2].status, 'fulfilled');
});

test('external browser requires explicit smoke number before any browser operation', async () => {
  const tabs = fakeTabs();
  assert.throws(() => createNadoBatchRunner({ ...tabs, browser: 'edge', walletManifest: manifest, usernameForWallet: n => 'demo' + n, appendProgress: async () => {} }), /smokeTestWalletNumber/);
  const runner = createNadoBatchRunner({ ...tabs, browser: 'edge', walletManifest: manifest, usernameForWallet: n => 'demo' + n, smokeTestWalletNumber: 4, appendProgress: async () => {} });
  await assert.rejects(() => runner.prepare(3), /冒烟/);
  assert.equal(tabs.actions.length, 0);
  assert.equal(runner.status().smokeVerified, false);
});

test('planned runner rejects misspelled lane config rather than silently using lane zero', () => {
  const tabs = fakeTabs();
  assert.throws(() => createPlannedNadoRunner({
    ...tabs, config: { laneCount: 2, laneindex: 1 }, walletManifest: manifest, appendProgress: async () => {},
  }), /未知字段/);
  assert.equal(tabs.actions.length, 0);
});

test('DOM planned runner consumes descending wallets only after explicit consent and persistence', async t => {
  const previousStyle = globalThis.getComputedStyle; globalThis.getComputedStyle = fakeStyle;
  t.after(() => { globalThis.getComputedStyle = previousStyle; });
  const tabs = fakeTabs();
  const records = [];
  const runner = createPlannedNadoRunner({
    ...tabs, config: { bounds: { min: 1, max: 4 }, browser: 'chrome', usernamePrefix: 'demo' },
    walletManifest: manifest, smokeTestWalletNumber: 4, appendProgress: async record => records.push(record),
  });
  assert.equal(runner.status().nextWalletNumber, 4);
  const prepared = await runner.prepareNext();
  assert.equal(prepared.walletNumber, 4);
  await assert.rejects(() => runner.finish(prepared), /明确确认/);
  assert.equal(tabs.actions.includes('Agree to Terms'), false);
  assert.equal(runner.status().nextWalletNumber, 4);
  assert.equal(runner.status().smokeVerified, false);
  await runner.finish(prepared, confirmation);
  assert.equal(records.length, 1);
  assert.equal(records[0].walletNumber, 4);
  assert.equal(records[0].status, 'verified_login_and_ink');
  assert.equal(runner.status().nextWalletNumber, 3);
  assert.equal(runner.status().smokeVerified, true);
  await assert.rejects(() => runner.finish(prepared, confirmation), /当前计划/);
  assert.equal(records.length, 1);
  const next = await runner.prepareNext();
  assert.equal(next.walletNumber, 3);
});

test('failed exact outcome or persistence does not advance the planned queue', async t => {
  const previousStyle = globalThis.getComputedStyle; globalThis.getComputedStyle = fakeStyle;
  t.after(() => { globalThis.getComputedStyle = previousStyle; });
  for (const wrongOutcome of [true, false]) {
    const tabs = fakeTabs({ wrongOutcome });
    const runner = createPlannedNadoRunner({
      ...tabs, config: { bounds: { min: 1, max: 4 } }, walletManifest: manifest,
      appendProgress: async () => { throw new Error('Disk unavailable'); },
    });
    const prepared = await runner.prepareNext();
    await assert.rejects(() => runner.finish(prepared, confirmation), wrongOutcome ? /精确用户名/ : /Disk unavailable/);
    assert.equal(runner.status().nextWalletNumber, 4);
    assert.equal(runner.status().remaining, 4);
  }
});

test('visible chain image must identify Ink independently of address and username text', async t => {
  const previousStyle = globalThis.getComputedStyle; globalThis.getComputedStyle = fakeStyle;
  t.after(() => { globalThis.getComputedStyle = previousStyle; });
  for (const chainAlt of ['Ethereum', null]) {
    const tabs = fakeTabs({ chainAlt });
    let persisted = false;
    const runner = createPlannedNadoRunner({
      ...tabs, config: { bounds: { min: 1, max: 4 } }, walletManifest: manifest,
      appendProgress: async () => { persisted = true; },
    });
    const prepared = await runner.prepareNext();
    await assert.rejects(() => runner.finish(prepared, confirmation), /Ink 网络未核实/);
    assert.equal(persisted, false);
    assert.equal(runner.status().nextWalletNumber, 4);
  }
});

test('manifest mismatch stops before username authorization or pairing', async () => {
  const tabs = fakeTabs({ wrongAddress: true });
  const runner = createNadoBatchRunner({ ...tabs, walletManifest: manifest, usernameForWallet: n => 'demo' + n, appendProgress: async () => {} });
  await assert.rejects(() => runner.prepare(1), /完整地址/);
  assert.equal(tabs.actions.some(action => action.startsWith('authorize')), false);
  assert.equal(tabs.captured(), '');
});

test('concurrent runners sharing a clipboard receive only their own pairing URI', async t => {
  const previousStyle = globalThis.getComputedStyle; globalThis.getComputedStyle = fakeStyle;
  t.after(() => { globalThis.getComputedStyle = previousStyle; });
  const sharedClipboard = { text: '' };
  const tabs = [fakeTabs({ sharedClipboard, tag: 'ab' }), fakeTabs({ sharedClipboard, tag: 'ef' })];
  const runners = tabs.map(tab => createNadoBatchRunner({ ...tab, walletManifest: manifest, usernameForWallet: n => 'demo' + n, appendProgress: async () => {} }));
  await Promise.all(runners.map((runner, i) => runner.prepare(i + 1)));
  assert.equal(tabs[0].captured(), tabs[0].ownUri);
  assert.equal(tabs[1].captured(), tabs[1].ownUri);
  assert.equal(sharedClipboard.text, '');
});

test('pairing locator errors are sanitized and clipboard cleanup still runs', async () => {
  const sharedClipboard = { text: '' };
  const tabs = fakeTabs({ sharedClipboard, badFill: true });
  const runner = createNadoBatchRunner({ ...tabs, walletManifest: manifest, usernameForWallet: n => 'demo' + n, appendProgress: async () => {} });
  await assert.rejects(() => runner.prepare(1), error => {
    assert.equal(String(error.stack).includes('symKey'), false);
    assert.equal(String(error.stack).includes(tabs.ownUri), false);
    assert.equal(error.cause, undefined);
    return /临时连接码/.test(error.message);
  });
  assert.equal(sharedClipboard.text, '');
});
