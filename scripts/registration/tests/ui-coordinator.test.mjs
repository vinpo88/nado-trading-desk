import test from 'node:test';
import assert from 'node:assert/strict';
import { createUiCoordinator } from '../ui-coordinator.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('unrelated browser operations remain FIFO and never overlap', async () => {
  const coordinator = createUiCoordinator();
  const entered = deferred();
  const release = deferred();
  const events = [];
  let active = 0;
  let maximumActive = 0;
  const operation = (name, wait) => coordinator.run(async () => {
    maximumActive = Math.max(maximumActive, ++active);
    events.push(`${name}:start`);
    if (wait) { entered.resolve(); await wait; }
    await Promise.resolve();
    events.push(`${name}:end`);
    active--;
    return name;
  });
  const first = operation('edge', release.promise);
  await entered.promise;
  const second = operation('chrome');
  const third = operation('edge-again');
  await Promise.resolve();
  assert.deepEqual(events, ['edge:start']);
  release.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), ['edge', 'chrome', 'edge-again']);
  assert.equal(maximumActive, 1);
  assert.deepEqual(events, ['edge:start', 'edge:end', 'chrome:start', 'chrome:end', 'edge-again:start', 'edge-again:end']);
});

test('nested calls after an await reenter ahead of an unrelated queued operation', { timeout: 2000 }, async () => {
  const coordinator = createUiCoordinator();
  const entered = deferred();
  const resume = deferred();
  const events = [];
  const outer = coordinator.run(async () => {
    events.push('copy');
    entered.resolve();
    await resume.promise;
    const result = await coordinator.run(async () => {
      events.push('read');
      await Promise.resolve();
      return coordinator.run(() => { events.push('fill'); return 42; });
    });
    events.push('clear');
    return result;
  });
  await entered.promise;
  const competitor = coordinator.run(() => { events.push('other-browser'); });
  resume.resolve();
  assert.equal(await outer, 42);
  await competitor;
  assert.deepEqual(events, ['copy', 'read', 'fill', 'clear', 'other-browser']);
});

test('synchronous and asynchronous failures release the queue without masking the error', async () => {
  const coordinator = createUiCoordinator();
  const syncError = new Error('synthetic synchronous failure');
  const asyncError = new Error('synthetic asynchronous failure');
  const events = [];
  const first = coordinator.run(() => { events.push('sync'); throw syncError; });
  const second = coordinator.run(async () => { events.push('async'); await Promise.resolve(); throw asyncError; });
  const third = coordinator.run(() => { events.push('success'); return 'ok'; });
  const results = await Promise.allSettled([first, second, third]);
  assert.equal(results[0].reason, syncError);
  assert.equal(results[1].reason, asyncError);
  assert.deepEqual(results[2], { status: 'fulfilled', value: 'ok' });
  assert.deepEqual(events, ['sync', 'async', 'success']);
});

test('a caught nested error does not release the outer operation early', async () => {
  const coordinator = createUiCoordinator();
  const entered = deferred();
  const resume = deferred();
  const events = [];
  const outer = coordinator.run(async () => {
    entered.resolve();
    await resume.promise;
    await assert.rejects(coordinator.run(() => { throw new Error('nested'); }), /nested/);
    events.push('outer-still-owned');
  });
  await entered.promise;
  const competitor = coordinator.run(() => { events.push('next'); });
  resume.resolve();
  await Promise.all([outer, competitor]);
  assert.deepEqual(events, ['outer-still-owned', 'next']);
});

test('an async descendant with an expired lease queues behind the current owner', async () => {
  const coordinator = createUiCoordinator();
  const invokeDescendant = deferred();
  const descendantQueued = deferred();
  const competitorEntered = deferred();
  const releaseCompetitor = deferred();
  const events = [];
  let descendant;
  await coordinator.run(() => {
    descendant = (async () => {
      await invokeDescendant.promise;
      const operation = coordinator.run(() => { events.push('descendant'); });
      descendantQueued.resolve();
      await operation;
    })();
  });
  const competitor = coordinator.run(async () => {
    events.push('current:start');
    competitorEntered.resolve();
    await releaseCompetitor.promise;
    events.push('current:end');
  });
  await competitorEntered.promise;
  invokeDescendant.resolve();
  await descendantQueued.promise;
  assert.deepEqual(events, ['current:start']);
  releaseCompetitor.resolve();
  await Promise.all([competitor, descendant]);
  assert.deepEqual(events, ['current:start', 'current:end', 'descendant']);
});

test('independent coordinators do not treat each other as owners or block each other', async () => {
  const first = createUiCoordinator();
  const second = createUiCoordinator();
  const entered = deferred();
  const release = deferred();
  const held = first.run(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  assert.equal(await second.run(() => 'independent'), 'independent');
  release.resolve();
  await held;
});

test('an invalid operation is rejected without poisoning subsequent calls', async () => {
  const coordinator = createUiCoordinator();
  await assert.rejects(coordinator.run(null), TypeError);
  assert.equal(await coordinator.run(() => 'ready'), 'ready');
});
