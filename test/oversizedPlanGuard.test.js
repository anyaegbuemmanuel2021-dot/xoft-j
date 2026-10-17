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

/**
 * Spec section 67 — "agent loop limits: every autonomous task should have a
 * maximum number of steps... prevent infinite/runaway plans." Before this,
 * TaskPlanner.plan() would accept and persist a plan of any size returned by
 * the model, with no ceiling.
 */
describe('TaskPlanner — oversized plan guard', () => {
  function makeHarness(plannedSteps) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-oversized-plan-'));
    const activityLog = new ActivityLog({ dataDir });
    const eventBus = new EventBus({ activityLog });
    const toolRegistry = new ToolRegistry({ defaultDeviceId: 'local' });
    toolRegistry.register({ name: 'test.noop', description: 'x', inputSchema: {}, riskLevel: 0, requiredPermissions: [], status: 'implemented', async run() { return { ok: true }; } });
    const approvalSystem = new ApprovalSystem({ activityLog, eventBus, dataDir });
    const router = { async complete() { return { text: JSON.stringify({ steps: plannedSteps, blockedReason: null }) }; } };
    return new TaskPlanner({ router, toolRegistry, approvalSystem, activityLog, memory: null, eventBus, dataDir });
  }

  test('a plan within the step limit is accepted normally', async () => {
    const steps = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, toolName: 'test.noop', input: {}, dependsOn: [], description: `step ${i}` }));
    const planner = makeHarness(steps);
    const task = await planner.plan('a reasonably sized goal');
    assert.equal(task.status, 'planned');
    assert.equal(task.steps.length, 5);
  });

  test('a plan exceeding the step limit is rejected as blocked, not silently accepted or truncated', async () => {
    const steps = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, toolName: 'test.noop', input: {}, dependsOn: [], description: `step ${i}` }));
    const planner = makeHarness(steps);
    const task = await planner.plan('an unreasonably huge goal');
    assert.equal(task.status, 'blocked');
    assert.equal(task.steps.length, 0, 'an oversized plan must not be partially accepted');
    assert.match(task.blockedReason, /exceeds the safety limit/);
  });
});
