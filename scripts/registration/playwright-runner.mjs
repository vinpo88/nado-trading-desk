// Standalone Playwright Page automation. Only visible UI and the temporary
// clipboard are used; no cookies, storage, application internals, or keys.
import { randomInt } from 'node:crypto';
import { validateWalletManifest, normalizeProgressRecord } from './planner.mjs';
import { NADO_ORIGIN, validateTermsConfirmation, assertTermsMatch, validatePairingUri, withRegistrationClipboardLock } from './cua-runner.mjs';

const MESSAGES = {
  VAULT_LOCKED: '请在专用浏览器中自行恢复并解锁保险库，然后继续。',
  TERMS_CONFIRMATION_REQUIRED: '请明确确认本次可见的六项声明及官方链接后继续。',
  NEEDS_ATTENTION: '页面或操作状态无法可靠核实，已停止；请人工检查，不要盲目重试保存。',
  ABORTED: '运行已中止，未继续操作。',
  ORIGIN_MISMATCH: '页面已离开已绑定的本地连接页或 Nado 官网，已停止。',
};
export class RegistrationUiError extends Error {
  constructor(code, stage = 'idle', walletNumber) {
    super(MESSAGES[code] ?? MESSAGES.NEEDS_ATTENTION);
    this.name = 'RegistrationUiError'; this.code = code; this.stage = stage;
    if (walletNumber !== undefined) this.walletNumber = walletNumber;
  }
}
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const validName = name => typeof name === 'string' && /^[A-Za-z0-9_.]{3,20}$/.test(name);

export function makeUsernameAlternative(base, walletNumber, digits = String(randomInt(1, 10000)), position) {
  const suffix = String(walletNumber);
  const prefix = typeof base === 'string' && base.endsWith(suffix) ? base.slice(0, -suffix.length) : '';
  if (!/^[A-Za-z]{2,14}$/.test(prefix) || !/^[0-9]{1,4}$/.test(digits)) throw new RegistrationUiError('NEEDS_ATTENTION', 'username_conflict', walletNumber);
  const slot = position ?? randomInt(1, prefix.length);
  if (!Number.isInteger(slot) || slot < 1 || slot >= prefix.length) throw new RegistrationUiError('NEEDS_ATTENTION', 'username_conflict', walletNumber);
  const result = prefix.slice(0, slot) + digits + prefix.slice(slot) + suffix;
  if (!validName(result)) throw new RegistrationUiError('NEEDS_ATTENTION', 'username_conflict', walletNumber);
  return result;
}
export function usernameBelongsToWallet(name, base, walletNumber) {
  if (!validName(name) || !validName(base)) return false;
  if (name === base) return true;
  const suffix = String(walletNumber);
  const prefix = base.endsWith(suffix) ? base.slice(0, -suffix.length) : '';
  return /^[A-Za-z]{2,14}$/.test(prefix) && new RegExp('^' + [...prefix].map(escapeRegExp).join('[0-9]*') + escapeRegExp(suffix) + '$').test(name);
}

