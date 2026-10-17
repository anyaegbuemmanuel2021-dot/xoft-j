import test from 'node:test';
import assert from 'node:assert/strict';
import { MissionScheduler } from '../src/scheduler/MissionScheduler.js';
import { Watchdog } from '../src/watchdog/Watchdog.js';
import { assessDrift, assessTaskDrift } from '../src/missions/GoalDrift.js';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const fakeManager = (missions, { stuck = [], run = async () => ({ status: 'completed' }) } = {}) => ({
  list: () => missions, budgetState: (m) => ({ exhausted: (m.usage?.runs ?? 0) >= 5 ? 'runs' : null }), isStuck: (m) => stuck.includes(m.id), run,
});
const M = (id, o = {}) => ({ id, goal: id, status: 'planned', priority: 3, usage: { runs: 0, failures: 0 }, ...o });

test('scheduler ranks by priority, deadline urgency, failures; explains skips', () => {
  const ms = [M('low', { priority: 1 }), M('high', { priority: 5 }), M('due', { priority: 3, deadline: '2026-09-28T12:30:00Z' }),
    M('flaky', { priority: 5, usage: { runs: 2, failures: 3 } }), M('paused', { status: 'paused' }), M('spent', { usage: { runs: 5, failures: 0 } }), M('stuck1')];
  const s = new MissionScheduler({ manager: fakeManager(ms, { stuck: ['stuck1'] }), now: () => NOW });
  const { ranked, skipped } = s.rank();
  assert.deepEqual(ranked.map((r) => r.id), ['high', 'due', 'flaky', 'low'].sort((a, b) => ranked.findIndex((r) => r.id === a) - ranked.findIndex((r) => r.id === b)));
  assert.equal(ranked[0].id, 'high'); assert.equal(ranked[1].id, 'due');
  assert.ok(ranked.findIndex((r) => r.id === 'flaky') > ranked.findIndex((r) => r.id === 'due'), 'failures push it down');
  const reasons = Object.fromEntries(skipped.map((x) => [x.id, x.reason]));
  assert.match(reasons.paused, /paused/); assert.match(reasons.spent, /budget/); assert.match(reasons.stuck1, /stuck/);
});

test('scheduler: nothing runs during emergency stop or with no healthy provider', () => {
  const ms = [M('a')];
  assert.equal(new MissionScheduler({ manager: fakeManager(ms) }).next({ emergency: true }), null);
  assert.equal(new MissionScheduler({ manager: fakeManager(ms), isProviderAvailable: () => false }).next(), null);
});

test('scheduler runBatch: runs concurrently but bounded, isolates failures, keeps input order', async () => {
  let active = 0; let peak = 0;
  const run = async (id) => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 15)); active -= 1; if (id === 'bad') throw new Error('boom'); return { status: 'completed' }; };
  const s = new MissionScheduler({ manager: fakeManager([], { run }) });
  const res = await s.runBatch(['a', 'b', 'bad', 'c', 'd', 'e'], { concurrency: 2 });
  assert.deepEqual(res.map((r) => r.id), ['a', 'b', 'bad', 'c', 'd', 'e']);
  assert.equal(res[2].ok, false); assert.equal(res[0].ok, true);
  assert.equal(peak, 2);
  const par = await (async () => { const t = Date.now(); await new MissionScheduler({ manager: fakeManager([], { run }) }).runBatch(['1', '2', '3', '4'], { concurrency: 4 }); return Date.now() - t; })();
  assert.ok(par < 50, `4 parallel 15ms jobs took ${par}ms`);
});

function wd({ mem = 50, disk = 50, provs = [{ configured: true, status: 'AVAILABLE' }], missions = [], emergency = false, ws = true } = {}) {
  const paused = [];
  const manager = { list: () => missions, isStuck: () => false, pause: (id, reason) => { paused.push([id, reason]); } };
  return { paused, dog: new Watchdog({
    telemetry: { snapshot: () => ({ memory: { usedPercent: mem }, storage: { usedPercent: disk }, cpu: { percent: 10 } }) },
    providerOverview: async () => provs, missionManager: manager, emergencyStop: { isActive: () => emergency },
    realtime: () => ({ available: ws, clients: 1 }), taskQueueStatus: () => ({ running: [], pending: [] }),
  }) };
}

test('diagnostics: HEALTHY / DEGRADED / WARNING / CRITICAL from real inputs', async () => {
  assert.equal((await wd().dog.diagnose()).overall, 'HEALTHY');
  assert.equal((await wd({ ws: false }).dog.diagnose()).overall, 'DEGRADED');
  assert.equal((await wd({ mem: 92 }).dog.diagnose()).overall, 'WARNING');
  assert.equal((await wd({ emergency: true }).dog.diagnose()).overall, 'WARNING');
  assert.equal((await wd({ mem: 99 }).dog.diagnose()).overall, 'CRITICAL');
  assert.equal((await wd({ provs: [{ configured: true, status: 'UNAVAILABLE' }] }).dog.diagnose()).overall, 'CRITICAL');
  assert.equal((await wd({ provs: [{ configured: true, status: 'UNAVAILABLE' }, { configured: true, status: 'AVAILABLE' }] }).dog.diagnose()).overall, 'DEGRADED');
});

test('watchdog pauses active missions on CRITICAL, leaves them alone otherwise', async () => {
  const ms = [{ id: 'a', status: 'planned' }, { id: 'b', status: 'completed' }, { id: 'c', status: 'cancelled' }];
  const bad = wd({ mem: 99, missions: ms });
  const r = await bad.dog.tick();
  assert.deepEqual(r.pausedMissions, ['a']); assert.match(bad.paused[0][1], /^watchdog: memory/);
  const ok = wd({ missions: ms }); await ok.dog.tick(); assert.equal(ok.paused.length, 0);
});

test('goal drift heuristic flags unrelated actions, passes related ones, and says it is heuristic', () => {
  const related = assessDrift('keep my website healthy', 'run website health check');
  assert.equal(related.drift, false);
  const off = assessDrift('keep my website healthy', 'order pizza delivery for dinner');
  assert.equal(off.drift, true); assert.equal(off.heuristic, true);
  assert.equal(assessDrift('', 'x').drift, false);
  const t = assessTaskDrift('keep my website healthy', { steps: [{ id: 's1', description: 'check website health' }, { id: 's2', description: 'book flight tickets' }] });
  assert.deepEqual(t.flagged, ['s2']);
});
