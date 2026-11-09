import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/js/voice/speak-out.js', import.meta.url), 'utf8');

test('stopping speech aborts every in-flight server TTS request', () => {
  assert.match(source, /const activeTtsControllers = new Set\(\)/);
  assert.match(source, /for \(const controller of activeTtsControllers\) controller\.abort\(\)/);
  assert.match(source, /activeTtsControllers\.add\(controller\)/);
  assert.match(source, /activeTtsControllers\.delete\(controller\)/);
});
