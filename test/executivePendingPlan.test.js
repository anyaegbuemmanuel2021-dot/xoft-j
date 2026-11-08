import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutiveBrain } from '../src/executive/ExecutiveBrain.js';

describe('ExecutiveBrain pending plan lifecycle', () => {
  test('a new goal cancels an older proposal even when the new goal is blocked', async () => {
    const cancelled = [];
    const plans = [
      { id: 'old-plan', status: 'planned', steps: [{ id: 'step-1' }] },
      { id: 'new-blocked-plan', status: 'blocked', steps: [], blockedReason: 'No matching tool.' },
    ];
    let executions = 0;
    const taskPlanner = {
      async plan() { return plans.shift(); },
      previewPlan() { return { requiresApproval: true, text: 'Delete files', maxRiskName: 'high' }; },
      cancel(id) { cancelled.push(id); return { id, status: 'cancelled' }; },
      async execute() { executions += 1; return { id: 'old-plan', status: 'completed', goal: 'old', steps: [] }; },
    };
    const brain = new ExecutiveBrain({
      router: {},
      memory: { addTurn() {} },
      orchestrator: {},
      taskPlanner,
      approvalSystem: { listPending() { return []; } },
      worldState: { describe() { return ''; } },
      activityLog: { log() {} },
    });

    const first = await brain._handleGoal('session-a', 'delete old files');
    assert.equal(first.meta.awaitingConfirmation, true);

    const second = await brain._handleGoal('session-a', 'do an unsupported task');
    assert.equal(second.meta.task.status, 'blocked');
    assert.deepEqual(cancelled, ['old-plan']);

    const confirmation = await brain._handleConfirm('session-a');
    assert.match(confirmation.reply, /no active plan/i);
    assert.equal(executions, 0, 'the superseded high-risk plan must never execute');
  });
});