// Executed by Playwright as a read-only DOM function. No page globals are read.
function inspectWebsiteDOM({ waitFor = null } = {}) {
  const visible = element => Boolean(element?.getClientRects().length)
    && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
  const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(visible);
  const label = element => (element.getAttribute('aria-label') || element.innerText || '').trim().replace(/\s+/g, ' ');
  const named = name => buttons.filter(button => label(button) === name);
  const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible).map(element => element.innerText.trim());
  const inputs = [...document.querySelectorAll('input#displayName')].filter(visible);
  const profiles = buttons.flatMap(button => {
    const images = [...button.querySelectorAll('img[alt]')].filter(visible);
    const match = /^(0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4})(?:\s+([A-Za-z0-9_.]{3,20}))?$/.exec((button.innerText || '').trim().replace(/\s+/g, ' '));
    return images.length === 1 && match ? [{ chain: images[0].getAttribute('alt'), shortAddress: match[1], username: match[2] ?? null }] : [];
  });
  const result = { stage: 'unknown', profile: profiles.length === 1 ? profiles[0] : null, switchInk: named('Switch to Ink').length === 1 };
  if (named('Agree to Terms').length === 1 && headings.includes('Terms of Use')) result.stage = 'terms';
  else if (headings.includes("We're Introducing Usernames") && named('Next').length === 1) result.stage = 'introduction';
  else if (inputs.length === 1) {
    result.stage = 'username';
    result.username = inputs[0].value;
    const scope = inputs[0].closest('form,[role="dialog"]') ?? inputs[0].parentElement?.parentElement;
    const referencedIds = [inputs[0].getAttribute('aria-describedby'), inputs[0].getAttribute('aria-errormessage')].filter(Boolean).join(' ').split(/\s+/);
    const feedback = [...new Set([
      ...referencedIds.map(id => document.getElementById(id)).filter(visible),
      ...[...(scope?.querySelectorAll('[role="alert"],[aria-live]') ?? [])].filter(visible),
    ])].map(element => element.innerText.trim()).filter(Boolean);
    result.conflict = feedback.some(text => /^(?:this )?username (?:is )?(?:already )?(?:taken|unavailable|not available|exists)[.!]?$/i.test(text));
    result.invalid = inputs[0].getAttribute('aria-invalid') === 'true' && !result.conflict;
    result.saveEnabled = named('Save').length === 1 && !named('Save')[0].disabled && named('Save')[0].getAttribute('aria-disabled') !== 'true';
    result.checking = inputs[0].getAttribute('aria-busy') === 'true'
      || feedback.some(text => /^checking (?:username|availability)[.… ]*$/i.test(text));
    if (result.checking) result.stage = 'username_checking';
    else if (result.conflict) result.stage = 'username_conflict';
    else if (result.invalid) result.stage = 'unknown';
    else if (result.saveEnabled) result.stage = 'username_ready';
  } else if (result.profile?.username) result.stage = 'complete';
  else if (named('Copy link').length === 1) result.stage = 'pairing';
  else if (named('WalletConnect').length === 1) result.stage = 'login_methods';
  else if (named('Sign In').length > 0) result.stage = 'signed_out';
  if (profiles.length > 1 || inputs.length > 1) result.stage = 'unknown';
  return waitFor && !waitFor.includes(result.stage) ? false : result;
}

/** Requires pages already navigated, with the local vault unlocked by its owner.
 * Launcher grants clipboard-read/clipboard-write at NADO_ORIGIN, disables
 * tracing/video, owns the dedicated profile, and persists returned records.
 */
