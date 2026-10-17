import test from 'node:test';
import assert from 'node:assert/strict';
import { ProactiveEngine } from '../src/proactive/ProactiveEngine.js';

function worldWith(batteryPct, online = true) {
  return {
    snapshot: () => ({
      devices: [{ id: 'dev1', name: 'Laptop', online, state: { battery: batteryPct } }],
      approvals: [],
    }),
  };
}

test('ProactiveEngine does not re-fire a suggestion while the condition is still active', () => {
  const engine = new ProactiveEngine({ worldState: worldWith(10) });
  engine.evaluate();
  engine.evaluate();
  assert.equal(engine.list().length, 1, 'same low-battery condition should not create duplicate suggestions');
});

test('ProactiveEngine can re-fire after the condition resolves and recurs (regression test for stale dedup bug)', () => {
  const state = { battery: 10 };
  const engine = new ProactiveEngine({
    worldState: { snapshot: () => ({ devices: [{ id: 'dev1', name: 'Laptop', online: true, state }], approvals: [] }) },
  });

  engine.evaluate();
  assert.equal(engine.list().length, 1);

  // Condition resolves (battery charged back up)
  state.battery = 80;
  engine.evaluate();

  // Condition recurs later
  state.battery = 8;
  engine.evaluate();

  assert.equal(engine.list().length, 2, 'a resolved-then-recurring condition must be able to raise a new suggestion');
});

test('dismissing a suggestion clears its key so it can fire again immediately', () => {
  const engine = new ProactiveEngine({ worldState: worldWith(5) });
  engine.evaluate();
  const [s] = engine.list();
  engine.dismiss(s.id);
  engine.evaluate();
  assert.equal(engine.list({ status: 'new' }).length, 1);
});
