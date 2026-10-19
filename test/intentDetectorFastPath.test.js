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

test('memory-related requests still use the classifier', async () => {
  let calls = 0;
  const detector = new IntentDetector({
    complete: async (_task, request) => {
      calls += 1;
      assert.match(request.messages[0].content, /remember my exam is Friday/i);
      return { text: JSON.stringify({ intent: 'remember', category: 'fact', subject: 'exam' }) };
    },
  });

  const result = await detector.detect('Please remember my exam is Friday.');
  assert.equal(result.intent, Intent.REMEMBER);
  assert.equal(result.category, 'fact');
  assert.equal(calls, 1);
});

test('a failed or malformed memory classification fails safely to conversation', async () => {
  const detector = new IntentDetector({
    complete: async () => ({ text: 'not valid JSON' }),
  });
  const result = await detector.detect('What do you remember about my project?');
  assert.equal(result.intent, Intent.CONVERSATION);
  assert.equal(result.category, null);
});
