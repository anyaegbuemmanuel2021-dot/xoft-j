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

function makeHarness(router, tools) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-cancel-test-'));
  const activityLog = new ActivityLog({ dataDir });
  const eventBus = new EventBus({ activityLog });
  const toolRegistry = new ToolRegistry({ defaultDeviceId: 'local' });
  for (const tool of tools) toolRegistry.register(tool);
  const approvalSystem = new ApprovalSystem({ activityLog, eventBus, dataDir });
  const planner = new TaskPlanner({ router, toolRegistry, approvalSystem, activityLog, memory: null, eventBus, dataDir });
  return planner;
}

describe('TaskPlanner — cooperative cancellation', () => {
  test('cancelling during a running step lets it settle but prevents later steps from starting', async () => {
    let releaseFirst;
    let signalStarted;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    let firstCalls = 0;
    let secondCalls = 0;
    const firstTool = {
      name: 'test.first', description: 'first action', inputSchema: {}, riskLevel: 0,
      requiredPermissions: [], status: 'implemented',
      async run() {
        firstCalls += 1;
        signalStarted();
        await new Promise((resolve) => { releaseFirst = resolve; });
        return { ok: true };
      },
    };
    const secondTool = {
      name: 'test.second', description: 'second action', inputSchema: {}, riskLevel: 0,
      requiredPermissions: [], status: 'implemented',
      async run() { secondCalls += 1; return { ok: true }; },
    };
    const router = {
      async complete() {
        return { text: JSON.stringify({ steps: [
          { id: 'one', toolName: firstTool.name, input: {}, dependsOn: [], description: 'first' },
          { id: 'two', toolName: secondTool.name, input: {}, dependsOn: ['one'], description: 'second' },
        ], blockedReason: null }) };
      },
    };
    const planner = makeHarness(router, [firstTool, secondTool]);
    const task = await planner.plan('two-step task');
    const execution = planner.execute(task.id);

    await started;
    planner.cancel(task.id);
    releaseFirst();
    const result = await execution;

    assert.equal(firstCalls, 1, 'the already-running action is allowed to settle once');
    assert.equal(secondCalls, 0, 'no subsequent action may start after cancellation');
    assert.equal(result.status, 'cancelled');
    assert.equal(result.steps[0].status, 'completed');
    assert.equal(result.steps[1].status, 'cancelled');
  });

  test('a task cancelled before execution never starts its tools', async () => {
    let calls = 0;
    const tool = {
      name: 'test.never-run', description: 'action', inputSchema: {}, riskLevel: 0,
      requiredPermissions: [], status: 'implemented',
      async run() { calls += 1; return { ok: true }; },
    };
    const router = {
      async complete() {
        return { text: JSON.stringify({ steps: [
          { id: 'one', toolName: tool.name, input: {}, dependsOn: [], description: 'action' },
        ], blockedReason: null }) };
      },
    };
    const planner = makeHarness(router, [tool]);
    const task = await planner.plan('cancel before run');
    planner.cancel(task.id);
    const result = await planner.execute(task.id);
    assert.equal(result.status, 'cancelled');
    assert.equal(calls, 0);
  });
  test('a cancelled in-flight step is not retried after it fails', async () => {
    let releaseFirst;
    let signalStarted;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    let calls = 0;
    const tool = {
      name: 'test.cancelled-failure', description: 'action', inputSchema: {}, riskLevel: 0,
      requiredPermissions: [], status: 'implemented',
      async run() {
        calls += 1;
        signalStarted();
        await new Promise((resolve) => { releaseFirst = resolve; });
        throw new Error('simulated failure after cancellation');
      },
    };
    const router = {
      async complete() {
        return { text: JSON.stringify({ steps: [
          { id: 'one', toolName: tool.name, input: {}, dependsOn: [], description: 'action' },
        ], blockedReason: null }) };
      },
    };
    const planner = makeHarness(router, [tool]);
    const task = await planner.plan('cancel during failing action');
    const execution = planner.execute(task.id);
    await started;
    planner.cancel(task.id);
    releaseFirst();
    const result = await execution;
    assert.equal(result.status, 'cancelled');
    assert.equal(calls, 1, 'cancellation must suppress automatic retries');
    assert.equal(result.steps[0].status, 'cancelled');
  });

});
