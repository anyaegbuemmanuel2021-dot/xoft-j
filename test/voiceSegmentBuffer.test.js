import test from 'node:test';
import assert from 'node:assert/strict';
import { RollingAudioBuffer } from '../public/js/voice/segment-buffer.js';

const chunk = (label) => ({ size: 1, label });

test('pre-roll includes audio captured immediately before VAD starts', () => {
  let now = 1000;
  const buffer = new RollingAudioBuffer({ preRollMs: 500, now: () => now });
  buffer.push(chunk('before-500ms'), 500);
  buffer.push(chunk('before-250ms'), 750);
  buffer.push(chunk('speech-start'), 1000);
  assert.equal(buffer.begin(), true);
  buffer.push(chunk('speech-continuation'), 1250);
  assert.deepEqual(buffer.finish().map((item) => item.label), [
    'before-500ms', 'before-250ms', 'speech-start', 'speech-continuation',
  ]);
});

test('pre-roll is bounded and stale chunks are excluded', () => {
  let now = 2000;
  const buffer = new RollingAudioBuffer({ preRollMs: 400, now: () => now });
  buffer.push(chunk('stale'), 1500);
  buffer.push(chunk('recent'), 1800);
  buffer.begin();
  assert.deepEqual(buffer.finish().map((item) => item.label), ['recent']);
  assert.equal(buffer.active, false);
});

test('overlapping begin calls do not duplicate or reset an active segment', () => {
  let now = 10;
  const buffer = new RollingAudioBuffer({ preRollMs: 500, now: () => now });
  buffer.begin();
  buffer.push(chunk('one'), now);
  assert.equal(buffer.begin(), false);
  buffer.push(chunk('two'), ++now);
  assert.deepEqual(buffer.finish().map((item) => item.label), ['one', 'two']);
  assert.deepEqual(buffer.finish(), []);
});

test('discard clears buffered audio and active segment state', () => {
  const buffer = new RollingAudioBuffer();
  buffer.push(chunk('old'));
  buffer.begin();
  buffer.discard();
  assert.equal(buffer.active, false);
  assert.deepEqual(buffer.finish(), []);
});
