import test from 'node:test';
import assert from 'node:assert/strict';
import { deterministicConversation } from '../src/executive/ExecutiveBrain.js';

test('handles common English greetings without an AI model', () => {
  assert.match(deterministicConversation('Good morning'), /ready to help/i);
  assert.match(deterministicConversation('hello xoft'), /I'm here/i);
});

test('handles common Nigerian Pidgin greetings locally', () => {
  assert.match(deterministicConversation('How far?'), /I dey here/i);
  assert.match(deterministicConversation('Wetin dey'), /How I fit help/i);
});

test('handles common Igbo greetings locally', () => {
  assert.match(deterministicConversation('Ndewo'), /Ndewo/i);
  assert.match(deterministicConversation('Kedu?'), /Kedu/i);
});

test('handles thanks, identity, help and presence without a model', () => {
  assert.match(deterministicConversation('Thank you'), /welcome/i);
  assert.match(deterministicConversation('Who are you?'), /XOFT/i);
  assert.match(deterministicConversation('help'), /deterministic logic first/i);
  assert.match(deterministicConversation('Are you there?'), /Yes/i);
});

test('does not guess or intercept unknown requests', () => {
  assert.equal(deterministicConversation('Can you build a school website?'), null);
  assert.equal(deterministicConversation(''), null);
  assert.equal(deterministicConversation('x'.repeat(101)), null);
});
