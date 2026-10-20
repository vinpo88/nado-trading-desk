/** Display-only translations. Never use these values in protocol requests or IDs. */
const LABELS: Record<string, string> = {
  Market: "交易市场", Side: "方向", Type: "订单类型", Size: "数量", Price: "价格",
  Buy: "买入", Sell: "卖出", Limit: "限价", "Market order": "市价",
  buy: "买入", sell: "卖出", long: "多仓", short: "空仓", flat: "无持仓",
  limit: "限价", market: "市价", perp: "永续合约", spot: "现货",
  open: "挂单中", pending: "等待中", running: "执行中", done: "已完成", failed: "失败",
  filled: "已成交", partial: "部分成交", partially_filled: "部分成交", cancelled: "已撤销", canceled: "已撤销",
  rejected: "已拒绝", expired: "已过期", success: "成功", reverted: "交易已回退",
  maker: "挂单方", taker: "吃单方", unknown: "未知", unfunded: "未入金",
  funded: "已入金", ready: "已就绪", active: "在线", idle: "空闲", error: "异常",
  margin: "保证金", wallet: "钱包", native: "原生币", collateral: "抵押品", available: "可用",
  fill: "成交", fills: "成交", position_change: "仓位变动", order_update: "订单更新",
  placed: "已挂单", matched: "已撮合", liquidation: "清算", settle_pnl: "结算盈亏",
  deposit: "充值", withdraw: "提现", refuel: "补充手续费", gas: "手续费",
  mint: "领取测试币", skip: "跳过", skipped: "已跳过", check: "检查",
  LIVE: "在线钱包", LOCAL: "本地钱包", mainnet: "主网", testnet: "测试网",
  locked: "已锁定", unlocked: "已解锁", once: "单次", interval: "固定间隔", cron: "定时表达式",
  "base units": "基础币数量", "quote units": "报价币数量", seconds: "秒", minutes: "分钟",
};

export function zhLabel(value: string | undefined | null, fallback?: string): string {
  return value == null ? fallback ?? "未知" : LABELS[value] ?? fallback ?? value;
}

/** Chinese user-facing summaries; do not echo arbitrary SDK/relay payloads. */
export function zhError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/[\u3400-\u9fff]/.test(message)) return message;
  if (/abort|cancelled by|canceled by/i.test(message)) return "操作已停止。";
  if (/password|decrypt|authentication/i.test(message)) return "密码或身份验证失败，请检查后重试。";
  if (/locked|unlock|no.*signer/i.test(message)) return "请先解锁保险库。";
  if (/chain mismatch|unsupported chain|network.*switch/i.test(message)) return "网络配置不一致，请刷新页面并重新选择网络。";
  if (/cap|ceiling|exceed|too large|max.*notional/i.test(message)) return "操作金额超过当前网络的限额，请降低金额后重试。";
  if (/insufficient|low on gas|not enough|margin|health/i.test(message)) return "余额、手续费或保证金不足，请检查账户资金。";
  if (/429|rate.?limit|too many/i.test(message)) return "请求过于频繁，请稍后重试。";
  if (/timeout|timed out/i.test(message)) return "请求超时，请稍后查询状态，避免重复提交。";
  if (/revert|rejected|reject/i.test(message)) return "交易或请求被拒绝，请检查金额、账户状态和市场条件。";
  if (/network|fetch|connect|relay|gateway/i.test(message)) return "网络连接失败，请检查连接后重试。";
  if (/cron|schedule|expression/i.test(message)) return "定时设置无效，请检查表达式或执行间隔。";
  if (/disabled|testnet.only/i.test(message)) return "当前模式或网络不支持此操作。";
  if (/invalid|must be|positive|rounds to zero|parse/i.test(message)) return "输入格式或数值无效，请检查后重试。";
  return "操作未完成，请检查输入、网络和账户状态后重试。";
}
