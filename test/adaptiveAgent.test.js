import test from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryEngine } from '../src/recovery/RecoveryEngine.js';

test('adaptive recovery rejects invented tools and new input fields', async () => {
  const registry = { schemasForAI: () => [{ name: 'safe_tool', description: 'safe', inputSchema: { type: 'object' } }], has: (n) => n === 'safe_tool' };
  const router = { complete: async () => ({ text: JSON.stringify({ strategy: 'alternative_tool', toolName: 'does_not_exist', inputPatch: {}, reason: 'x' }) }) };
  const engine = new RecoveryEngine({ router, toolRegistry: registry });
  const result = await engine.chooseStrategy({ goal: 'do x', step: { description: 'x', toolName: 'safe_tool', input: { a: 1 } }, error: new Error('failed') });
  assert.equal(result.strategy, 'abort');
});

test('adaptive recovery allows only existing input keys in patches', async () => {
  const registry = { schemasForAI: () => [], has: () => true };
  const router = { complete: async () => ({ text: JSON.stringify({ strategy: 'retry_with_adjusted_input', inputPatch: { secretNewField: true }, reason: 'x' }) }) };
  const engine = new RecoveryEngine({ router, toolRegistry: registry });
  const result = await engine.chooseStrategy({ goal: 'do x', step: { description: 'x', toolName: 'safe_tool', input: { a: 1 } }, error: new Error('failed') });
  assert.equal(result.strategy, 'abort');
});
