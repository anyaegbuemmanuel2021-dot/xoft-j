import test from 'node:test';
import assert from 'node:assert/strict';
import { IntentDetector, Intent } from '../src/orchestrator/IntentDetector.js';

test('ordinary conversation bypasses the extra model-based intent call', async () => {
  let calls = 0;
  const detector = new IntentDetector({
    complete: async () => {
      calls += 1;
      throw new Error('should not classify ordinary conversation');
    },
  });

  const result = await detector.detect('Hey XOFT, how are you today?');
  assert.equal(result.intent, Intent.CONVERSATION);
  assert.equal(result.category, null);
  assert.equal(calls, 0);
});

test('explicit remember commands use deterministic logic without an AI call', async () => {
  let calls = 0;
  const detector = new IntentDetector({ complete: async () => { calls += 1; throw new Error('AI must not be called'); } });
  const result = await detector.detect('Please remember my exam is Friday.');
  assert.deepEqual(result, { intent: Intent.REMEMBER, category: 'fact', subject: 'my exam is Friday' });
  assert.equal(calls, 0);
});

test('explicit forget commands normalize the target and bypass AI', async () => {
  let calls = 0;
  const detector = new IntentDetector({ complete: async () => { calls += 1; throw new Error('AI must not be called'); } });
  const result = await detector.detect('XOFT, please forget everything about my old project.');
  assert.deepEqual(result, { intent: Intent.FORGET, category: null, subject: 'my old project' });
  assert.equal(calls, 0);
});

test('explicit recall commands use deterministic logic without an AI call', async () => {
  let calls = 0;
  const detector = new IntentDetector({ complete: async () => { calls += 1; throw new Error('AI must not be called'); } });
  const result = await detector.detect('What do you remember about my project?');
  assert.deepEqual(result, { intent: Intent.RECALL, category: null, subject: 'my project' });
  assert.equal(calls, 0);
});

test('ambiguous memory-related language still uses the classifier', async () => {
  let calls = 0;
  const detector = new IntentDetector({
    complete: async (_task, request) => {
      calls += 1;
      assert.match(request.messages[0].content, /I keep forgetting where I put my notes/i);
      return { text: JSON.stringify({ intent: 'conversation', category: null, subject: null }) };
    },
  });
  const result = await detector.detect('I keep forgetting where I put my notes.');
  assert.equal(result.intent, Intent.CONVERSATION);
  assert.equal(calls, 1);
});

test('a failed or malformed memory classification fails safely to conversation', async () => {
  const detector = new IntentDetector({
    complete: async () => ({ text: 'not valid JSON' }),
  });
  const result = await detector.detect('I have a memory question but cannot explain it clearly.');
  assert.equal(result.intent, Intent.CONVERSATION);
  assert.equal(result.category, null);
});
