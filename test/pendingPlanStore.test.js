import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PendingPlanStore } from '../src/executive/PendingPlanStore.js';

describe('PendingPlanStore', () => {
  test('returns and consumes a pending plan exactly once', () => {
    const store = new PendingPlanStore();
    const plan = { taskId: 'task-1', goal: 'open browser' };
    assert.equal(store.set('session-1', plan), null);
    assert.deepEqual(store.take('session-1'), plan);
    assert.equal(store.take('session-1'), null);
  });

  test('expires old confirmations and invokes cancellation callback', () => {
    let now = 1_000;
    const expired = [];
    const store = new PendingPlanStore({
      ttlMs: 2_000,
      now: () => now,
      onExpire: (plan, reason) => expired.push({ plan, reason }),
    });
    store.set('session-1', { taskId: 'task-1' });
    now = 3_001;
    assert.equal(store.get('session-1'), null);
    assert.deepEqual(expired, [{ plan: { taskId: 'task-1' }, reason: 'expired' }]);
  });

  test('bounds session growth and expires the oldest pending plan', () => {
    const expired = [];
    const store = new PendingPlanStore({
      maxEntries: 2,
      onExpire: (plan, reason) => expired.push({ plan, reason }),
    });
    store.set('one', { taskId: 'task-1' });
    store.set('two', { taskId: 'task-2' });
    store.set('three', { taskId: 'task-3' });
    assert.equal(store.get('one'), null);
    assert.deepEqual(expired, [{ plan: { taskId: 'task-1' }, reason: 'capacity' }]);
    assert.equal(store.get('two').taskId, 'task-2');
    assert.equal(store.get('three').taskId, 'task-3');
  });

  test('replacing a session plan returns the previous proposal', () => {
    const store = new PendingPlanStore();
    store.set('session-1', { taskId: 'old' });
    const previous = store.set('session-1', { taskId: 'new' });
    assert.equal(previous.taskId, 'old');
    assert.equal(store.get('session-1').taskId, 'new');
  });
});
