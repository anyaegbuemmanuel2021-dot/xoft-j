import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechGate, recordedMimeType } from '../public/js/voice/listen.js';

test('voice gate detects a quiet utterance after room-noise calibration', () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const gate = createSpeechGate({ minThreshold: 0.002, floorMultiplier: 2.5 });
    // Simulate a quiet room during the calibration window.
    for (let i = 0; i < 6; i += 1) gate.update(0.0004);
    now = 1_600;
    assert.equal(gate.update(0.003), true, 'quiet speech should cross the calibrated threshold');
    assert.ok(gate.threshold <= 0.002, 'the threshold must not suppress low-volume speech');
  } finally {
    Date.now = originalNow;
  }
});

test('recorded MIME prefers the actual recorder value including codec parameters', () => {
  assert.equal(recordedMimeType({ mimeType: 'audio/mp4;codecs=mp4a.40.2' }, { mimeType: 'audio/webm' }), 'audio/mp4;codecs=mp4a.40.2');
});

test('recorded MIME falls back to selected options when the recorder omits its type', () => {
  assert.equal(recordedMimeType({ mimeType: '' }, { mimeType: 'audio/ogg;codecs=opus' }), 'audio/ogg;codecs=opus');
});

test('recorded MIME uses WebM only when no type is available', () => {
  assert.equal(recordedMimeType({}, {}), 'audio/webm');
});
