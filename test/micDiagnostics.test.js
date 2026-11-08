import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMicInput } from '../public/js/voice/mic-diagnostics.js';

test('microphone diagnostic distinguishes silence, quiet input and working speech detection', () => {
  assert.equal(classifyMicInput({ peakRms: 0.0001 }).status, 'silent');
  assert.equal(classifyMicInput({ peakRms: 0.001 }).status, 'quiet');
  assert.equal(classifyMicInput({ peakRms: 0.02 }).status, 'signal');
  assert.equal(classifyMicInput({ peakRms: 0.02, speechEvents: 1 }).status, 'speech');
});
