import test from 'node:test';
import assert from 'node:assert/strict';
import { IntelligenceDirector } from '../src/intelligence/IntelligenceDirector.js';

function makeRouter() {
  return { complete: async () => ({ text: JSON.stringify({ score: 92, issues: [], summary: 'Plan is coherent.' }) }) };
}

test('IntelligenceDirector performs a deliberative preflight', async () => {
  const memory = {
    vectorEnabled: false,
    recallStructured: () => [{ id: 'm1', content: 'previous preference' }],
  };
  const reasoningEngine = {
    decompose: async () => ({ subproblems: [{ id: 'sp1', description: 'do the thing' }] }),
    detectUncertainty: async () => ({ uncertainties: [] }),
  };
  const confidenceEngine = { assess: async () => ({ score: 88, reasoning: 'Well grounded.' }) };
  const activity = { log: () => {} };
  const director = new IntelligenceDirector({ router: makeRouter(), reasoningEngine, confidenceEngine, memory, contextEngine: { describe: () => '{}' }, activityLog: activity });

  const result = await director.preflight('complete my task', {
    id: 't1',
    steps: [{ id: 'step1', description: 'do the thing', toolName: 'tool.one', dependsOn: [] }],
  });

  assert.equal(result.critique.score, 92);
  assert.equal(result.confidence.score, 88);
  assert.equal(result.recommendation, 'proceed');
  assert.equal(result.decomposition.subproblems.length, 1);
});

test('IntelligenceDirector learns from failures without throwing', async () => {
  const remembered = [];
  const director = new IntelligenceDirector({
    router: {}, reasoningEngine: {}, confidenceEngine: {},
    memory: { remember: async (...args) => remembered.push(args) },
    activityLog: { log: () => {} },
  });
  const result = await director.learn('ship the release', {
    id: 't2', status: 'failed',
    steps: [
      { status: 'completed', description: 'build', error: null },
      { status: 'failed', description: 'publish', error: 'network timeout' },
    ],
  });
  assert.equal(result.failed, 1);
  assert.equal(remembered.length, 1);
  assert.equal(remembered[0][0], 'execution_outcome');
});
