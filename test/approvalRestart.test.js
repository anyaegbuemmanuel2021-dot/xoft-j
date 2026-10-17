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

/**
 * A task that needs approval can sit in 'waiting_approval' indefinitely —
 * it's persisted task state, not a short-lived in-request thing. Before this
 * fix, ApprovalSystem kept its pending/approved/rejected records in a plain
 * in-memory Map, so a process restart silently orphaned every task that was
 * waiting on one: the task record survived in tasks.json, but the approval
 * it was waiting on no longer existed anywhere, and there was no way to
 * approve or reject it. These tests simulate that restart the same way
 * test/backgroundAutomationRestart.test.js does for MonitorManager/RulesEngine:
 * a fresh instance reading the same dataDir stands in for "the process
 * restarted."
 */

function makeExternalTool(name = 'test.send_external') {
  let calls = 0;
  return {
    tool: {
      name,
      description: 'an EXTERNAL-risk tool that requires approval',
      inputSchema: {},
      riskLevel: RiskLevel.EXTERNAL,
      requiredPermissions: [],
      status: 'implemented',
      async run(input) {
        calls += 1;
        return { sent: true, input };
      },
    },
    getCalls: () => calls,
  };
}

describe('ApprovalSystem — restart survival', () => {
  test('a pending approval is visible to a fresh ApprovalSystem instance reading the same dataDir', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-approval-restart-'));
    const activityLog = new ActivityLog({ dataDir });
    const eventBus = new EventBus({ activityLog });
    const { tool } = makeExternalTool();

    const system1 = new ApprovalSystem({ activityLog, eventBus, dataDir });
    const { approvalId } = system1.evaluate({ tool, input: { to: 'jane' }, taskId: 'task-1' });
    assert.ok(approvalId, 'an EXTERNAL-risk tool must require approval');

    // "process 1" is gone — a fresh instance stands in for the restarted process.
    const system2 = new ApprovalSystem({ activityLog, eventBus, dataDir });
    const record = system2.get(approvalId);
    assert.ok(record, 'the pending approval must survive a restart, not vanish with the old in-memory Map');
    assert.equal(record.status, 'pending');
    assert.equal(system2.listPending().length, 1);
  });

  test('an approval can be granted from a fresh instance after "restart", and a linked task resumes', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-approval-restart-task-'));
    const activityLog = new ActivityLog({ dataDir });
    const eventBus = new EventBus({ activityLog });
    const toolRegistry = new ToolRegistry({ defaultDeviceId: 'local' });
    const { tool, getCalls } = makeExternalTool();
    toolRegistry.register(tool);

    const plannedSteps = [{ id: 'step1', toolName: tool.name, input: { to: 'jane' }, dependsOn: [], description: 'send to jane' }];
    const router = { async complete() { return { text: JSON.stringify({ steps: plannedSteps, blockedReason: null }) }; } };

    const approvalSystem1 = new ApprovalSystem({ activityLog, eventBus, dataDir });
    const planner1 = new TaskPlanner({ router, toolRegistry, approvalSystem: approvalSystem1, activityLog, memory: null, eventBus, dataDir });

    const created = await planner1.plan('send jane a message');
    const afterExecute = await planner1.execute(created.id);
    assert.equal(afterExecute.status, 'waiting_approval', 'an EXTERNAL-risk step must stop for approval, not run immediately');
    assert.equal(getCalls(), 0, 'the tool must not run before approval');

    const pendingId = afterExecute.steps[0].approvalId;
    assert.ok(pendingId);

    // "restart": brand-new ApprovalSystem + TaskPlanner instances reading the same dataDir.
    const approvalSystem2 = new ApprovalSystem({ activityLog, eventBus, dataDir });
    const planner2 = new TaskPlanner({ router, toolRegistry, approvalSystem: approvalSystem2, activityLog, memory: null, eventBus, dataDir });

    const approved = approvalSystem2.approve(pendingId);
    assert.equal(approved.status, 'approved');

    const resumed = await planner2.resumeAfterApproval(created.id);
    assert.equal(resumed.status, 'completed', 'the task must be resumable after a restart, using the same persisted approval');
    assert.equal(getCalls(), 1, 'the tool must run exactly once, after approval, even across the simulated restart');
  });

  test('rejecting an approval from a fresh instance after "restart" still stops the linked task', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-approval-restart-reject-'));
    const activityLog = new ActivityLog({ dataDir });
    const eventBus = new EventBus({ activityLog });
    const toolRegistry = new ToolRegistry({ defaultDeviceId: 'local' });
    const { tool, getCalls } = makeExternalTool('test.send_external_2');
    toolRegistry.register(tool);

    const plannedSteps = [{ id: 'step1', toolName: tool.name, input: {}, dependsOn: [], description: 'send' }];
    const router = { async complete() { return { text: JSON.stringify({ steps: plannedSteps, blockedReason: null }) }; } };

    const approvalSystem1 = new ApprovalSystem({ activityLog, eventBus, dataDir });
    const planner1 = new TaskPlanner({ router, toolRegistry, approvalSystem: approvalSystem1, activityLog, memory: null, eventBus, dataDir });
    const created = await planner1.plan('send a message');
    const afterExecute = await planner1.execute(created.id);
    const pendingId = afterExecute.steps[0].approvalId;

    const approvalSystem2 = new ApprovalSystem({ activityLog, eventBus, dataDir });
    const planner2 = new TaskPlanner({ router, toolRegistry, approvalSystem: approvalSystem2, activityLog, memory: null, eventBus, dataDir });
    approvalSystem2.reject(pendingId);
    const resumed = await planner2.resumeAfterApproval(created.id);

    assert.equal(resumed.status, 'failed');
    assert.equal(getCalls(), 0, 'a rejected step must never actually run');
  });
});
