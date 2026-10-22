/** Hold a shared lock throughout manual submission, not just a racy availability check. */
export async function withManualTradingLock<T>(chainId: number, task: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) return task();
  return navigator.locks.request(`nado-trade-test:${chainId}`, { mode: "shared", ifAvailable: true }, async lock => {
    if (!lock) throw new Error("自动交易测试正在执行。请先在测试页面停止开新仓并完成收尾，再手动操作");
    return task();
  });
}
