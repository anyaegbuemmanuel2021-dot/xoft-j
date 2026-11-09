import test from 'node:test';
import assert from 'node:assert/strict';
import { deterministicConversation } from '../src/executive/ExecutiveBrain.js';

test('handles English greetings, thanks, identity, help and presence locally', () => {
  assert.match(deterministicConversation('Good morning'), /ready to help/i);
  assert.match(deterministicConversation('Thank you'), /welcome/i);
  assert.match(deterministicConversation('Who are you?'), /XOFT/i);
  assert.match(deterministicConversation('help'), /deterministic logic first/i);
  assert.match(deterministicConversation('Are you there?'), /Yes/i);
});

test('handles common Nigerian Pidgin and Igbo greetings locally', () => {
  assert.match(deterministicConversation('How far?'), /I dey here/i);
  assert.match(deterministicConversation('Wetin dey'), /How I fit help/i);
  assert.match(deterministicConversation('Ndewo'), /Ndewo/i);
  assert.match(deterministicConversation('Kedu?'), /Kedu/i);
});

test('does not intercept unknown or oversized requests', () => {
  assert.equal(deterministicConversation('Can you build a school website?'), null);
  assert.equal(deterministicConversation(''), null);
  assert.equal(deterministicConversation('x'.repeat(101)), null);
});
