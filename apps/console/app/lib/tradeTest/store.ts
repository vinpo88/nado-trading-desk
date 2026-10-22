import type { TradeTestRun, TradeTestStore } from "./types";

const clone = <T>(value: T): T => structuredClone(value);
function fundingDefinition(run: TradeTestRun): string | undefined {
  const f = run.funding;
  return f && JSON.stringify({ version: f.version, treasury: f.treasury, limits: f.limits,
    rows: f.rows.map(r => ({ wallet: r.wallet, requiredX18: r.requiredX18, previewBalanceX18: r.previewBalanceX18, targetX18: r.targetX18, depositAddress: r.depositAddress, maxDepositUnits: r.maxDepositUnits })) });
}
function assertFundingJournal(before: TradeTestRun, after: TradeTestRun): void {
  if (fundingDefinition(before) !== fundingDefinition(after)) throw new Error("已保存充值计划的资金库、目标地址、金额上限不可修改");
  for (const [index, old] of (before.funding?.rows ?? []).entries()) {
    const row = after.funding!.rows[index]!;
    for (const key of ["baselineX18", "baselineSubmissionIndex", "creditedSubmissionIndex", "creditedEventAt", "amountUnits", "createdAt", "transaction", "receipt"] as const) {
      if (old[key] !== undefined && JSON.stringify(old[key]) !== JSON.stringify(row[key])) throw new Error("原充值意图或交易不可覆盖，必须核对原记录");
    }
    if (old.authorization) {
      const { signature: oldSignature, ...oldIntent } = old.authorization;
      const { signature: newSignature, ...newIntent } = row.authorization ?? {};
      if (JSON.stringify(oldIntent) !== JSON.stringify(newIntent) || (oldSignature !== undefined && oldSignature !== newSignature)) throw new Error("原充值授权不可替换，禁止生成重复付款");
    }
  }
}
function assertNew(existing: TradeTestRun[], run: TradeTestRun) {
  if (existing.some(r => r.id === run.id || (r.batchKey === run.batchKey && r.mode === run.mode && r.chainId === run.chainId))) throw new Error("批次已存在，请打开原记录，不能重复创建");
  if (existing.some(r => r.mode === run.mode && r.chainId === run.chainId && r.status !== "completed")) throw new Error("该网络还有未结束的测试，请先恢复或处理原批次");
}
function changed(current: TradeTestRun, change: (run: TradeTestRun) => void): TradeTestRun {
  const result = clone(current); change(result);
  if (result.id !== current.id || result.batchKey !== current.batchKey || result.chainId !== current.chainId || result.mode !== current.mode || JSON.stringify(result.settings) !== JSON.stringify(current.settings) || JSON.stringify(result.wallets.map(w => w.wallet)) !== JSON.stringify(current.wallets.map(w => w.wallet))) throw new Error("已保存批次的身份、网络和参数不可修改");
  assertFundingJournal(current, result);
  result.revision = current.revision + 1; result.updatedAt = Date.now(); return result;
}

export class MemoryTradeTestStore implements TradeTestStore {
  private values = new Map<string, TradeTestRun>();
  private locks = new Set<number>();
  async create(run: TradeTestRun) { assertNew([...this.values.values()], run); this.values.set(run.id, clone(run)); return clone(run); }
  async get(id: string) { const run = this.values.get(id); return run ? clone(run) : undefined; }
  async list() { return [...this.values.values()].map(clone); }
  async update(id: string, change: (run: TradeTestRun) => void) { const current = this.values.get(id); if (!current) throw new Error("批次不存在"); const result = changed(current, change); this.values.set(id, result); return clone(result); }
  async withLock<T>(chainId: number, task: () => Promise<T>) {
    if (this.locks.has(chainId)) throw new Error("已有测试正在执行");
    this.locks.add(chainId); try { return await task(); } finally { this.locks.delete(chainId); }
  }
}

/** Transaction completion, not request success, is the write-ahead durability boundary. */
export class IndexedDbTradeTestStore implements TradeTestStore {
  private database?: Promise<IDBDatabase>;
  constructor(private readonly name = "nado-trade-test-v1") {}
  private db() {
    this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("runs", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("本地记录打不开，禁止自动交易"));
    }); return this.database;
  }
  async create(run: TradeTestRun): Promise<TradeTestRun> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("runs", "readwrite", { durability: "strict" });
      const store = tx.objectStore("runs"), read = store.getAll(); let cause: unknown;
      read.onsuccess = () => { try { assertNew(read.result as TradeTestRun[], run); store.add(clone(run)); } catch (error) { cause = error; tx.abort(); } };
      tx.oncomplete = () => resolve(clone(run));
      tx.onabort = () => reject(cause ?? tx.error ?? new Error("记录保存失败，未开始交易"));
      tx.onerror = () => {};
    });
  }
  async get(id: string): Promise<TradeTestRun | undefined> {
    const db = await this.db(); return new Promise((resolve, reject) => { const req = db.transaction("runs").objectStore("runs").get(id); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  }
  async list(): Promise<TradeTestRun[]> {
    const db = await this.db(); return new Promise((resolve, reject) => { const req = db.transaction("runs").objectStore("runs").getAll(); req.onsuccess = () => resolve(req.result as TradeTestRun[]); req.onerror = () => reject(req.error); });
  }
  async update(id: string, change: (run: TradeTestRun) => void): Promise<TradeTestRun> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("runs", "readwrite", { durability: "strict" });
      const store = tx.objectStore("runs"), req = store.get(id); let result: TradeTestRun; let cause: unknown;
      req.onsuccess = () => { try { if (!req.result) throw new Error("批次不存在"); result = changed(req.result as TradeTestRun, change); store.put(result); } catch (error) { cause = error; tx.abort(); } };
      tx.oncomplete = () => resolve(clone(result));
      tx.onabort = () => reject(cause ?? tx.error ?? new Error("交易日志保存失败，停止发送"));
      tx.onerror = () => {};
    });
  }
  async withLock<T>(chainId: number, task: () => Promise<T>): Promise<T> {
    if (!navigator.locks) throw new Error("浏览器不支持跨窗口执行锁，禁止自动交易");
    return navigator.locks.request(`nado-trade-test:${chainId}`, { mode: "exclusive", ifAvailable: true }, async lock => {
      if (!lock) throw new Error("另一个窗口正在执行测试，请回到原窗口");
      return task();
    });
  }
}
