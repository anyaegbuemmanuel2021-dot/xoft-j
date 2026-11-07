import test from 'node:test';
import assert from 'node:assert/strict';
import { currentRoute } from '../public/js/router.js';
import { claimAutoVoiceStart } from '../public/js/voice/auto-start.js';
import { createSpeechGate } from '../public/js/voice/listen.js';

test('opening XOFT without a route starts on the live conversation workspace', () => {
  const previous = globalThis.location;
  globalThis.location = { hash: '' };
  try {
    assert.equal(currentRoute(), 'chat');
  } finally {
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
  }
});

test('an explicitly selected route is preserved', () => {
  const previous = globalThis.location;
  globalThis.location = { hash: '#tasks' };
  try {
    assert.equal(currentRoute(), 'tasks');
  } finally {
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
  }
});

test('automatic voice startup is claimed only once during a page load', () => {
  assert.equal(claimAutoVoiceStart(), true);
  assert.equal(claimAutoVoiceStart(), false);
});


test('mobile voice gate accepts quiet speech while retaining adaptive noise-floor calibration', () => {
  const gate = createSpeechGate({ minThreshold: 0.005, floorMultiplier: 2.5 });
  assert.equal(gate.update(0.006), true);
  assert.equal(gate.threshold, 0.005);
});
