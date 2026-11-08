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

function harness(tool) {
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
  const planner = new TaskPlanner({ router, toolRegistry, approvalSystem, activityLog, memory: null, eventBus, dataDir });
  return planner;
}

describe('TaskPlanner single-flight execution', () => {
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
