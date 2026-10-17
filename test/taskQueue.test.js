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
import { TaskQueue } from '../src/planner/TaskQueue.js';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** A tool that blocks until released, so tests can control exactly how many are "in flight" at once. */
function makeControlledTool(name, delayMs = 30) {
  let active = 0;
  let maxActive = 0;
  const tool = {
    name,
    description: 'test',
    inputSchema: {},
    riskLevel: 0,
    requiredPermissions: [],
    status: 'implemented',
    async run() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(delayMs);
      active -= 1;
      return { ok: true };
    },
  };
  return { tool, getMaxActive: () => maxActive };
}

function makeHarness({ tool, concurrency = 2 }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-queue-test-'));
  const activityLog = new ActivityLog({ dataDir });
  const eventBus = new EventBus({ activityLog });
  const toolRegistry = new ToolRegistry({ defaultDeviceId: 'local' });
  toolRegistry.register(tool);
  const approvalSystem = new ApprovalSystem({ activityLog, eventBus, dataDir });
  const router = {
    async complete(_taskType, params) {
      const goal = params.messages[0].content;
      return { text: JSON.stringify({ steps: [{ id: 'step1', toolName: tool.name, input: {}, dependsOn: [], description: goal }], blockedReason: null }) };
    },
  };
  const executionRecordStore = new ExecutionRecordStore({ dataDir });
  const taskPlanner = new TaskPlanner({ router, toolRegistry, approvalSystem, activityLog, memory: null, eventBus, executionRecordStore, dataDir });
  const taskQueue = new TaskQueue({ taskPlanner, eventBus, activityLog, concurrency, pollIntervalMs: 20 });
  return { taskPlanner, taskQueue };
}

describe('TaskQueue', () => {
  test('never runs more tasks at once than the configured concurrency', async () => {
    const { tool, getMaxActive } = makeControlledTool('test.slow', 40);
    const { taskPlanner, taskQueue } = makeHarness({ tool, concurrency: 2 });

    const tasks = await Promise.all([1, 2, 3, 4, 5].map((i) => taskPlanner.plan(`task ${i}`)));
    for (const t of tasks) taskQueue.enqueue(t.id);

    // Wait for all 5 to finish (5 tasks / 2 concurrency, ~40ms each => ~3 waves).
    await sleep(400);
    assert.ok(getMaxActive() <= 2, `expected at most 2 concurrent executions, saw ${getMaxActive()}`);
    for (const t of tasks) {
      assert.equal(taskPlanner.get(t.id).status, 'completed');
    }
  });

  test('high-priority tasks are drained before normal-priority ones queued earlier', async () => {
    const { tool } = makeControlledTool('test.slow2', 30);
    const { taskPlanner, taskQueue } = makeHarness({ tool, concurrency: 1 });

    const low = await taskPlanner.plan('low priority task');
    taskPlanner.setStatus(low.id, 'planned', { priority: 'low' });
    const high = await taskPlanner.plan('high priority task');
    taskPlanner.setStatus(high.id, 'planned', { priority: 'high' });

    // Occupy the single concurrency slot first so both land in `_pending` together.
    const filler = await taskPlanner.plan('filler task');
    taskQueue.enqueue(filler.id);
    taskQueue.enqueue(low.id);
    taskQueue.enqueue(high.id);

    const order = [];
    taskPlanner.setStatus(high.id, 'planned'); // no-op, just confirming record exists
    // Poll queue status until both have left the pending list, recording drain order.
    for (let i = 0; i < 50; i++) {
      const st = taskQueue.status();
      if (!st.pending.some((p) => p.taskId === high.id) && !order.includes(high.id)) order.push(high.id);
      if (!st.pending.some((p) => p.taskId === low.id) && !order.includes(low.id)) order.push(low.id);
      if (order.length === 2) break;
      await sleep(15);
    }
    assert.deepEqual(order, [high.id, low.id], 'high priority must drain before low priority');
    await sleep(60);
  });

  test('enqueueing the same task twice does not run it twice concurrently', async () => {
    const { tool, getMaxActive } = makeControlledTool('test.dedupe', 50);
    const { taskPlanner, taskQueue } = makeHarness({ tool, concurrency: 3 });
    const t = await taskPlanner.plan('goal');
    taskQueue.enqueue(t.id);
    taskQueue.enqueue(t.id);
    taskQueue.enqueue(t.id);
    await sleep(150);
    assert.equal(getMaxActive(), 1, 'the same task must not run in more than one slot at once');
  });

  test('scheduleAt persists scheduledFor and tick() only enqueues once it is due', async () => {
    const { tool } = makeControlledTool('test.scheduled', 10);
    const { taskPlanner, taskQueue } = makeHarness({ tool, concurrency: 1 });
    const t = await taskPlanner.plan('scheduled goal');

    const future = new Date(Date.now() + 10_000).toISOString();
    const scheduled = taskQueue.scheduleAt(t.id, future);
    assert.equal(scheduled.status, 'scheduled');
    assert.equal(scheduled.scheduledFor, future);

    taskQueue.tick();
    assert.equal(taskPlanner.get(t.id).status, 'scheduled', 'must not run before its scheduled time');

    // Reschedule into the past ("now") and confirm the same task record picks up correctly.
    taskQueue.scheduleAt(t.id, new Date(Date.now() - 1000).toISOString());
    taskQueue.tick();
    await sleep(50);
    assert.equal(taskPlanner.get(t.id).status, 'completed');
  });

  test('scheduleAt rejects an invalid timestamp instead of silently scheduling garbage', () => {
    const { tool } = makeControlledTool('test.invalid', 5);
    const { taskPlanner, taskQueue } = makeHarness({ tool });
    assert.rejects(async () => {
      const t = await taskPlanner.plan('goal');
      taskQueue.scheduleAt(t.id, 'not-a-date');
    });
  });
});
