import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MissionManager } from '../src/missions/MissionManager.js';

function setup({ results = [], emergency = false, budget } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'));
  let call = 0; let clock = 1_000_000;
  const taskPlanner = {
    plan: async () => ({ id: 't1' }),
    execute: async () => { const r = results[Math.min(call, results.length - 1)]; call += 1; clock += 10; if (r instanceof Error) throw r; return r; },
  };
  const events = [];
  const mm = new MissionManager({ taskPlanner, dataDir, emergencyStop: { isActive: () => emergency }, eventBus: { emitEvent: (t, p) => events.push([t, p]) }, now: () => clock });
  return { mm, dataDir, events, calls: () => call, mission: mm.create('goal', { budget }) };
}

test('successful run records usage and history; old missions without budget still load', async () => {
  const { mm, mission } = setup({ results: [{ status: 'completed' }] });
  const out = await mm.run(mission.id);
  assert.equal(out.status, 'completed');
  assert.deepEqual([out.usage.runs, out.usage.failures], [1, 0]);
  assert.equal(out.history.length, 1);
  // legacy record (as saved by the previous MissionManager)
  const d = mm._load(); d.missions.push({ id: 'old', goal: 'g', status: 'planned', taskId: 't', createdAt: 'x', updatedAt: 'x' }); mm._save(d);
  const legacy = mm.list().find((m) => m.id === 'old');
  assert.equal(legacy.budget.maxRuns, 5); assert.equal(legacy.usage.runs, 0);
});

test('state persists across a restart (new manager, same data dir)', async () => {
  const { mm, mission, dataDir } = setup({ results: [{ status: 'failed', error: 'x' }] });
  await mm.run(mission.id);
  const again = new MissionManager({ taskPlanner: {}, dataDir });
  assert.equal(again.get(mission.id).usage.failures, 1);
});

test('run budget exhausted: mission pauses, planner is NOT called again, resume needs an explicit extension', async () => {
  const { mm, mission, calls, events } = setup({ results: [{ status: 'completed' }], budget: { maxRuns: 2 } });
  await mm.run(mission.id); await mm.run(mission.id);
  await assert.rejects(() => mm.run(mission.id), /budget exhausted/);
  assert.equal(calls(), 2, 'no third execution');
  assert.equal(mm.get(mission.id).status, 'paused');
  assert.ok(events.some(([t]) => t === 'mission.paused'));
  await assert.rejects(async () => mm.resume(mission.id), /still exhausted/);
  mm.resume(mission.id, { extendBudget: { maxRuns: 4 } });
  const out = await mm.run(mission.id);
  assert.equal(out.usage.runs, 3);
});

test('failure budget pauses the mission', async () => {
  const { mm, mission } = setup({ results: [new Error('a'), new Error('b'), new Error('c')], budget: { maxFailures: 2, maxRuns: 10 } });
  await mm.run(mission.id); await mm.run(mission.id);
  await assert.rejects(() => mm.run(mission.id), /failures \(2\/2\)/);
});

test('runtime budget is enforced from measured runtime', async () => {
  const { mm, mission } = setup({ results: [{ status: 'completed' }], budget: { maxRuntimeMs: 15, maxRuns: 10 } });
  await mm.run(mission.id); await mm.run(mission.id);
  await assert.rejects(() => mm.run(mission.id), /runtime/);
});

test('stuck detection: 3 identical failures in a row pause the mission instead of a 4th identical attempt', async () => {
  const { mm, mission, calls } = setup({ results: [new Error('missing env var')], budget: { maxRuns: 10, maxFailures: 10 } });
  for (let i = 0; i < 3; i += 1) await mm.run(mission.id);
  await assert.rejects(() => mm.run(mission.id), /stuck/);
  assert.equal(calls(), 3);
  assert.match(mm.get(mission.id).pausedReason, /^stuck/);
  mm.resume(mission.id);
  await mm.run(mission.id); // a deliberate human-approved retry is allowed
  assert.equal(calls(), 4);
});

test('different failures are not "stuck"; a success breaks the streak', async () => {
  const { mm, mission } = setup({ results: [new Error('a'), new Error('b'), new Error('a'), { status: 'completed' }], budget: { maxRuns: 10, maxFailures: 10 } });
  for (let i = 0; i < 4; i += 1) await mm.run(mission.id);
  assert.equal(mm.get(mission.id).status, 'completed');
});

test('paused/cancelled/emergency-stopped missions do not execute', async () => {
  const s = setup({ results: [{ status: 'completed' }] });
  s.mm.pause(s.mission.id);
  await assert.rejects(() => s.mm.run(s.mission.id), /paused/);
  const c = setup({ results: [{ status: 'completed' }] }); c.mm.cancel(c.mission.id);
  await assert.rejects(() => c.mm.run(c.mission.id), /cancelled/);
  const e = setup({ results: [{ status: 'completed' }], emergency: true });
  await assert.rejects(() => e.mm.run(e.mission.id), /Emergency stop/);
  assert.equal(e.calls(), 0);
});

test('resume of a non-paused mission is rejected; pause of a cancelled mission is rejected', () => {
  const { mm, mission } = setup({ results: [{ status: 'completed' }] });
  assert.throws(() => mm.resume(mission.id), /not paused/);
  mm.cancel(mission.id);
  assert.throws(() => mm.pause(mission.id), /Cannot pause/);
});
