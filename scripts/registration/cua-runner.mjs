// Import inside a documented cua_repl session. This file never opens a vault,
// reads storage, calls a signing API, or starts a batch on import.
import { createPlan, normalizeProgressRecord, validateWalletManifest } from './planner.mjs';

export const NADO_ORIGIN = 'https://app.nado.xyz';
const USERNAME = /^[A-Za-z0-9_.]{3,20}$/;
const PENDING = /有请求等待你确认|正在处理已确认的请求|正在核对交易与手续费/;
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let clipboardQueue = Promise.resolve();

// Shared by runners imported from this module instance. Separate processes or
// cache-busted module instances MUST NOT use the same system clipboard in parallel.
export async function withRegistrationClipboardLock(operation) {
  const previous = clipboardQueue;
  let release;
  clipboardQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try { return await operation(); }
  finally { release(); }
}

export function parseTermsAX(state) {
  const lines = state.split(/\r?\n/);
  const containers = lines.flatMap((line, index) => /^\s*\d+ container Terms of Use(?:,.*)?$/.test(line) ? [index] : []);
  if (containers.length !== 1) throw new Error('条款容器不明确，已停止');
  const subtree = start => {
    const depth = lines[start].match(/^\s*/)[0].length;
    let end = start + 1;
    while (end < lines.length && (!lines[end].trim() || lines[end].match(/^\s*/)[0].length > depth)) end++;
    return { start: start + 1, end };
  };
  const terms = subtree(containers[0]);
  const lists = [];
  for (let i = terms.start; i < terms.end; i++) if (/^\s*\d+ content list(?:,.*)?$/.test(lines[i])) lists.push(i);
  if (lists.length !== 1) throw new Error('条款声明列表有变化，已停止');
  const list = subtree(lists[0]);
  const declarations = lines.slice(list.start, list.end).flatMap(line => {
    const text = line.match(/^\s*\d+ text (.*)$/);
    return text ? [text[1]] : [];
  });
  if (declarations.length !== 6) throw new Error('条款声明数量有变化，已停止');
  return declarations;
}

function legalUrl(value, path) {
  if (typeof value !== 'string') throw new Error('条款确认必须包含已核对的官方链接');
  let url;
  try { url = new URL(value); } catch { throw new Error('条款链接格式错误'); }
  if (url.protocol !== 'https:' || !['nado.xyz', 'www.nado.xyz'].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || url.pathname !== path) throw new Error('条款链接不是预期官方链接');
  return url.href;
}

export function validateTermsConfirmation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.confirmed !== true
    || typeof value.context !== 'string' || !value.context.trim() || value.context.length > 1000
    || !Array.isArray(value.declarations) || value.declarations.length !== 6
    || value.declarations.some(text => typeof text !== 'string' || !text.trim() || text.length > 5000)
    || new Set(value.declarations).size !== 6) throw new Error('必须由调用者提供本次明确确认的六项条款全文及确认上下文');
  return Object.freeze({
    confirmed: true, context: value.context.trim(),
    declarations: Object.freeze([...value.declarations]),
    termsUrl: legalUrl(value.termsUrl, '/legal-docs/terms-of-use'),
    privacyUrl: legalUrl(value.privacyUrl, '/legal-docs/privacy-policy'),
  });
}

export function assertTermsMatch(observed, confirmation) {
  const approved = validateTermsConfirmation(confirmation);
  if (JSON.stringify(observed.declarations) !== JSON.stringify(approved.declarations)
    || !observed.links.includes(approved.termsUrl) || !observed.links.includes(approved.privacyUrl)) throw new Error('当前条款与本次明确确认的内容不一致，已停止');
  return approved;
}

export function validatePairingUri(value, now = Date.now()) {
  if (typeof value !== 'string' || !/^wc:[a-fA-F0-9]{64}@2\?/.test(value)) throw new Error('未取得有效的新连接码');
  const parameters = new URLSearchParams(value.split('?')[1]);
  const expiry = Number(parameters.get('expiryTimestamp')) * 1000;
  if (parameters.getAll('expiryTimestamp').length !== 1 || !Number.isFinite(expiry) || expiry <= now
    || !/^[a-fA-F0-9]{64}$/.test(parameters.get('symKey') ?? '')) throw new Error('连接码已失效或格式不完整');
}

