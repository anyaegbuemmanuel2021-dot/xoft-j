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

function makePlanner(plannedSteps) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-plan-validation-'));
  const activityLog = new ActivityLog({ dataDir });
  const eventBus = new EventBus({ activityLog });
  const toolRegistry = new ToolRegistry({ defaultDeviceId: 'local' });
  toolRegistry.register({
    name: 'test.noop', description: 'safe test action', inputSchema: {},
    riskLevel: 0, requiredPermissions: [], status: 'implemented',
    async run() { return { ok: true }; },
  });
  toolRegistry.register({
    name: 'test.unavailable', description: 'requires a missing service', inputSchema: {},
    riskLevel: 0, requiredPermissions: [], status: 'REQUIRES_API',
    async run() { throw new Error('must never be invoked'); },
  });
  const approvalSystem = new ApprovalSystem({ activityLog, eventBus, dataDir });
  const router = { async complete() { return { text: JSON.stringify({ steps: plannedSteps, blockedReason: null }) }; } };
  return new TaskPlanner({ router, toolRegistry, approvalSystem, activityLog, memory: null, eventBus, dataDir });
}

const step = (id, dependsOn = []) => ({ id, toolName: 'test.noop', input: {}, dependsOn, description: id });

describe('TaskPlanner — dependency graph validation', () => {
  test('rejects duplicate step IDs before saving executable steps', async () => {
    const planner = makePlanner([step('same'), step('same')]);
    const task = await planner.plan('duplicate ids');
    assert.equal(task.status, 'blocked');
    assert.match(task.blockedReason, /Duplicate step id/);
    assert.equal(task.steps.length, 0);
  });

  test('rejects dependencies that reference missing steps', async () => {
    const planner = makePlanner([step('first', ['missing'])]);
    const task = await planner.plan('missing dependency');
    assert.equal(task.status, 'blocked');
    assert.match(task.blockedReason, /depends on unknown step/);
  });

  test('rejects cyclic and self-referencing dependency graphs', async () => {
    const cyclic = await makePlanner([step('a', ['b']), step('b', ['a'])]).plan('cycle');
    assert.equal(cyclic.status, 'blocked');
    assert.match(cyclic.blockedReason, /dependency cycle/);

    const self = await makePlanner([step('a', ['a'])]).plan('self dependency');
    assert.equal(self.status, 'blocked');
    assert.match(self.blockedReason, /cannot depend on itself/);
  });

  test('rejects unknown tools, invalid inputs, and missing dependency arrays', async () => {
    const unknown = await makePlanner([{ ...step('a'), toolName: 'missing.tool' }]).plan('unknown tool');
    assert.equal(unknown.status, 'blocked');
    assert.match(unknown.blockedReason, /unavailable tool/);

    const invalidInput = await makePlanner([{ ...step('a'), input: [] }]).plan('invalid input');
    assert.equal(invalidInput.status, 'blocked');
    assert.match(invalidInput.blockedReason, /object input/);

    const missingDeps = await makePlanner([{ id: 'a', toolName: 'test.noop', input: {} }]).plan('missing dependsOn');
    assert.equal(missingDeps.status, 'blocked');
    assert.match(missingDeps.blockedReason, /dependsOn as an array/);
  });

  test('does not accept tools already marked unavailable in this environment', async () => {
    const planner = makePlanner([{ ...step('unavailable'), toolName: 'test.unavailable' }]);
    const task = await planner.plan('use an unavailable integration');
    assert.equal(task.status, 'blocked');
    assert.match(task.blockedReason, /unavailable tool 'test.unavailable'/);
  });

  test('normalizes valid steps into dependency order before execution', async () => {
    const planner = makePlanner([step('first', ['second']), step('second')]);
    const task = await planner.plan('out of order plan');
    assert.equal(task.status, 'planned');
    assert.deepEqual(task.steps.map((s) => s.id), ['second', 'first']);
  });
});
