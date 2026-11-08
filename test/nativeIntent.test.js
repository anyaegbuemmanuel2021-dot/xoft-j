import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutiveAction, fastClassify, ExecutiveClassifier } from '../src/executive/ExecutiveClassifier.js';
import { Intent, IntentDetector } from '../src/orchestrator/IntentDetector.js';

test('executive classification uses deterministic rules without a model router', async () => {
  const classifier = new ExecutiveClassifier();
  assert.equal((await classifier.classify('What time is it?')).action, ExecutiveAction.DELEGATE);
  assert.equal((await classifier.classify('Please send an email to John')).action, ExecutiveAction.GOAL);
  assert.equal((await classifier.classify('I am stuck, any ideas?')).action, ExecutiveAction.ADVISE);
  assert.equal((await classifier.classify('What should I be doing now?')).action, ExecutiveAction.WORLD_STATE);
  assert.equal((await classifier.classify('Do it')).action, ExecutiveAction.CONFIRM);
  assert.equal((await classifier.classify('Cancel that')).action, ExecutiveAction.CANCEL);
});

test('ambiguous acknowledgements never become approval', () => {
  assert.equal(fastClassify('okay').action, ExecutiveAction.DELEGATE);
  assert.equal(fastClassify('sure').action, ExecutiveAction.DELEGATE);
});

test('memory intents use explicit phrases without a model router', async () => {
  const detector = new IntentDetector();
  assert.deepEqual(await detector.detect('Remember that my meeting is Friday'), {
    intent: Intent.REMEMBER, category: 'fact', subject: 'my meeting is Friday',
  });
  assert.deepEqual(await detector.detect('What do you remember about my project?'), {
    intent: Intent.RECALL, category: 'project', subject: 'my project',
  });
  assert.deepEqual(await detector.detect('Forget about the old project'), {
    intent: Intent.FORGET, category: 'project', subject: 'the old project',
  });
  assert.equal((await detector.detect('I cannot remember the password')).intent, Intent.CONVERSATION);
  assert.equal((await detector.detect('Forget everything')).intent, Intent.CONVERSATION);
});
