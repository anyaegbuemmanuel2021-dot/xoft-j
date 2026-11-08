import test from 'node:test';
import assert from 'node:assert/strict';
import { Intent, IntentDetector } from '../src/orchestrator/IntentDetector.js';

test('explicit memory intents are deterministic and safe', async () => {
  const detector = new IntentDetector();
  assert.deepEqual(await detector.detect('Remember that my meeting is Friday'), { intent: Intent.REMEMBER, category: 'fact', subject: 'my meeting is Friday' });
  assert.deepEqual(await detector.detect('What do you remember about my project?'), { intent: Intent.RECALL, category: 'project', subject: 'my project' });
  assert.deepEqual(await detector.detect('Forget about the old project'), { intent: Intent.FORGET, category: 'project', subject: 'the old project' });
  assert.equal((await detector.detect('I cannot remember the password')).intent, Intent.CONVERSATION);
  assert.equal((await detector.detect('Forget everything')).intent, Intent.CONVERSATION);
  assert.equal((await detector.detect('Hey XOFT, kindly remember that I prefer concise replies')).intent, Intent.REMEMBER);
  assert.equal((await detector.detect('Forget everything about my old project')).subject, 'my old project');
});
