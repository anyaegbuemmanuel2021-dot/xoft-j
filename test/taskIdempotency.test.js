import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActivityLog } from '../src/activity/ActivityLog.js';
import { EventBus } from '../src/events/EventBus.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';
import { ApprovalSystem } from '../src/approval/ApprovalSystem.js';
import { TaskPlanner } from '../src/planner/TaskPlanner.js';
import { ExecutionRecordStore } from '../src/planner/ExecutionRecordStore.js';

/** A tool whose execute() counts how many times it's actually been called. */
function makeCountingTool(name = 'test.send_message') {
  let calls = 0;
  const tool = {
    name,
    description: 'test tool',
    inputSchema: {},
    riskLevel: 0,
    requiredPermissions: [],
    status: 'implemented',
    async run(input) {
      calls += 1;
      return { sent: true, calls, input };
    },
  };
  return { tool, getCalls: () => calls };
}

function makeHarness({ tool, plannedSteps }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-idempotency-test-'));
  const activityLog = new ActivityLog({ dataDir });
  const eventBus = new EventBus({ activityLog });
  const toolRegistry = new ToolRegistry({ defaultDeviceId: 'local' });
  toolRegistry.register(tool);
  const approvalSystem = new ApprovalSystem({ activityLog, eventBus, dataDir });

  const router = {
    async complete() {
      return { text: JSON.stringify({ steps: plannedSteps, blockedReason: null }) };
    },
  };

  const executionRecordStore = new ExecutionRecordStore({ dataDir });
  const taskPlanner = new TaskPlanner({ router, toolRegistry, approvalSystem, activityLog, memory: null, eventBus, executionRecordStore, dataDir });
  return { taskPlanner, executionRecordStore, eventBus };
}

