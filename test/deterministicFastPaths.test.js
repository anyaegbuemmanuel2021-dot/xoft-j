import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutiveBrain } from '../src/executive/ExecutiveBrain.js';

function makeBrain() {
  const calls = { model: 0, tools: 0, turns: [] };
  const brain = new ExecutiveBrain({
    router: { complete: async () => { calls.model += 1; throw new Error('AI must not be called'); } },
    memory: { addTurn: (...turn) => calls.turns.push(turn) },
    orchestrator: { handle: async () => ({ action: 'delegate', reply: 'delegated' }) },
    taskPlanner: { toolRegistry: { execute: async () => { calls.tools += 1; return {}; } }, cancel: () => {} },
    approvalSystem: { listPending: () => [] },
    worldState: { describe: () => '', snapshot: () => ({}) },
    activityLog: { log: () => {} },
  });
  return { brain, calls };
}

test('common greetings and help are handled before AI classification', async () => {
  const { brain, calls } = makeBrain();
  const greeting = await brain.handle('s1', 'How far?');
  const help = await brain.handle('s1', 'help');
  assert.match(greeting.reply, /I dey here/i);
  assert.match(help.reply, /deterministic logic first/i);
  assert.equal(greeting.meta.modelUsed, false);
  assert.equal(calls.model, 0);
  assert.equal(calls.tools, 0);
});

test('supported unit conversions are handled before AI classification', async () => {
  const { brain, calls } = makeBrain();
  const result = await brain.handle('s2', 'convert 10 km to miles');
  assert.equal(result.reply, '10 km = 6.2137 mi');
  assert.equal(result.meta.deterministic, true);
  assert.equal(calls.model, 0);
  assert.equal(calls.tools, 0);
});

test('unsupported conversions continue to the existing orchestrator', async () => {
  const { brain, calls } = makeBrain();
  const result = await brain.handle('s3', 'convert 5 naira to dollars');
  assert.equal(result.reply, 'delegated');
  assert.equal(calls.model, 0);
  assert.equal(calls.tools, 0);
});
