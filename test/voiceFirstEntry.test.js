import test from 'node:test';
import assert from 'node:assert/strict';
import { currentRoute } from '../public/js/router.js';

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