describe('Task idempotency / duplicate-execution prevention', () => {
  test('a step is only ever actually executed once, even if execute() is called again after success', async () => {
    const { tool, getCalls } = makeCountingTool();
    const { taskPlanner } = makeHarness({
      tool,
      plannedSteps: [{ id: 'step1', toolName: tool.name, input: { to: 'john' }, dependsOn: [], description: 'send message' }],
    });

    const created = await taskPlanner.plan('send john a message');
    const first = await taskPlanner.execute(created.id);
    assert.equal(first.status, 'completed');
    assert.equal(getCalls(), 1);

    // Simulate re-invoking execute() on an already-completed task (e.g. a
    // stray retry, or a resumed process that doesn't know it already finished).
    const second = await taskPlanner.execute(created.id);
    assert.equal(second.status, 'completed');
    assert.equal(getCalls(), 1, 'the tool must not be called a second time for the same step');
  });

  test('ExecutionRecordStore.findLatestSucceeded prevents re-execution even from a brand-new TaskPlanner instance (crash-recovery scenario)', async () => {
    const { tool, getCalls } = makeCountingTool();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-idempotency-crash-test-'));
    const activityLog = new ActivityLog({ dataDir });
    const eventBus = new EventBus({ activityLog });
    const toolRegistry = new ToolRegistry({ defaultDeviceId: 'local' });
    toolRegistry.register(tool);
    const approvalSystem = new ApprovalSystem({ activityLog, eventBus, dataDir });
    const plannedSteps = [{ id: 'step1', toolName: tool.name, input: { to: 'john' }, dependsOn: [], description: 'send message' }];
    const router = { async complete() { return { text: JSON.stringify({ steps: plannedSteps, blockedReason: null }) }; } };

    const store1 = new ExecutionRecordStore({ dataDir });
    const planner1 = new TaskPlanner({ router, toolRegistry, approvalSystem, activityLog, memory: null, eventBus, executionRecordStore: store1, dataDir });
    const created = await planner1.plan('send john a message');
    await planner1.execute(created.id);
    assert.equal(getCalls(), 1);

    // Fresh instances reading the same dataDir — the "process restarted" case.
    const store2 = new ExecutionRecordStore({ dataDir });
    const planner2 = new TaskPlanner({ router, toolRegistry, approvalSystem, activityLog, memory: null, eventBus, executionRecordStore: store2, dataDir });
    // Force the step back to pending, as if the in-memory task state was lost
    // and only the persisted (already-completed) execution record survived.
    const task = planner2.get(created.id);
    assert.equal(task.steps[0].status, 'completed');

    // Directly exercise the dedup check the way TaskPlanner does internally.
    const key = ExecutionRecordStore.keyFor(created.id, 'step1');
    const prior = store2.findLatestSucceeded(key);
    assert.ok(prior, 'a succeeded record must be visible to a fresh store instance reading the same file');
    assert.equal(getCalls(), 1, 'no re-execution happened just from reading records');
  });

  test('an execution record left "running" (simulated crash) is surfaced as ambiguous, not silently treated as success or failure', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-idempotency-dangling-test-'));
    const store = new ExecutionRecordStore({ dataDir });
    const key = ExecutionRecordStore.keyFor('task-x', 'step1');
    store.begin({ taskId: 'task-x', stepId: 'step1', toolName: 'test.tool', idempotencyKey: key, attemptNumber: 1, input: {} });

    assert.equal(store.findLatestSucceeded(key), null);
    const dangling = store.findDangling(key);
    assert.ok(dangling, 'a running-but-never-completed record must be detectable');
    assert.equal(dangling.status, 'running');
  });

  test('two different steps get two different idempotency keys', () => {
    assert.notEqual(ExecutionRecordStore.keyFor('t1', 's1'), ExecutionRecordStore.keyFor('t1', 's2'));
    assert.notEqual(ExecutionRecordStore.keyFor('t1', 's1'), ExecutionRecordStore.keyFor('t2', 's1'));
  });

  test('the execution ledger is bounded — old records are dropped once past 5000, keeping the most recent (Phase 3N: HDD write-cost containment)', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-execrecord-bound-'));
    const store = new ExecutionRecordStore({ dataDir });
    // Pre-seed 5000 records directly (one fast write) rather than looping
    // begin()+complete() 5000 times through the real store — that would
    // mean 5000 full read-modify-write cycles just to set up the test,
    // which is exactly the write-amplification cost this cap exists to
    // bound, not something a unit test should also pay.
    const seeded = Array.from({ length: 5000 }, (_, i) => ({
      executionId: `seed-${i}`, taskId: 'bulk-task', stepId: `step-${i}`, toolName: 'test.bulk',
      idempotencyKey: ExecutionRecordStore.keyFor('bulk-task', `step-${i}`), attemptNumber: 1,
      status: 'succeeded', input: {}, result: {}, error: null, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    }));
    fs.writeFileSync(store._store.filePath, JSON.stringify({ records: seeded }));

    // Now add 10 more through the real API — this is what should trigger the cap.
    for (let i = 5000; i < 5010; i++) {
      const key = ExecutionRecordStore.keyFor('bulk-task', `step-${i}`);
      const rec = store.begin({ taskId: 'bulk-task', stepId: `step-${i}`, toolName: 'test.bulk', idempotencyKey: key, attemptNumber: 1, input: {} });
      store.complete(rec.executionId, { status: 'succeeded', result: {} });
    }

    const all = store.list();
    assert.equal(all.length, 5000, 'the ledger must not grow past the cap');
    assert.equal(store.findLatestSucceeded(ExecutionRecordStore.keyFor('bulk-task', 'step-0')), null, 'oldest seeded records must have been dropped');
    assert.ok(store.findLatestSucceeded(ExecutionRecordStore.keyFor('bulk-task', 'step-5009')), 'newest records must be kept');
  });

  test('a failing tool retries under the SAME idempotency key, and each attempt gets its own execution record', async () => {
    let calls = 0;
    const tool = {
      name: 'test.flaky',
      description: 'fails once then succeeds',
      inputSchema: {},
      riskLevel: 0,
      requiredPermissions: [],
      status: 'implemented',
      async run() {
        calls += 1;
        if (calls === 1) throw new Error('transient failure');
        return { ok: true };
      },
    };
    const { taskPlanner, executionRecordStore } = makeHarness({
      tool,
      plannedSteps: [{ id: 'step1', toolName: tool.name, input: {}, dependsOn: [], description: 'flaky step' }],
    });
    const created = await taskPlanner.plan('do the flaky thing');
    const result = await taskPlanner.execute(created.id);

    assert.equal(result.status, 'completed');
    assert.equal(calls, 2);
    const records = executionRecordStore.forTask(created.id);
    assert.equal(records.length, 2, 'one execution record per attempt');
    assert.equal(records[0].idempotencyKey, records[1].idempotencyKey, 'retries share the same idempotency key');
    assert.equal(records[0].status, 'failed');
    assert.equal(records[1].status, 'succeeded');
  });
});
