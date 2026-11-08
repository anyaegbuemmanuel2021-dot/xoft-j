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

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function harness(tool, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-task-single-flight-'));
  const activityLog = new ActivityLog({ dataDir });
  const eventBus = new EventBus({ activityLog });
  const toolRegistry = new ToolRegistry({ defaultDeviceId: 'local' });
  toolRegistry.register(tool);
  const approvalSystem = new ApprovalSystem({ activityLog, eventBus, dataDir });
  const router = {
    async complete() {
      return { text: JSON.stringify({ steps: [{ id: 'step1', toolName: tool.name, input: {}, dependsOn: [], description: 'slow action' }], blockedReason: null }) };
    },
  };
  const planner = new TaskPlanner({ router, toolRegistry, approvalSystem, activityLog, memory: null, eventBus, dataDir, ...options });
  return planner;
}

describe('TaskPlanner single-flight execution', () => {
  test('invalid and excessive task timeout configuration is safely bounded', () => {
    const tool = {
      name: 'test.timeout_config',
      description: 'timeout config test',
      inputSchema: {},
      riskLevel: 0,
      requiredPermissions: [],
      status: 'implemented',
      async run() { return { ok: true }; },
    };
    assert.equal(harness(tool, { maxDurationMs: Number.NaN }).maxDurationMs, 15 * 60 * 1000);
    assert.equal(harness(tool, { maxDurationMs: 'not-a-number' }).maxDurationMs, 15 * 60 * 1000);
    assert.equal(harness(tool, { maxDurationMs: 500 }).maxDurationMs, 1000);
    assert.equal(harness(tool, { maxDurationMs: 99 * 60 * 60 * 1000 }).maxDurationMs, 24 * 60 * 60 * 1000);
  });

  test('persists the execution intent before marking a step running', async () => {
    const tool = {
      name: 'test.ledger_first',
      description: 'ledger ordering test',
      inputSchema: {},
      riskLevel: 0,
      requiredPermissions: [],
      status: 'implemented',
      async run() { return { ok: true }; },
    };
    const planner = harness(tool);
    const task = await planner.plan('persist intent before running');

    const originalPatchStep = planner._patchStep.bind(planner);
    let observedDurableIntent = false;
    planner._patchStep = (taskId, stepId, patch) => {
      if (patch.status === 'running') {
        observedDurableIntent = planner.executions(taskId).some((record) =>
          record.stepId === stepId && record.status === 'running'
        );
      }
      return originalPatchStep(taskId, stepId, patch);
    };

    const result = await planner.execute(task.id);
    assert.equal(result.status, 'completed');
    assert.equal(observedDurableIntent, true, 'a crash after the running-state write must leave a durable ledger record');
  });

  test('concurrent execute calls for one task share one real tool execution', async () => {
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const tool = {
      name: 'test.slow_side_effect',
      description: 'slow side effect',
      inputSchema: {},
      riskLevel: 0,
      requiredPermissions: [],
      status: 'implemented',
      async run() {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(80);
        active -= 1;
        return { ok: true };
      },
    };
    const planner = harness(tool);
    const task = await planner.plan('perform slow action');

    const first = planner.execute(task.id);
    const second = planner.execute(task.id);
    const [a, b] = await Promise.all([first, second]);

    assert.equal(a.status, 'completed');
    assert.equal(b.status, 'completed');
    assert.equal(calls, 1, 'duplicate callers must not invoke the side effect twice');
    assert.equal(maxActive, 1, 'the same task must never execute concurrently with itself');
  });


});
