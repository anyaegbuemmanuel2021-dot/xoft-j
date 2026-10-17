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
import { RiskLevel } from '../src/tools/Tool.js';
import { ExecutionRecordStore } from '../src/planner/ExecutionRecordStore.js';

function harness({ tool, maxDurationMs = 1000 } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-timeout-ambiguity-'));
  const activityLog = new ActivityLog({ dataDir });
  const eventBus = new EventBus({ activityLog });
  const registry = new ToolRegistry({ defaultDeviceId: 'local' });
  registry.register(tool);
  const approvalSystem = new ApprovalSystem({ activityLog, eventBus, dataDir });
  const router = { async complete() { return { text: JSON.stringify({ steps: [{ id: 's1', toolName: tool.name, input: {}, dependsOn: [], description: 'test' }], blockedReason: null }) }; } };
  const planner = new TaskPlanner({ router, toolRegistry: registry, approvalSystem, activityLog, memory: null, eventBus, dataDir, maxDurationMs });
  return { dataDir, activityLog, eventBus, registry, approvalSystem, planner };
}

describe('TaskPlanner hardening', () => {
  test('task wall-clock timeout marks a task timed_out', async () => {
    const tool = { name: 'test.hang', description: 'hangs', inputSchema: {}, riskLevel: RiskLevel.SAFE, requiredPermissions: [], status: 'IMPLEMENTED', async run() { await new Promise(() => {}); } };
    const { planner } = harness({ tool, maxDurationMs: 1000 });
    const task = await planner.plan('hang');
    await assert.rejects(() => planner.execute(task.id), /exceeded the maximum duration/);
    assert.equal(planner.get(task.id).status, 'timed_out');
  });

  test('dangling EXTERNAL execution requires fresh approval before retry', async () => {
    let calls = 0;
    const tool = { name: 'test.external', description: 'external', inputSchema: {}, riskLevel: RiskLevel.EXTERNAL, requiredPermissions: [], status: 'IMPLEMENTED', async run() { calls += 1; return { ok: true }; } };
    const { planner, approvalSystem, dataDir } = harness({ tool });
    const task = await planner.plan('external');
    const store = new ExecutionRecordStore({ dataDir });
    store.begin({ taskId: task.id, stepId: 's1', toolName: tool.name, idempotencyKey: task.steps[0].idempotencyKey, attemptNumber: 1, input: {} });

    const waiting = await planner.execute(task.id);
    assert.equal(waiting.status, 'waiting_approval');
    assert.equal(calls, 0);
    const approvalId = waiting.steps[0].approvalId;
    assert.equal(approvalSystem.get(approvalId).reason, 'ambiguous_prior_execution');

    approvalSystem.approve(approvalId);
    const resumed = await planner.resumeAfterApproval(task.id);
    assert.equal(resumed.status, 'completed');
    assert.equal(calls, 1);
  });
});
