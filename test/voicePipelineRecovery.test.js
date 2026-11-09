import test from 'node:test';
import assert from 'node:assert/strict';
import { VoicePipeline } from '../public/js/voice/wake.js';

test('cancelling a risky voice command resumes continuous native listening', () => {
  const requests = [];
  const pipeline = new VoicePipeline({
    continuousRecognition: true,
    wantRecognizer: (on) => requests.push(on),
  });
  assert.equal(pipeline.start(), true);
  pipeline.transcript('hey xoft delete my files', true);
  assert.equal(pipeline.state, 'confirming');
  pipeline.cancel('cancelled by user');
  assert.equal(pipeline.state, 'wake_listening');
  assert.deepEqual(requests, [true, false, true]);
});

test('a confirmation timeout cancels the command and resumes continuous listening', () => {
  const requests = [];
  const pipeline = new VoicePipeline({
    continuousRecognition: true,
    confirmWindowMs: 5,
    wantRecognizer: (on) => requests.push(on),
  });
  pipeline.start();
  pipeline.transcript('hey xoft delete my files', true);
  pipeline.tick(Date.now() + 10);
  assert.equal(pipeline.state, 'wake_listening');
  assert.deepEqual(requests, [true, false, true]);
});