export function createPlaywrightNadoRunner({
  localPage, nadoPage, walletManifest, usernameForWallet = number => 'ybtl' + number,
  termsConfirmation, signal, onEvent = () => {}, timeoutMs = 20000,
  maxUsernameCandidates = 5, resumeAttempt,
}) {
  const manifest = validateWalletManifest(walletManifest);
  const addresses = new Map(manifest.map(wallet => [wallet.walletNumber, wallet.address]));
  if (!localPage?.url || !nadoPage?.url || typeof usernameForWallet !== 'function' || typeof onEvent !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000
    || !Number.isInteger(maxUsernameCandidates) || maxUsernameCandidates < 1 || maxUsernameCandidates > 20) throw new RegistrationUiError('NEEDS_ATTENTION');
  let localOrigin;
  try {
    const url = new URL(localPage.url());
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)
      || url.username || url.password || url.pathname.replace(/\/$/, '') !== '/connect') throw new Error();
    localOrigin = url.origin;
  } catch { throw new RegistrationUiError('ORIGIN_MISMATCH'); }
  const approval = termsConfirmation === undefined ? undefined : validateTermsConfirmation(termsConfirmation);
  let current = null; let busy = false; let stage = 'idle'; let activeNumber;
  let cleanupPromise = null; let lastCandidate = null;
  const saveAttempts = new Map();
  if (resumeAttempt !== undefined) {
    if (!resumeAttempt || resumeAttempt.saveAttempted !== true || addresses.get(resumeAttempt.walletNumber) !== resumeAttempt.address?.toLowerCase()
      || !validName(resumeAttempt.username)) throw new RegistrationUiError('NEEDS_ATTENTION');
    saveAttempts.set(resumeAttempt.walletNumber, resumeAttempt.username);
  }
  const fail = code => { throw new RegistrationUiError(code, stage, activeNumber); };
  function guard() {
    if (signal?.aborted) fail('ABORTED');
    try {
      const local = new URL(localPage.url()); const nado = new URL(nadoPage.url());
      if (local.origin !== localOrigin || local.pathname.replace(/\/$/, '') !== '/connect'
        || nado.origin !== NADO_ORIGIN || local.username || local.password || nado.username || nado.password) fail('ORIGIN_MISMATCH');
    } catch (error) { if (error instanceof RegistrationUiError) throw error; fail('ORIGIN_MISMATCH'); }
  }
  const call = async operation => { guard(); const result = await operation(); guard(); return result; };
  // Chromium can throttle animation frames in a background tab. Playwright's
  // actionability checks and DOM event waits need the actual target foregrounded.
  const localCall = operation => call(async () => { await localPage.bringToFront(); guard(); return operation(); });
  const nadoCall = operation => call(async () => { await nadoPage.bringToFront(); guard(); return operation(); });
  const button = (page, name) => page.getByRole('button', { name, exact: true });
  const authBox = () => localPage.getByRole('checkbox', { name: '自动确认一次此用户名签名', exact: true });
  const usernameInput = () => localPage.getByLabel('本次官网用户名', { exact: true });
  const shortAddress = address => address.slice(0, 6) + '…' + address.slice(-4);
  async function event(next, values = {}) {
    stage = next;
    await onEvent({ stage, ...(activeNumber === undefined ? {} : { walletNumber: activeNumber, address: addresses.get(activeNumber) }), ...values });
  }
  async function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      try {
        if (localPage.isClosed()) return;
        // Only touch the bound local page. Closing it is the fallback that
        // prevents an unconsumed in-memory authorization from surviving.
        const url = new URL(localPage.url());
        if (url.origin !== localOrigin || url.pathname.replace(/\/$/, '') !== '/connect') { await localPage.close({ runBeforeUnload: false }); return; }
        await localPage.bringToFront();
        if (await authBox().isVisible() && await authBox().isChecked()) await authBox().uncheck({ timeout: 3000 });
        const disconnect = button(localPage, '断开连接');
        if (await disconnect.isVisible() && await disconnect.isEnabled()) await disconnect.click({ timeout: 3000 });
        if (await authBox().isVisible() && await authBox().isChecked()) throw new Error();
      } catch {
        try { if (!localPage.isClosed()) await localPage.close({ runBeforeUnload: false }); } catch { /* Worker must close the owning context too. */ }
      }
    })();
    try { await cleanupPromise; } finally { cleanupPromise = null; }
  }
  const abortCleanup = () => { void cleanup(); };
  signal?.addEventListener('abort', abortCleanup, { once: true });
  async function safeOperation(operation) {
    if (busy) fail('NEEDS_ATTENTION');
    busy = true;
    try { guard(); return await operation(); }
    catch (error) {
      if (!(error instanceof RegistrationUiError) || !['VAULT_LOCKED', 'TERMS_CONFIRMATION_REQUIRED'].includes(error.code)) {
        current = null;
        await cleanup();
      }
      // Do not retain raw Playwright errors, which can contain fill arguments.
      if (error instanceof RegistrationUiError) throw error;
      throw new RegistrationUiError(signal?.aborted ? 'ABORTED' : 'NEEDS_ATTENTION', stage, activeNumber);
    } finally { busy = false; }
  }
  async function localState() {
    if (!await localCall(() => localPage.getByTestId('connect-wallet-address').isVisible())) fail('VAULT_LOCKED');
    const number = await localCall(() => localPage.getByLabel('钱包编号（从 1 开始）', { exact: true }).inputValue());
    const address = (await localCall(() => localPage.getByTestId('connect-wallet-address').innerText())).trim().toLowerCase();
    const status = (await localCall(() => localPage.getByTestId('connect-status').innerText())).trim();
    const username = await localCall(() => usernameInput().inputValue());
    const authorized = await localCall(() => authBox().isChecked());
    return { number, address, status, username, authorized };
  }
  async function assertWallet(number, address, { connected = false, allowExecuting = false } = {}) {
    const local = await localState();
    if (local.number !== String(number) || local.address !== address) fail('NEEDS_ATTENTION');
    if (local.status === '有请求等待你确认' || local.status === '连接未完成') fail('NEEDS_ATTENTION');
    if (!allowExecuting && /正在处理已确认的请求|正在核对交易与手续费/.test(local.status)) fail('NEEDS_ATTENTION');
    if (connected && local.status !== '钱包已连接，等待官网请求') fail('NEEDS_ATTENTION');
    return local;
  }
  async function site() { return nadoCall(() => nadoPage.evaluate(inspectWebsiteDOM)); }
  async function waitSite(stages) {
    const handle = await nadoCall(() => nadoPage.waitForFunction(inspectWebsiteDOM, { waitFor: stages }, { timeout: timeoutMs, polling: 'raf' }));
    try { return await call(() => handle.jsonValue()); } finally { await handle.dispose(); }
  }
  async function collapseGetStarted() {
    const expanded = nadoPage.getByRole('button', { name: 'Get started', exact: true }).and(nadoPage.locator('[aria-expanded="true"]:visible'));
    const count = await nadoCall(() => expanded.count());
    if (count > 1) fail('NEEDS_ATTENTION');
    if (count === 1) {
      await nadoCall(() => expanded.click({ timeout: timeoutMs }));
      await nadoCall(() => expanded.waitFor({ state: 'hidden', timeout: timeoutMs }));
    }
  }
  async function readTermsCandidate() {
    guard();
    const observed = await nadoCall(() => button(nadoPage, 'Agree to Terms').evaluate(agree => {
      const visible = element => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
      if (!visible(agree)) throw new Error();
      for (let scope = agree.parentElement; scope && scope.tagName !== 'BODY'; scope = scope.parentElement) {
        const headings = [...scope.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(element => visible(element) && element.innerText.trim() === 'Terms of Use');
        if (!headings.length) continue;
        const lists = [...scope.querySelectorAll('ul,ol,[role="list"]')].filter(visible);
        if (headings.length !== 1 || lists.length !== 1) throw new Error();
        const items = [...lists[0].children].filter(visible);
        if (items.length !== 6 || items.some(item => item.tagName !== 'LI' && item.getAttribute('role') !== 'listitem')
          || [...lists[0].childNodes].some(node => node.nodeType === 3 && node.textContent?.trim())) throw new Error();
        return { declarations: items.map(item => item.innerText.trim()), links: [...scope.querySelectorAll('a[href]')].filter(visible).map(link => link.href) };
      }
      throw new Error();
    }));
    const matching = path => observed.links.filter(value => { try { const url = new URL(value); return url.pathname === path; } catch { return false; } });
    const terms = matching('/legal-docs/terms-of-use'); const privacy = matching('/legal-docs/privacy-policy');
    if (terms.length !== 1 || privacy.length !== 1) fail('NEEDS_ATTENTION');
    // Validation here checks structure/official URLs only, never creates consent.
    validateTermsConfirmation({ confirmed: true, context: 'Candidate structure validation only; not user consent.', declarations: observed.declarations, termsUrl: terms[0], privacyUrl: privacy[0] });
    lastCandidate = Object.freeze({ declarations: Object.freeze([...observed.declarations]), links: Object.freeze([...observed.links]), termsUrl: terms[0], privacyUrl: privacy[0] });
    return lastCandidate;
  }
  async function revokeUnusedAuthorization() {
    if (await localCall(() => authBox().isChecked())) await localCall(() => authBox().uncheck({ timeout: timeoutMs }));
    if (await localCall(() => authBox().isChecked())) fail('NEEDS_ATTENTION');
  }
  async function pair(number, address, base) {
    await event('pairing');
    await nadoCall(() => button(nadoPage, 'Sign In').and(nadoPage.locator(':visible')).first().click({ timeout: timeoutMs }));
    await nadoCall(() => button(nadoPage, 'WalletConnect').click({ timeout: timeoutMs }));
    await nadoCall(() => button(nadoPage, 'Copy link').waitFor({ state: 'visible', timeout: timeoutMs }));
    await withRegistrationClipboardLock(async () => {
      let uri = '';
      try {
        guard();
        await nadoCall(() => nadoPage.evaluate(() => navigator.clipboard.writeText('')));
        await nadoCall(() => button(nadoPage, 'Copy link').click({ timeout: timeoutMs }));
        const ready = await nadoCall(() => nadoPage.waitForFunction(async () => (await navigator.clipboard.readText()).startsWith('wc:'), null, { timeout: timeoutMs, polling: 'raf' }));
        await ready.dispose();
        uri = await nadoCall(() => nadoPage.evaluate(() => navigator.clipboard.readText()));
        if (uri.length > 4096) fail('NEEDS_ATTENTION');
        validatePairingUri(uri);
        await assertWallet(number, address);
        await localCall(() => localPage.getByLabel('WalletConnect 连接码', { exact: true }).fill(uri, { timeout: timeoutMs }));
      } catch { throw new RegistrationUiError(signal?.aborted ? 'ABORTED' : 'NEEDS_ATTENTION', 'pairing', number); }
      finally {
        uri = '';
        try { await nadoPage.bringToFront(); await nadoPage.evaluate(() => navigator.clipboard.writeText('')); }
        catch { throw new RegistrationUiError('NEEDS_ATTENTION', 'clipboard_cleanup', number); }
      }
    });
    await event('waiting_connection_proposal');
    await localCall(() => button(localPage, '接收官网连接请求').click({ timeout: timeoutMs }));
    await localCall(() => button(localPage, '同意连接此钱包').waitFor({ state: 'visible', timeout: timeoutMs }));
    const proposal = await localCall(() => localPage.locator('section[aria-labelledby="proposal-title"]').evaluate(section => {
      if (!section.getClientRects().length) throw new Error();
      const paragraphs = [...section.querySelectorAll('p')].filter(element => element.getClientRects().length).map(element => element.textContent.trim());
      const one = prefix => { const matches = paragraphs.filter(text => text.startsWith(prefix)); if (matches.length !== 1) throw new Error(); return matches[0].slice(prefix.length).trim(); };
      return { origin: one('已核验的网站来源：'), address: one('钱包：'), network: one('网络：') };
    }));
    if (proposal.origin !== NADO_ORIGIN || proposal.address.toLowerCase() !== address || proposal.network !== 'Ink 主网（57073）') fail('NEEDS_ATTENTION');
    await assertWallet(number, address);
    await event('approving_connection');
    await localCall(() => button(localPage, '同意连接此钱包').click({ timeout: timeoutMs }));
    await event('waiting_onboarding');
    const next = await waitSite(['terms', 'introduction', 'username', 'username_ready', 'username_conflict', 'complete']);
    await assertWallet(number, address, { connected: true });
    if (next.profile && next.profile.shortAddress.toLowerCase() !== shortAddress(address)) fail('NEEDS_ATTENTION');
    return next;
  }
  async function prepareImpl(number) {
    activeNumber = number;
    if (current || !addresses.has(number) || (saveAttempts.size && !saveAttempts.has(number))) fail('NEEDS_ATTENTION');
    const address = addresses.get(number); const base = usernameForWallet(number);
    if (!validName(base)) fail('NEEDS_ATTENTION');
    await event('preparing', { username: base });
    let local = await localState(); let website = await site();
    const same = local.number === String(number) && local.address === address;
    const resumable = ['terms', 'introduction', 'username', 'username_ready', 'username_conflict', 'username_checking', 'complete'];
    if (same && local.status === '钱包已连接，等待官网请求' && resumable.includes(website.stage)) {
      await assertWallet(number, address, { connected: true });
      if (website.profile && website.profile.shortAddress.toLowerCase() !== shortAddress(address)) fail('NEEDS_ATTENTION');
    } else {
      if (!['signed_out', 'complete'].includes(website.stage) || /有请求等待你确认|正在处理已确认的请求|正在核对交易与手续费/.test(local.status)) fail('NEEDS_ATTENTION');
      await revokeUnusedAuthorization();
      if (website.stage === 'complete') {
        await event('signing_out');
        await nadoCall(() => nadoPage.getByRole('button', { name: /^Ink 0x/ }).click({ timeout: timeoutMs }));
        await nadoCall(() => nadoPage.getByRole('menuitem', { name: 'Sign Out', exact: true }).click({ timeout: timeoutMs }));
        await waitSite(['signed_out']);
      }
      await event('selecting_wallet');
      if (!['尚未连接', '已断开连接'].includes(local.status)) {
        await localCall(() => button(localPage, '断开连接').click({ timeout: timeoutMs }));
      }
      await localCall(() => localPage.getByLabel('钱包编号（从 1 开始）', { exact: true }).fill(String(number), { timeout: timeoutMs }));
      await localCall(() => localPage.getByTestId('connect-wallet-address')
        .filter({ hasText: new RegExp('^\\s*' + escapeRegExp(address) + '\\s*$', 'i') }).waitFor({ state: 'visible', timeout: timeoutMs }));
      await assertWallet(number, address);
      await localCall(() => usernameInput().fill(base, { timeout: timeoutMs }));
      website = await pair(number, address, base);
    }
    if (website.stage === 'complete' && !usernameBelongsToWallet(website.profile?.username, base, number)) fail('NEEDS_ATTENTION');
    let terms;
    if (website.stage === 'terms') { await collapseGetStarted(); terms = await readTermsCandidate(); }
    current = Object.freeze({ walletNumber: number, address, username: website.stage === 'complete' ? website.profile.username : base, baseUsername: base, stage: website.stage, ...(terms ? { terms } : {}), startedAt: Date.now() });
    await event('prepared', { username: current.username, websiteStage: website.stage });
    return current;
  }
  async function chooseUsername(prepared) {
    const { walletNumber: number, address, baseUsername: base } = prepared;
    if (saveAttempts.has(number)) fail('NEEDS_ATTENTION');
    await revokeUnusedAuthorization();
    let website = await site();
    const candidateSet = new Set();
    let candidate = website.username && usernameBelongsToWallet(website.username, base, number) ? website.username : base;
    for (let attempt = 0; attempt < maxUsernameCandidates; attempt++) {
      if (candidateSet.has(candidate)) fail('NEEDS_ATTENTION');
      candidateSet.add(candidate);
      await event('checking_username', { username: candidate });
      await assertWallet(number, address, { connected: true });
      await nadoCall(() => nadoPage.locator('#displayName').fill(candidate, { timeout: timeoutMs }));
      website = await waitSite(['username_ready', 'username_conflict']);
      if (website.username !== candidate || await nadoCall(() => nadoPage.locator('#displayName').inputValue()) !== candidate) fail('NEEDS_ATTENTION');
      if (website.stage === 'username_conflict') { candidate = makeUsernameAlternative(base, number); continue; }
      await localCall(() => usernameInput().fill(candidate, { timeout: timeoutMs }));
      if (await localCall(() => usernameInput().inputValue()) !== candidate) fail('NEEDS_ATTENTION');
      return candidate;
    }
    fail('NEEDS_ATTENTION');
  }
  async function verifyCompleted(prepared, expectedUsername, signedNow = false) {
    const { walletNumber: number, address, baseUsername: base } = prepared;
    let website = await site();
    if (website.switchInk) {
      await event('switching_ink', { username: expectedUsername });
      await nadoCall(() => button(nadoPage, 'Switch to Ink').click({ timeout: timeoutMs }));
      await nadoCall(() => button(nadoPage, 'Switch to Ink').waitFor({ state: 'hidden', timeout: timeoutMs }));
      website = await site();
    }
    if (saveAttempts.has(number) && saveAttempts.get(number) !== expectedUsername) fail('NEEDS_ATTENTION');
    await localCall(() => localPage.getByTestId('connect-status').filter({ hasText: /^钱包已连接，等待官网请求$/ })
      .waitFor({ state: 'visible', timeout: timeoutMs }));
    if (signedNow) await localCall(() => authBox().and(localPage.locator(':not(:checked)')).waitFor({ state: 'visible', timeout: timeoutMs }));
    const local = await assertWallet(number, address, { connected: true });
    const profile = website.profile;
    if (website.stage !== 'complete' || !profile || profile.chain !== 'Ink' || profile.shortAddress.toLowerCase() !== shortAddress(address)
      || profile.username !== expectedUsername || !usernameBelongsToWallet(profile.username, base, number) || website.switchInk) fail('NEEDS_ATTENTION');
    if (signedNow) {
      const outcomes = await localCall(() => localPage.locator('p:visible').allTextContents());
      const exact = '已按本次授权签署用户名：' + expectedUsername + '，请在官网核对保存结果。';
      if (outcomes.filter(text => text.trim() === exact).length !== 1 || local.authorized) fail('NEEDS_ATTENTION');
    } else await revokeUnusedAuthorization();
    const record = normalizeProgressRecord({
      formatVersion: 1, checkedAt: new Date().toISOString(), walletNumber: number, address,
      username: expectedUsername, status: 'verified_login_and_ink', loginComplete: true,
      websiteSignedIn: true, websiteNetwork: 'Ink', approvedChainId: 57073,
      usernameAutoSigned: signedNow, serverProfileVerified: false, agentTransactionsSent: 0,
      termsAcceptedByAgentWithBatchConfirmation: Boolean(prepared.termsAccepted),
    });
    saveAttempts.delete(number); current = null;
    await event('verified', { username: expectedUsername });
    return record;
  }
  async function finishImpl(prepared, explicitConfirmation) {
    if (!current || current !== prepared) fail('NEEDS_ATTENTION');
    activeNumber = prepared.walletNumber;
    const number = prepared.walletNumber; const address = prepared.address;
    await assertWallet(number, address, { connected: true });
    let website = await site();
    if (website.stage === 'complete') return verifyCompleted(prepared, website.profile.username);
    if (website.stage === 'terms') {
      await collapseGetStarted();
      const candidate = await readTermsCandidate();
      if (!explicitConfirmation) fail('TERMS_CONFIRMATION_REQUIRED');
      try { assertTermsMatch(candidate, explicitConfirmation); } catch { fail('NEEDS_ATTENTION'); }
      await event('accepting_terms');
      await nadoCall(() => button(nadoPage, 'Agree to Terms').click({ timeout: timeoutMs }));
      website = await waitSite(['introduction', 'username', 'username_ready', 'username_conflict', 'complete']);
      prepared = { ...prepared, termsAccepted: true };
    }
    if (website.stage === 'complete') return verifyCompleted(prepared, website.profile.username);
    if (website.stage === 'introduction') {
      await event('username_introduction');
      await nadoCall(() => button(nadoPage, 'Next').click({ timeout: timeoutMs }));
      website = await waitSite(['username', 'username_ready', 'username_conflict']);
    }
    if (!['username', 'username_ready', 'username_conflict', 'username_checking'].includes(website.stage)) fail('NEEDS_ATTENTION');
    const username = await chooseUsername(prepared);
    await assertWallet(number, address, { connected: true });
    await localCall(() => authBox().check({ timeout: timeoutMs }));
    if (!await localCall(() => authBox().isChecked()) || await localCall(() => usernameInput().inputValue()) !== username
      || await nadoCall(() => nadoPage.locator('#displayName').inputValue()) !== username) fail('NEEDS_ATTENTION');
    await nadoCall(() => button(nadoPage, 'Save').and(nadoPage.locator(':enabled')).waitFor({ state: 'visible', timeout: timeoutMs }));
    await assertWallet(number, address, { connected: true });
    if (await nadoCall(() => nadoPage.locator('#displayName').inputValue()) !== username) fail('NEEDS_ATTENTION');
    saveAttempts.set(number, username);
    await event('save_pending', { username, saveAttempted: true }); // Worker may persist this before the click.
    await nadoCall(() => button(nadoPage, 'Save').click({ timeout: timeoutMs }));
    await event('awaiting_username_result', { username, saveAttempted: true });
    await waitSite(['complete']);
    return verifyCompleted(prepared, username, true);
  }
  return {
    prepare: number => safeOperation(() => prepareImpl(number)),
    finish: (prepared, confirmation = approval) => safeOperation(() => finishImpl(prepared, confirmation)),
    runWallet: (number, confirmation = approval) => safeOperation(async () => {
      const prepared = current?.walletNumber === number ? current : await prepareImpl(number);
      return finishImpl(prepared, confirmation);
    }),
    readTermsCandidate: () => safeOperation(readTermsCandidate),
    cleanup: async () => { signal?.removeEventListener('abort', abortCleanup); await cleanup(); },
    revokeUnusedAuthorization: () => safeOperation(revokeUnusedAuthorization),
    status: () => ({ stage, busy, walletNumber: activeNumber ?? null, preparedWalletNumber: current?.walletNumber ?? null, termsCandidate: lastCandidate }),
  };
}
