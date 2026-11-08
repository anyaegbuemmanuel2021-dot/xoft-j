import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutiveBrain } from '../src/executive/ExecutiveBrain.js';

function makeBrain() {
  const calls = { model: 0, execute: [] };
  const memory = { addTurn: () => {} };
  const brain = new ExecutiveBrain({
    router: { complete: async () => { calls.model += 1; throw new Error('AI must not be called for explicit arithmetic'); } },
    memory,
    orchestrator: { handle: async () => ({ action: 'delegate', reply: 'delegated' }) },
    taskPlanner: {
      toolRegistry: {
        execute: async (name, input) => {
          calls.execute.push({ name, input });
          if (name === 'get_current_time') return { formatted: '11/8/2026, 5:00:00 PM', timezone: 'Africa/Lagos' };
          const result = Function('"use strict"; return (' + input.expression + ')')();
          return { expression: input.expression, result };
        },
      },
      cancel: () => {},
    },
    approvalSystem: { listPending: () => [] },
    worldState: { describe: () => '', snapshot: () => ({}) },
    activityLog: { log: () => {} },
  });
  return { brain, calls };
}

test('explicit arithmetic requests execute the registered calculator without an AI call', async () => {
  const { brain, calls } = makeBrain();
  const result = await brain.handle('session-1', 'Hey XOFT, calculate 12 plus 3.');
  assert.equal(result.action, 'tool');
  assert.equal(result.reply, '12 + 3 = 15');
  assert.equal(result.meta.deterministic, true);
  assert.deepEqual(calls.execute, [{ name: 'calculate', input: { expression: '12 + 3' } }]);
  assert.equal(calls.model, 0);
});

test('natural-language arithmetic is normalized and routed deterministically', async () => {
  const { brain, calls } = makeBrain();
  const result = await brain.handle('session-2', 'What is 18 divided by 3?');
  assert.equal(result.reply, '18 / 3 = 6');
  assert.equal(calls.model, 0);
});

test('ordinary conversation does not invoke the calculator', async () => {
  const { brain, calls } = makeBrain();
  const result = await brain.handle('session-3', 'How are you today?');
  assert.equal(result.reply, 'delegated');
  assert.equal(calls.execute.length, 0);
  assert.equal(calls.model, 0);
});

test('explicit date and time questions use the registered utility without an AI call', async () => {
  const { brain, calls } = makeBrain();
  const result = await brain.handle('session-4', 'Hey XOFT, what time is it?');
  assert.equal(result.action, 'tool');
  assert.match(result.reply, /Africa\\/Lagos/);
  assert.deepEqual(calls.execute, [{ name: 'get_current_time', input: {} }]);
  assert.equal(calls.model, 0);
});
