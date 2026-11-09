import test from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../src/orchestrator/Orchestrator.js';

function makeMemory(entries = []) {
  const turns = [];
  let semanticCalls = 0;
  return {
    turns,
    get semanticCalls() { return semanticCalls; },
    addTurn(sessionId, role, content) { turns.push({ sessionId, role, content }); },
    recallStructured() { return entries; },
    async recallSemantic() { semanticCalls += 1; throw new Error('Embedding provider must not be called'); },
  };
}

test('explicit memory recall uses local structured memory without embedding providers', async () => {
  const memory = makeMemory([{ id: '1', content: 'XOFT is my assistant project.' }]);
  const orchestrator = new Orchestrator({ router: {}, memory });
  const result = await orchestrator.handle('test-session', 'What do you remember about XOFT?');

  assert.match(result.reply, /XOFT is my assistant project/);
  assert.equal(memory.semanticCalls, 0);
  assert.equal(result.intent, 'recall');
});

test('explicit memory recall reports empty local results without model calls', async () => {
  const memory = makeMemory([]);
  const orchestrator = new Orchestrator({ router: {}, memory });
  const result = await orchestrator.handle('test-session', 'Show my memories');

  assert.match(result.reply, /don't have anything stored/i);
  assert.equal(memory.semanticCalls, 0);
});
