import type { FundsRun, FundsStore } from "./types";

const clone = <T>(value: T): T => structuredClone(value);

function assertNewRun(existing: FundsRun[], run: FundsRun): void {
  if (existing.some(item => item.plan.dedupeKey === run.plan.dedupeKey || item.plan.id === run.plan.id)) throw new Error("该批次已经存在，请恢复原任务，不能重复创建");
  if (run.plan.kind === "test-cycle" && existing.some(item => item.plan.kind === "test-cycle" && item.status !== "completed" && item.plan.treasury.address.toLowerCase() === run.plan.treasury.address.toLowerCase())) throw new Error("资金库还有未完成的循环测试，请先核对并恢复原任务");
}

/** In-memory implementation for deterministic engine tests. Never use for real transfers. */
export class MemoryFundsStore implements FundsStore {
  private runs = new Map<string, FundsRun>();
  private locks = new Set<string>();
  async create(run: FundsRun): Promise<FundsRun> {
    assertNewRun([...this.runs.values()], run);
    this.runs.set(run.plan.id, clone(run)); return clone(run);
  }
  async get(id: string): Promise<FundsRun | undefined> { const value = this.runs.get(id); return value ? clone(value) : undefined; }
  async list(): Promise<FundsRun[]> { return [...this.runs.values()].map(clone); }
  async update(id: string, change: (current: FundsRun) => FundsRun): Promise<FundsRun> {
    const current = this.runs.get(id); if (!current) throw new Error("任务不存在");
    const updated = change(clone(current));
    updated.revision = current.revision + 1;
    this.runs.set(id, clone(updated)); return clone(updated);
  }
  async withTreasuryLock<T>(address: string, task: () => Promise<T>): Promise<T> {
    const key = address.toLowerCase(); if (this.locks.has(key)) throw new Error("资金库已有任务执行中，请勿在多个窗口重复启动");
    this.locks.add(key); try { return await task(); } finally { this.locks.delete(key); }
  }
}

/** Browser-only durability. Signed payloads stay in this origin's IndexedDB. */
export class IndexedDbFundsStore implements FundsStore {
  private database?: Promise<IDBDatabase>;
  constructor(private readonly name = "nado-funds-handoff-v1") {}
  private db(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("浏览器不支持持久化存储，禁止发送资金")); return; }
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        const runs = request.result.createObjectStore("runs", { keyPath: "plan.id" });
        runs.createIndex("dedupeKey", "plan.dedupeKey", { unique: true });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("打开本地记录失败"));
    }); return this.database;
  }
  async create(run: FundsRun): Promise<FundsRun> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("runs", "readwrite", { durability: "strict" });
      const objectStore = tx.objectStore("runs"); const read = objectStore.getAll(); let checkError: unknown;
      read.onsuccess = () => {
        try { assertNewRun(read.result as FundsRun[], run); objectStore.add(clone(run)); }
        catch (error) { checkError = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(clone(run));
      tx.onabort = () => reject(checkError ?? new Error(tx.error?.name === "ConstraintError" ? "该批次已经存在，请恢复原任务，不能重复创建" : "任务写入失败，未发送资金"));
      tx.onerror = () => { /* onabort supplies the final error. */ };
    });
  }
  async get(id: string): Promise<FundsRun | undefined> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction("runs", "readonly").objectStore("runs").get(id);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  }
  async list(): Promise<FundsRun[]> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction("runs", "readonly").objectStore("runs").getAll();
      request.onsuccess = () => resolve(request.result as FundsRun[]); request.onerror = () => reject(request.error);
    });
  }
  async update(id: string, change: (current: FundsRun) => FundsRun): Promise<FundsRun> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("runs", "readwrite", { durability: "strict" });
      const store = tx.objectStore("runs"); const request = store.get(id); let result: FundsRun; let changeError: unknown;
      request.onsuccess = () => {
        try {
          const current = request.result as FundsRun | undefined; if (!current) throw new Error("任务不存在");
          result = change(clone(current)); result.revision = current.revision + 1;
          if (result.plan.id !== current.plan.id || result.plan.dedupeKey !== current.plan.dedupeKey) throw new Error("任务唯一编号不可修改");
          store.put(result);
        } catch (error) { changeError = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(clone(result));
      tx.onabort = () => reject(changeError ?? tx.error ?? new Error("记录写入失败，禁止继续发送"));
      tx.onerror = () => { /* onabort supplies the final error. */ };
    });
  }
  async withTreasuryLock<T>(treasuryAddress: string, task: () => Promise<T>): Promise<T> {
    if (typeof navigator === "undefined" || !navigator.locks) throw new Error("浏览器不支持跨窗口资金库锁，禁止自动转账");
    return navigator.locks.request(`nado-funds:${treasuryAddress.toLowerCase()}`, { mode: "exclusive", ifAvailable: true }, async lock => {
      if (!lock) throw new Error("资金库已有任务执行中，请勿在多个窗口重复启动");
      return task();
    });
  }
}
