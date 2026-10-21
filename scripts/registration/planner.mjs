// Public-address planning only. This module never opens a vault or a browser.
export const DEFAULT_BOUNDS = Object.freeze({ min: 1, max: 10000 });
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const USERNAME = /^[A-Za-z0-9_.]{3,20}$/;
const CONFIG_KEYS = new Set(['bounds', 'start', 'end', 'ranges', 'direction', 'laneCount', 'laneIndex']);
const RECORD_KEYS = new Set([
  'formatVersion', 'checkedAt', 'walletNumber', 'address', 'username', 'status', 'loginComplete',
  'websiteSignedIn', 'websiteNetwork', 'approvedChainId', 'usernameAutoSigned',
  'termsAcceptedByAgentWithBatchConfirmation', 'agentTransactionsSent', 'timingsMs', 'browser',
  'serverProfileVerified', 'intendedUsername',
]);

function object(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
}
function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min}–${max} 的整数`);
  return value;
}
function exactKeys(value, allowed, message) {
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error(message);
}

export function normalizeConfig(input = {}) {
  object(input, '计划配置必须是对象');
  exactKeys(input, CONFIG_KEYS, '计划配置含未知字段');
  const bounds = input.bounds ?? DEFAULT_BOUNDS;
  object(bounds, 'bounds 必须是对象');
  exactKeys(bounds, new Set(['min', 'max']), 'bounds 含未知字段');
  const min = integer(bounds.min ?? 1, 1, 1000000, 'bounds.min');
  const max = integer(bounds.max ?? 10000, min, 1000000, 'bounds.max');
  const direction = input.direction ?? 'desc';
  if (direction !== 'desc' && direction !== 'asc') throw new Error('direction 只能是 desc 或 asc');
  const laneCount = integer(input.laneCount ?? 1, 1, 10000, 'laneCount');
  const laneIndex = integer(input.laneIndex ?? 0, 0, laneCount - 1, 'laneIndex');
  if (Object.hasOwn(input, 'ranges')) {
    if (Object.hasOwn(input, 'start') || Object.hasOwn(input, 'end')) throw new Error('ranges 不得与 start/end 同时配置');
    if (!Array.isArray(input.ranges) || !input.ranges.length || input.ranges.length > 1000000) throw new Error('ranges 必须是非空编号区间数组');
    const ranges = Array.from(input.ranges, (range, index) => {
      if (!Array.isArray(range) || range.length !== 2) throw new Error('每个 ranges 区间必须是 [start,end]');
      const start = integer(range[0], min, max, `ranges[${index}].start`);
      const end = integer(range[1], min, max, `ranges[${index}].end`);
      if ((direction === 'desc' && start < end) || (direction === 'asc' && start > end)) throw new Error('区间起止编号与方向不一致');
      return [start, end];
    });
    for (let index = 1; index < ranges.length; index++) {
      const previousEnd = ranges[index - 1][1], nextStart = ranges[index][0];
      if (direction === 'asc' ? nextStart <= previousEnd : nextStart >= previousEnd) {
        throw new Error('ranges 必须按方向排列且不得重叠');
      }
    }
    return { bounds: { min, max }, ranges, direction, laneCount, laneIndex };
  }
  const start = integer(input.start ?? (direction === 'desc' ? max : min), min, max, 'start');
  const end = integer(input.end ?? (direction === 'desc' ? min : max), min, max, 'end');
  if ((direction === 'desc' && start < end) || (direction === 'asc' && start > end)) throw new Error('起止编号与方向不一致');
  return { bounds: { min, max }, start, end, direction, laneCount, laneIndex };
}

export function validateWalletManifest(manifest) {
  if (!Array.isArray(manifest) || !manifest.length || manifest.length > 1000000) throw new Error('公开地址清单必须是非空数组，最多 1000000 条');
  const numbers = new Set();
  const addresses = new Set();
  return manifest.map(entry => {
    object(entry, '公开地址清单记录格式错误');
    exactKeys(entry, new Set(['walletNumber', 'address']), '公开地址清单只允许 walletNumber 和 address，不得包含秘密');
    const walletNumber = integer(entry.walletNumber, 1, 1000000, 'walletNumber');
    if (typeof entry.address !== 'string' || !ADDRESS.test(entry.address)) throw new Error('公开地址清单含无效 EVM 地址');
    const address = entry.address.toLowerCase();
    if (numbers.has(walletNumber) || addresses.has(address)) throw new Error('公开地址清单含重复编号或地址');
    numbers.add(walletNumber); addresses.add(address);
    return { walletNumber, address };
  });
}

export function normalizeProgressRecord(record) {
  object(record, '进度记录必须是对象');
  exactKeys(record, RECORD_KEYS, '进度含未知字段；仅接受公开状态，不接受凭据或原始请求');
  const walletNumber = integer(record.walletNumber, 1, 1000000, 'walletNumber');
  if (typeof record.address !== 'string' || !ADDRESS.test(record.address)) throw new Error('进度记录地址无效');
  if (typeof record.status !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(record.status)) throw new Error('进度状态无效');
  if (record.loginComplete !== undefined && typeof record.loginComplete !== 'boolean') throw new Error('loginComplete 必须是布尔值');
  if (record.username !== undefined && (typeof record.username !== 'string' || !USERNAME.test(record.username))) throw new Error('进度用户名无效');
  if (record.intendedUsername !== undefined && (typeof record.intendedUsername !== 'string' || !USERNAME.test(record.intendedUsername))) throw new Error('进度预期用户名无效');
  if (record.username !== undefined && record.intendedUsername !== undefined && record.username !== record.intendedUsername) throw new Error('进度实际与预期用户名冲突');
  if (record.checkedAt !== undefined && (typeof record.checkedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(record.checkedAt) || !Number.isFinite(Date.parse(record.checkedAt)))) throw new Error('进度时间无效');
  if (record.formatVersion !== undefined && record.formatVersion !== 1) throw new Error('不支持的进度格式版本');
  for (const key of ['websiteSignedIn', 'usernameAutoSigned', 'termsAcceptedByAgentWithBatchConfirmation', 'serverProfileVerified']) {
    if (record[key] !== undefined && typeof record[key] !== 'boolean') throw new Error('进度布尔字段无效');
  }
  if (record.websiteNetwork !== undefined && record.websiteNetwork !== 'Ink') throw new Error('进度网络必须为 Ink');
  if (record.approvedChainId !== undefined && record.approvedChainId !== 57073) throw new Error('进度链编号必须为 57073');
  if (record.agentTransactionsSent !== undefined && record.agentTransactionsSent !== 0) throw new Error('注册进度不能包含发送交易');
  if (record.browser !== undefined && !['iab', 'chrome', 'edge'].includes(record.browser)) throw new Error('进度浏览器无效');
  const result = { walletNumber, address: record.address.toLowerCase(), status: record.status, loginComplete: record.loginComplete ?? false };
  for (const key of [...RECORD_KEYS].filter(key => !['walletNumber', 'address', 'status', 'loginComplete', 'timingsMs'].includes(key)).sort()) {
    if (record[key] !== undefined) result[key] = record[key];
  }
  if (record.timingsMs !== undefined) {
    object(record.timingsMs, '耗时必须是对象');
    const timingsMs = {};
    for (const key of Object.keys(record.timingsMs).sort()) {
      if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key) || !Number.isFinite(record.timingsMs[key]) || record.timingsMs[key] < 0) throw new Error('进度耗时无效');
      timingsMs[key] = record.timingsMs[key];
    }
    result.timingsMs = timingsMs;
  }
  return result;
}

export function isVerified(record) {
  return record.status === 'verified_login_and_ink' && record.loginComplete === true;
}

export function mergeProgress(recordArrays, manifest) {
  const wallets = validateWalletManifest(manifest);
  const addresses = new Map(wallets.map(wallet => [wallet.walletNumber, wallet.address]));
  if (!Array.isArray(recordArrays) || recordArrays.some(records => !Array.isArray(records))) throw new Error('合并输入必须是多个进度数组');
  const merged = new Map();
  const successfulUsernames = new Map();
  for (const records of recordArrays) for (const raw of records) {
    const record = normalizeProgressRecord(raw);
    if (addresses.get(record.walletNumber) !== record.address) throw new Error(`进度编号 ${record.walletNumber} 与公开地址清单冲突`);
    const successfulUsername = isVerified(record) ? record.username ?? record.intendedUsername : undefined;
    if (successfulUsername) {
      const seen = successfulUsernames.get(record.walletNumber);
      if (seen && seen !== successfulUsername) throw new Error(`编号 ${record.walletNumber} 的已完成用户名互相冲突`);
      successfulUsernames.set(record.walletNumber, successfulUsername);
    }
    const previous = merged.get(record.walletNumber);
    if (!previous) { merged.set(record.walletNumber, record); continue; }
    if (isVerified(previous) && isVerified(record) && previous.username && record.username && previous.username !== record.username) {
      throw new Error(`编号 ${record.walletNumber} 的已完成用户名互相冲突`);
    }
    // Completion takes precedence; otherwise use a stable time/content order, independent of file order.
    const rank = value => [isVerified(value) ? 1 : 0, value.checkedAt ? Date.parse(value.checkedAt) : 0, JSON.stringify(value)];
    const a = rank(previous); const b = rank(record);
    if (b[0] > a[0] || (b[0] === a[0] && (b[1] > a[1] || (b[1] === a[1] && b[2] > a[2])))) merged.set(record.walletNumber, record);
  }
  // Keep known username evidence even when a newer completion omitted it, so a
  // later cross-device merge cannot hide conflicts by passing through that file.
  return [...merged.values()].map(record => isVerified(record) && !record.username && !record.intendedUsername && successfulUsernames.has(record.walletNumber)
    ? { ...record, intendedUsername: successfulUsernames.get(record.walletNumber) }
    : record).sort((a, b) => b.walletNumber - a.walletNumber);
}

export function createPlan(input = {}, manifest, records = []) {
  const config = normalizeConfig(input);
  const wallets = validateWalletManifest(manifest);
  const addresses = new Map(wallets.map(wallet => [wallet.walletNumber, wallet.address]));
  const done = new Set(mergeProgress([records], wallets).filter(isVerified).map(record => record.walletNumber));
  const step = config.direction === 'desc' ? -1 : 1;
  const items = [];
  let total = 0; let completed = 0; let offset = 0;
  for (const [start, end] of config.ranges ?? [[config.start, config.end]]) {
    const count = Math.abs(end - start) + 1;
    for (let rangeOffset = 0; rangeOffset < count; rangeOffset++, offset++) {
      const walletNumber = start + rangeOffset * step;
      if (!addresses.has(walletNumber)) throw new Error(`公开地址清单缺少计划范围内的编号 ${walletNumber}`);
      // Count across ranges and shard before skipping completed items. Neither
      // gaps nor verified progress may reshuffle a wallet's lane ownership.
      if (offset % config.laneCount !== config.laneIndex) continue;
      total++;
      if (done.has(walletNumber)) { completed++; continue; }
      items.push({ walletNumber, address: addresses.get(walletNumber) });
    }
  }
  return { config, total, completed, remaining: items.length, items };
}

export function getStatus(config, manifest, records = []) {
  const { items, ...status } = createPlan(config, manifest, records);
  return status;
}
