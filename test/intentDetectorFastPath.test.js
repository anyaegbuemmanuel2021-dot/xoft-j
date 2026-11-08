import test from 'node:test';
import assert from 'node:assert/strict';
import { IntentDetector, Intent } from '../src/orchestrator/IntentDetector.js';

test('ordinary conversation bypasses all model-based intent classification', async () => {
  const detector = new IntentDetector({ complete: async () => { throw new Error('no model call expected'); } });
  const result = await detector.detect('Hey XOFT, how are you today?');
  assert.equal(result.intent, Intent.CONVERSATION);
  assert.equal(result.category, null);
});

test('explicit memory requests are classified deterministically without a model router', async () => {
  const detector = new IntentDetector({ complete: async () => { throw new Error('memory intent must not call a model'); } });
  const result = await detector.detect('Please remember my exam is Friday.');
  assert.equal(result.intent, Intent.REMEMBER);
  assert.equal(result.category, 'fact');
  assert.equal(result.subject, 'my exam is Friday');
});

test('ambiguous memory wording and broad destructive requests fail safely to conversation', async () => {
  const detector = new IntentDetector({ complete: async () => { throw new Error('ambiguous input must not call a model'); } });
  const ambiguous = await detector.detect('I cannot remember the password');
  assert.equal(ambiguous.intent, Intent.CONVERSATION);
  const broad = await detector.detect('Forget everything');
  assert.equal(broad.intent, Intent.CONVERSATION);
  const recall = await detector.detect('What do you remember about my project?');
  assert.equal(recall.intent, Intent.RECALL);
  assert.equal(recall.category, 'project');
});
