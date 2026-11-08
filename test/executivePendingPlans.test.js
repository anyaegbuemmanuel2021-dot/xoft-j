import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutiveBrain } from '../src/executive/ExecutiveBrain.js';

function makeBrain(dataDir, statuses = {}) {
  const taskPlanner = {
    get(id) {
      const status = statuses[id];
      if (!status) throw new Error('task not found');
      return { id, status };
    },
  };
  return new ExecutiveBrain({
    router: {},
    memory: {},
    orchestrator: {},
    taskPlanner,
    approvalSystem: {},
    worldState: {},
    activityLog: { log() {} },
    dataDir,
  });
}

describe('ExecutiveBrain — durable pending confirmations', () => {
  test('restores a pending plan for a still-planned task after restart', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-pending-plans-'));
    const first = makeBrain(dataDir, { task1: 'planned' });
    first._setPendingPlan('session-1', { taskId: 'task1', goal: 'Open my project', createdAt: '2026-11-08T10:00:00.000Z' });

    const restarted = makeBrain(dataDir, { task1: 'planned' });
    assert.deepEqual(restarted._pendingPlans.get('session-1'), {
      taskId: 'task1',
      goal: 'Open my project',
      createdAt: '2026-11-08T10:00:00.000Z',
    });
  });

  test('drops stale, missing, and already-running task confirmations on restart', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-pending-plans-'));
    const first = makeBrain(dataDir, { planned: 'planned', running: 'planned', missing: 'planned' });
    first._setPendingPlan('keep', { taskId: 'planned', goal: 'keep me' });
    first._setPendingPlan('running', { taskId: 'running', goal: 'do not replay' });
    first._setPendingPlan('missing', { taskId: 'missing', goal: 'stale' });

    const restarted = makeBrain(dataDir, { planned: 'planned', running: 'running' });
    assert.equal(restarted._pendingPlans.has('keep'), true);
    assert.equal(restarted._pendingPlans.has('running'), false);
    assert.equal(restarted._pendingPlans.has('missing'), false);
  });

  test('deleting a pending confirmation persists its removal', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-pending-plans-'));
    const first = makeBrain(dataDir, { task1: 'planned' });
    first._setPendingPlan('session-1', { taskId: 'task1', goal: 'Open my project' });
    first._deletePendingPlan('session-1');

    const restarted = makeBrain(dataDir, { task1: 'planned' });
    assert.equal(restarted._pendingPlans.has('session-1'), false);
  });
});