function oneIndex(state, name) {
  const matches = [...state.matchAll(new RegExp('^\\s*(\\d+) button '+escapeRegExp(name)+'$', 'gm'))];
  if (matches.length > 1) throw new Error('页面按钮不唯一，已停止');
  return matches[0]?.[1];
}

/**
 * Each browser profile must be independently restored/unlocked by its owner.
 * Chrome/Edge DOM adaptation is provided but not represented as live-tested.
 * The first external-browser wallet is a mandatory smoke test for THIS runner.
 *
 * termsConfirmation may be supplied here, or to finish(prepared, confirmation).
 * No default terms approval or personal authorization is embedded.
 */
export function createNadoBatchRunner({
  localTab, nadoTab, browser = 'iab', walletManifest, usernameForWallet,
  termsConfirmation, smokeTestWalletNumber, appendProgress, fs, progressPath,
  write = () => {}, signal,
}) {
  if (!['iab', 'chrome', 'edge'].includes(browser)) throw new Error('仅支持已知 IAB 和待冒烟验证的 Chrome/Edge DOM 路径');
  if (!localTab?.getAXState || !nadoTab?.getAXState || !localTab.playwright || !nadoTab.playwright) throw new Error('缺少 documented CUA 标签页能力；未实测浏览器不能继续');
  if (typeof usernameForWallet !== 'function' || typeof write !== 'function') throw new Error('必须显式提供用户名规则和有效输出回调');
  if (appendProgress !== undefined && typeof appendProgress !== 'function') throw new Error('appendProgress 必须是函数');
  if (!appendProgress && (!fs?.appendFile || typeof progressPath !== 'string' || !progressPath)) throw new Error('请提供 appendProgress 或 fs 与 progressPath；进度不能静默丢失');
  const manifest = validateWalletManifest(walletManifest);
  const addresses = new Map(manifest.map(wallet => [wallet.walletNumber, wallet.address]));
  if (browser !== 'iab' && !addresses.has(smokeTestWalletNumber)) throw new Error('Chrome/Edge 尚未实测，必须指定本机首个 smokeTestWalletNumber');
  const initialConfirmation = termsConfirmation === undefined ? undefined : validateTermsConfirmation(termsConfirmation);
  const persist = appendProgress ?? (record => fs.appendFile(progressPath, JSON.stringify(record) + '\n'));
  let smokeVerified = browser === 'iab';
  let busy = false;
  let current = null;
  const check = () => { if (signal?.aborted) throw new Error('调用者已中止，未继续操作'); };
  const state = async tab => { check(); const result = await tab.getAXState({ emit: false, disableDiffing: true }); check(); return result; };
  const act = async operation => { check(); const result = await operation(); check(); return result; };
  const button = (tab, name) => tab.playwright.getByRole('button', { name, exact: true });
  const wait = (tab, name, timeoutMs = 10000, visible = true) => act(() => button(tab, name).waitFor({ state: visible ? 'visible' : 'hidden', timeoutMs }));
  const numericAX = snapshot => /^\s*\d+ (?:container|button|heading|text)\b/m.test(snapshot);
  async function click(tab, name, snapshot) {
    const index = numericAX(snapshot) ? oneIndex(snapshot, name) : undefined;
    if (index && typeof tab.click === 'function') await act(() => tab.click(Number(index)));
    else await act(() => button(tab, name).click()); // Strict locator: ambiguous/missing DOM targets fail.
  }
  async function inputValue(tab, locator) {
    return act(() => locator.evaluate(element => {
      if (!element.getClientRects().length) throw new Error('输入框不可见');
      return element.value;
    }));
  }
  async function selectedAddress() {
    const text = await act(() => localTab.playwright.getByTestId('connect-wallet-address').evaluate(element => {
      if (!element.getClientRects().length) throw new Error('钱包地址不可见');
      return element.textContent?.trim();
    }));
    if (typeof text !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(text)) throw new Error('本地完整钱包地址无法核实');
    return text.toLowerCase();
  }
  async function assertLocalWallet(walletNumber, address) {
    const number = await inputValue(localTab, localTab.playwright.getByLabel('钱包编号（从 1 开始）', { exact: true }));
    if (String(number) !== String(walletNumber) || await selectedAddress() !== address) throw new Error('本地钱包编号或完整地址与公开清单不一致');
  }
  async function readProposal() {
    return act(() => button(localTab, '同意连接此钱包').evaluate(approve => {
      if (!approve.getClientRects().length) throw new Error('连接确认按钮不可见');
      for (let scope = approve.parentElement; scope && scope.tagName !== 'BODY'; scope = scope.parentElement) {
        const heading = [...scope.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(element => element.getClientRects().length && element.textContent?.trim() === '确认连接请求');
        if (!heading.length) continue;
        if (heading.length !== 1) throw new Error('连接确认范围不唯一');
        const paragraphs = [...scope.querySelectorAll('p')].filter(element => element.getClientRects().length).map(element => element.textContent?.trim() ?? '');
        const origins = paragraphs.filter(text => text.startsWith('已核验的网站来源：'));
        const wallets = paragraphs.filter(text => text.startsWith('钱包：'));
        const networks = paragraphs.filter(text => text.startsWith('网络：'));
        if (origins.length !== 1 || wallets.length !== 1 || networks.length !== 1) throw new Error('连接确认字段不明确');
        return { origin: origins[0].slice('已核验的网站来源：'.length).trim(), address: wallets[0].slice('钱包：'.length).trim(), network: networks[0] };
      }
      throw new Error('无法找到连接确认范围');
    }));
  }
  async function collapseGetStarted(snapshot) {
    const expanded = [...snapshot.matchAll(/^\s*(\d+) pop up button \(expanded\) Get started(?:,.*)?$/gm)];
    if (expanded.length > 1) throw new Error('官网浮层状态不明确');
    let open = expanded.length === 1;
    if (!numericAX(snapshot)) {
      const count = await act(() => nadoTab.playwright.locator('body').evaluate(body => Array.from(body.querySelectorAll('button,[role="button"]'))
        .filter(element => element.getClientRects().length && element.getAttribute('aria-expanded') === 'true' && element.textContent?.trim() === 'Get started').length));
      if (count > 1) throw new Error('官网浮层状态不明确');
      open = count === 1;
    }
    if (open) {
      if (expanded.length && typeof nadoTab.click === 'function') await act(() => nadoTab.click(Number(expanded[0][1])));
      else await act(() => button(nadoTab, 'Get started').click());
      snapshot = await state(nadoTab);
      if (/pop up button \(expanded\) Get started/.test(snapshot)) throw new Error('官网浮层尚未收起');
      const remaining = await act(() => nadoTab.playwright.locator('body').evaluate(body => Array.from(body.querySelectorAll('button,[role="button"]'))
        .filter(element => element.getClientRects().length && element.getAttribute('aria-expanded') === 'true' && element.textContent?.trim() === 'Get started').length));
      if (remaining) throw new Error('官网浮层尚未收起');
    }
    return snapshot;
  }
  async function readTerms(snapshot) {
    // Read only visible DOM underneath the observed Agree button. No application
    // internals, storage, network calls, or hidden page state are inspected.
    const observed = await act(() => button(nadoTab, 'Agree to Terms').evaluate(agree => {
      const visible = element => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
      if (!visible(agree)) throw new Error('条款按钮不可见');
      for (let scope = agree.parentElement; scope && scope.tagName !== 'BODY'; scope = scope.parentElement) {
        const headings = [...scope.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].filter(element => visible(element) && element.textContent?.trim() === 'Terms of Use');
        if (!headings.length) continue;
        if (headings.length !== 1) throw new Error('条款范围不唯一');
        const lists = [...scope.querySelectorAll('ul,ol,[role="list"]')].filter(visible);
        if (lists.length !== 1) throw new Error('条款列表数量有变化');
        const list = lists[0];
        if ([...list.childNodes].some(node => node.nodeType === 3 && node.textContent?.trim())) throw new Error('条款列表含额外文本');
        const items = [...list.children].filter(visible);
        if (items.length !== 6 || items.some(item => item.tagName !== 'LI' && item.getAttribute('role') !== 'listitem')) throw new Error('条款列表结构有变化');
        return {
          declarations: items.map(item => item.innerText.trim()),
          links: [...scope.querySelectorAll('a[href]')].filter(visible).map(link => link.href),
        };
      }
      throw new Error('无法确认 Terms 对话框范围；此浏览器路径尚未验证');
    }));
    if (!observed || !Array.isArray(observed.declarations) || !Array.isArray(observed.links)) throw new Error('无法核对当前条款');
    if (numericAX(snapshot) && JSON.stringify(parseTermsAX(snapshot)) !== JSON.stringify(observed.declarations)) throw new Error('可见条款与辅助功能文本不一致');
    return observed;
  }
  async function openWalletConnect() {
    await act(() => button(nadoTab, 'Sign In').first().waitFor({ state: 'visible', timeoutMs: 15000 }));
    await state(nadoTab);
    await act(() => button(nadoTab, 'Sign In').first().click());
    await state(nadoTab);
    try { await wait(nadoTab, 'WalletConnect'); }
    catch (error) {
      const message = String(error?.message || '');
      const timedOut = error?.name === 'TimeoutError' || /\b(?:locator\.)?waitFor\b[\s\S]*\b(?:timeout|timed out)\b/i.test(message);
      if (!timedOut || /permission|denied|not permitted|unauthori[sz]ed|abort|cancel|interrup|security|safety|policy|权限|拒绝|取消|中止|安全|审核/i.test(message)) throw error;
      const stalled = await state(nadoTab);
      // Recovery is limited to the observed IAB legacy popup, exactly once.
      // Unknown DOM layouts or other errors never cause speculative reloads.
      if (!/^\s*\d+ container Description: log in or sign up, ID: privy-dialog$/m.test(stalled)
        || !/^\s*\d+ button More options$/m.test(stalled) || /^\s*\d+ button WalletConnect$/m.test(stalled)) throw error;
      await act(() => nadoTab.reload());
      await act(() => button(nadoTab, 'Sign In').first().waitFor({ state: 'visible', timeoutMs: 15000 }));
      await state(nadoTab);
      await act(() => button(nadoTab, 'Sign In').first().click());
      await state(nadoTab);
      await wait(nadoTab, 'WalletConnect');
    }
    await click(nadoTab, 'WalletConnect', await state(nadoTab));
  }
  async function prepare(walletNumber) {
    check();
    if (busy || current) throw new Error('当前钱包尚未结束；每个浏览器 runner 只能串行处理');
    if (!addresses.has(walletNumber)) throw new Error('钱包编号不在公开地址清单内');
    if (!smokeVerified && walletNumber !== smokeTestWalletNumber) throw new Error('此外部浏览器尚未通过首个钱包冒烟验证');
    const address = addresses.get(walletNumber);
    const username = usernameForWallet(walletNumber, address);
    if (typeof username !== 'string' || !USERNAME.test(username)) throw new Error('用户名规则必须产生 3–20 位英文、数字、下划线或句点');
    busy = true;
    const startedAt = Date.now();
    const timingsMs = {};
    try {
      let before = await state(nadoTab);
      if (/Terms of Use|Set Username|We're Introducing Usernames/.test(before)) throw new Error('官网尚未完成上一个钱包');
      if (before.includes('Ink 0x')) {
        await act(() => nadoTab.playwright.getByRole('button', { name: /^Ink 0x/ }).click());
        await state(nadoTab);
        await act(() => nadoTab.playwright.getByRole('menu').getByText('Sign Out', { exact: true }).click());
        await state(nadoTab);
      } else if (!before.includes('Sign In')) throw new Error('无法核实官网登录状态');
      const localBefore = await state(localTab);
      if (PENDING.test(localBefore)) throw new Error('本地尚有请求待处理，请先人工核对');
      if (!localBefore.includes('尚未连接') && !localBefore.includes('已断开连接')) {
        await act(() => button(localTab, '断开连接').click());
        await state(localTab);
      }
      await act(() => localTab.playwright.getByLabel('钱包编号（从 1 开始）', { exact: true }).fill(String(walletNumber)));
      await state(localTab);
      await assertLocalWallet(walletNumber, address);
      await act(() => localTab.playwright.getByLabel('本次官网用户名', { exact: true }).fill(username));
      await state(localTab);
      if (await inputValue(localTab, localTab.playwright.getByLabel('本次官网用户名', { exact: true })) !== username) throw new Error('本地用户名完整值不匹配');
      await act(() => localTab.playwright.getByRole('checkbox', { name: '自动确认一次此用户名签名', exact: true }).check());
      await state(localTab);
      timingsMs.logoutAndSelect = Date.now() - startedAt;
      await openWalletConnect();
      await wait(nadoTab, 'Copy link', 15000);
      await state(nadoTab);
      if (!nadoTab.clipboard?.readText || !nadoTab.clipboard?.writeText) throw new Error('浏览器未提供 documented clipboard；此路径未通过验证');
      await withRegistrationClipboardLock(async () => {
        check();
        let pairing = '';
        try {
          await act(() => nadoTab.clipboard.writeText(''));
          // Refresh after taking the lock: another runner may have held it while
          // this browser's dialog changed. Never click a stale AX index.
          await click(nadoTab, 'Copy link', await state(nadoTab));
          await state(nadoTab);
          pairing = await act(() => nadoTab.clipboard.readText());
          validatePairingUri(pairing);
          await assertLocalWallet(walletNumber, address);
          await act(() => localTab.playwright.getByLabel('WalletConnect 连接码', { exact: true }).fill(pairing));
        } catch {
          // Locator errors can embed the fill argument, including the pairing
          // secret. Do not retain the original message, stack, or cause.
          throw new Error('临时连接码传递未完成，已停止；请在浏览器核对权限与连接状态');
        } finally {
          pairing = '';
          try { await nadoTab.clipboard.writeText(''); }
          catch { throw new Error('临时连接码清理未完成，已停止；请在本机清空剪贴板后检查'); }
        }
      });
      await act(() => button(localTab, '接收官网连接请求').click());
      await wait(localTab, '同意连接此钱包', 20000);
      const proposal = await state(localTab);
      const proposalFields = await readProposal();
      if (proposalFields?.origin !== NADO_ORIGIN || proposalFields?.address?.toLowerCase() !== address || proposalFields?.network !== '网络：Ink 主网（57073）') throw new Error('连接来源、完整地址或 Ink 网络无法核实');
      await assertLocalWallet(walletNumber, address);
      await click(localTab, '同意连接此钱包', proposal);
      await state(localTab);
      timingsMs.connect = Date.now() - startedAt - timingsMs.logoutAndSelect;
      await wait(nadoTab, 'Agree to Terms', 20000);
      const termsState = await collapseGetStarted(await state(nadoTab));
      const terms = await readTerms(termsState);
      timingsMs.termsReady = Date.now() - startedAt - timingsMs.logoutAndSelect - timingsMs.connect;
      timingsMs.prepare = Date.now() - startedAt;
      current = Object.freeze({ walletNumber, address, username, terms: Object.freeze({ declarations: Object.freeze([...terms.declarations]), links: Object.freeze([...terms.links]) }), timingsMs: Object.freeze(timingsMs) });
      write({ walletNumber, address, username, termsVisible: true, browser, smokeVerified, timingsMs });
      return current;
    } finally { busy = false; }
  }
  async function finish(prepared, explicitConfirmation = initialConfirmation) {
    check();
    if (busy || !current || prepared !== current) throw new Error('只能完成本 runner 当前准备且尚未消费的钱包');
    const approval = assertTermsMatch(prepared.terms, explicitConfirmation);
    busy = true;
    current = null; // One attempt only: never replay a partially completed consent/save operation.
    const startedAt = Date.now();
    const timingsMs = { ...prepared.timingsMs };
    try {
      await assertLocalWallet(prepared.walletNumber, prepared.address);
      const termsState = await collapseGetStarted(await state(nadoTab));
      assertTermsMatch(await readTerms(termsState), approval);
      await click(nadoTab, 'Agree to Terms', termsState);
      await state(nadoTab);
      await wait(nadoTab, 'Next');
      const introduction = await state(nadoTab);
      if (!introduction.includes("We're Introducing Usernames")) throw new Error('用户名引导页面有变化');
      await click(nadoTab, 'Next', introduction);
      await state(nadoTab);
      const displayName = nadoTab.playwright.locator('#displayName');
      await act(() => displayName.fill(prepared.username));
      await state(nadoTab);
      if (await inputValue(nadoTab, displayName) !== prepared.username) {
        await act(() => displayName.fill(prepared.username));
        await state(nadoTab);
        if (await inputValue(nadoTab, displayName) !== prepared.username) throw new Error('官网用户名完整值不匹配，已停止保存');
      }
      timingsMs.termsAndUsername = Date.now() - startedAt;
      await act(() => button(nadoTab, 'Save').and(nadoTab.playwright.locator(':enabled')).waitFor({ state: 'visible', timeoutMs: 10000 }));
      const saveState = await state(nadoTab);
      await assertLocalWallet(prepared.walletNumber, prepared.address);
      if (await inputValue(localTab, localTab.playwright.getByLabel('本次官网用户名', { exact: true })) !== prepared.username
        || await inputValue(nadoTab, displayName) !== prepared.username) throw new Error('保存前用户名或本地授权目标发生变化');
      await click(nadoTab, 'Save', saveState);
      await state(nadoTab);
      const short = prepared.address.slice(0, 6) + '…' + prepared.address.slice(-4);
      const accountLabel = new RegExp('^Ink 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4} '+escapeRegExp(prepared.username)+'$');
      await act(() => nadoTab.playwright.getByRole('button', { name: accountLabel }).waitFor({ state: 'visible', timeoutMs: 15000 }));
      let result = await state(nadoTab);
      timingsMs.usernameSaved = Date.now() - startedAt - timingsMs.termsAndUsername;
      if (result.includes('Switch to Ink')) {
        await click(nadoTab, 'Switch to Ink', result);
        await state(nadoTab);
        await wait(nadoTab, 'Switch to Ink', 10000, false);
      }
      result = await state(nadoTab);
      const local = await state(localTab);
      await assertLocalWallet(prepared.walletNumber, prepared.address);
      const visibleAccount = await act(() => nadoTab.playwright.getByRole('button', { name: accountLabel }).evaluate(element => {
        if (!element.getClientRects().length) throw new Error('官网账户不可见');
        // The chain is the visible image's accessible alt text, not innerText.
        const images = [...element.querySelectorAll('img[alt]')].filter(image => image.getClientRects().length
          && getComputedStyle(image).visibility !== 'hidden' && getComputedStyle(image).display !== 'none');
        return { chain: images.length === 1 ? images[0].getAttribute('alt') : null, text: element.innerText.trim().replace(/\s+/g, ' ') };
      }));
      const accountParts = /^(0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}) ([A-Za-z0-9_.]{3,20})$/.exec(visibleAccount?.text);
      if (visibleAccount?.chain !== 'Ink' || !accountParts || accountParts[1].toLowerCase() !== short || accountParts[2] !== prepared.username || result.includes('Switch to Ink')) throw new Error('官网地址、用户名或 Ink 网络未核实');
      if (!local.includes('钱包已连接，等待官网请求') || PENDING.test(local)) throw new Error('本地尚有请求待处理，不能记录完成');
      const outcomes = await act(() => localTab.playwright.locator('body').evaluate(body => [...body.querySelectorAll('p')]
        .filter(element => element.getClientRects().length).map(element => element.textContent?.trim() ?? '')
        .filter(text => text.startsWith('已按本次授权签署用户名：'))));
      if (outcomes.length !== 1 || outcomes[0] !== '已按本次授权签署用户名：'+prepared.username+'，请在官网核对保存结果。') throw new Error('本地精确用户名签名结果未核实');
      timingsMs.networkVerified = Date.now() - startedAt - timingsMs.termsAndUsername - timingsMs.usernameSaved;
      timingsMs.finish = Date.now() - startedAt;
      timingsMs.total = timingsMs.prepare + timingsMs.finish;
      const record = normalizeProgressRecord({
        formatVersion: 1, checkedAt: new Date().toISOString(), walletNumber: prepared.walletNumber,
        address: prepared.address, username: prepared.username, status: 'verified_login_and_ink', loginComplete: true,
        websiteSignedIn: true, websiteNetwork: 'Ink', approvedChainId: 57073, usernameAutoSigned: true,
        termsAcceptedByAgentWithBatchConfirmation: true, agentTransactionsSent: 0, browser, timingsMs,
      });
      check(); await persist(record); check();
      smokeVerified = true;
      write(record);
      return record;
    } finally { busy = false; }
  }
  return { prepare, finish, status: () => ({ browser, smokeVerified, smokeTestWalletNumber, busy, preparedWalletNumber: current?.walletNumber ?? null }) };
}

/** One wallet per call, in the fixed plan order; failures never advance the queue. */
export function createPlannedNadoRunner({ config = {}, records = [], ...options }) {
  const allowedConfig = new Set(['bounds', 'start', 'end', 'direction', 'laneCount', 'laneIndex', 'walletsPath', 'progressPaths', 'progressPath', 'usernamePrefix', 'browser']);
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(config))
    || Object.keys(config).some(key => !allowedConfig.has(key))) throw new Error('计划配置含未知字段或不是普通对象，已停止');
  const planConfig = {};
  for (const key of ['bounds', 'start', 'end', 'direction', 'laneCount', 'laneIndex']) if (config[key] !== undefined) planConfig[key] = config[key];
  const plan = createPlan(planConfig, options.walletManifest, records);
  const browser = options.browser ?? config.browser ?? 'iab';
  if (browser !== 'iab' && plan.items.length && options.smokeTestWalletNumber !== plan.items[0].walletNumber) throw new Error('外部浏览器的冒烟编号必须是当前分片计划的第一个未完成钱包');
  const prefix = config.usernamePrefix ?? 'ybtl';
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9_.]{1,14}$/.test(prefix)) throw new Error('用户名固定前缀无效');
  const runner = createNadoBatchRunner({
    ...options, browser, progressPath: options.progressPath ?? config.progressPath,
    usernameForWallet: options.usernameForWallet ?? (number => prefix + number),
  });
  let offset = 0;
  let pending = null;
  let running = false;
  return {
    async prepareNext() {
      if (running || pending) throw new Error('当前计划钱包尚未完成');
      const item = plan.items[offset];
      if (!item) return null;
      running = true;
      try { pending = await runner.prepare(item.walletNumber); return pending; }
      finally { running = false; }
    },
    async finish(prepared, confirmation) {
      if (running || !pending || prepared !== pending) throw new Error('只能完成当前计划已准备的钱包');
      running = true;
      try {
        const record = await runner.finish(prepared, confirmation);
        offset++;
        pending = null;
        return record;
      } catch (error) {
        if (runner.status().preparedWalletNumber === null) pending = null;
        throw error;
      } finally { running = false; }
    },
    status() {
      return {
        ...runner.status(), config: plan.config, total: plan.total,
        completed: plan.completed + offset, remaining: plan.remaining - offset,
        nextWalletNumber: plan.items[offset]?.walletNumber ?? null,
      };
    },
  };
}
