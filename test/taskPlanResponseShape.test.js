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

function makePlanner(response) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-plan-response-'));
  const activityLog = new ActivityLog({ dataDir });
  const eventBus = new EventBus({ activityLog });
  const toolRegistry = new ToolRegistry({ defaultDeviceId: 'local' });
  toolRegistry.register({
    name: 'test.noop', description: 'no-op', inputSchema: { type: 'object', properties: {} },
    riskLevel: 0, requiredPermissions: [], status: 'implemented', async run() { return { ok: true }; },
  });
  const approvalSystem = new ApprovalSystem({ activityLog, eventBus, dataDir });
  const router = { async complete() { return { text: JSON.stringify(response) }; } };
  return new TaskPlanner({ router, toolRegistry, approvalSystem, activityLog, memory: null, eventBus, dataDir });
}

describe('TaskPlanner — planner response shape', () => {
  test('rejects valid JSON values that are not plan objects with a clear error', async () => {
    for (const value of [null, [], 'not a plan', 42, true]) {
      const planner = makePlanner(value);
      await assert.rejects(() => planner.plan('test goal'), /planner response must be a JSON object/);
    }
  });

  test('treats an object with no steps as blocked rather than executable', async () => {
    const planner = makePlanner({ blockedReason: 'No suitable tool is available.' });
    const task = await planner.plan('unsupported goal');
    assert.equal(task.status, 'blocked');
    assert.equal(task.steps.length, 0);
    assert.equal(task.blockedReason, 'No suitable tool is available.');
  });
});
