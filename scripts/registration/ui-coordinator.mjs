import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * One coordinator must be shared by every browser in a worker group.
 *
 * Wrap each focus + UI operation, and the entire clipboard copy/read/fill/clear
 * sequence, in run(). Await all nested work before the outer operation returns.
 * Reentry in the owning async context is allowed; unrelated callers queue FIFO.
 * This is an in-process coordinator, not a replacement for the process lock.
 */
export function createUiCoordinator() {
  const context = new AsyncLocalStorage();
  let tail = Promise.resolve();

  async function run(operation) {
    if (typeof operation !== 'function') throw new TypeError('UI 操作必须是函数。');
    const inherited = context.getStore();
    if (inherited?.active) return operation();

    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    const lease = { active: true };
    try {
      return await context.run(lease, operation);
    } finally {
      // Async descendants can retain the context after their parent returns.
      // An expired lease must queue again rather than bypass the next owner.
      lease.active = false;
      release();
    }
  }

  return Object.freeze({ run });
}
