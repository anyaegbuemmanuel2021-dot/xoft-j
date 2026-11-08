import test from 'node:test';
import assert from 'node:assert/strict';
import * as privacy from '../src/privacy/PrivacyClassifier.js';
import { ProviderRouter } from '../src/providers/ProviderRouter.js';

test('classifies levels', () => {
  assert.equal(privacy.classify('what is the capital of France'), 'PUBLIC');
  assert.equal(privacy.classify('this is confidential'), 'INTERNAL');
  assert.equal(privacy.classify('mail me at bob@example.com'), 'PRIVATE');
  assert.equal(privacy.classify('ssn 123-45-6789'), 'SENSITIVE');
  assert.equal(privacy.classify('card 4111 1111 1111 1111'), 'SENSITIVE');
  assert.equal(privacy.classify('card 4111 1111 1111 1112'), 'PUBLIC', 'fails Luhn -> not a card');
  assert.equal(privacy.classify('key sk-abcdefghijklmnopqrstuvwx'), 'SECRET');
  assert.equal(privacy.classify('-----BEGIN RSA PRIVATE KEY-----'), 'SECRET');
  assert.equal(privacy.classify('password: hunter22222'), 'SECRET');
  assert.equal(privacy.classify('AKIAABCDEFGHIJKLMNOP'), 'SECRET');
});

test('explicit level can raise but never lower', () => {
  assert.equal(privacy.classifyParams({ messages: [{ role: 'user', content: 'hi' }], privacy: 'SENSITIVE' }), 'SENSITIVE');
  assert.equal(privacy.classifyParams({ messages: [{ role: 'user', content: 'sk-abcdefghijklmnopqrstuvwx' }], privacy: 'PUBLIC' }), 'SECRET');
});

test('redaction removes secrets and PII, keeps the rest', () => {
  const out = privacy.redact('ssn 123-45-6789 and token sk-abcdefghijklmnopqrstuvwx ok');
  assert.match(out, /\[REDACTED:ssn\]/); assert.match(out, /\[REDACTED:api_key\]/);
  assert.doesNotMatch(out, /123-45|sk-abc/); assert.match(out, / ok$/);
});

function fakeProvider(name, configured = true, log = []) {
  return { name, isConfigured: () => configured, complete: async (p) => { log.push([name, p]); return { text: 'ok', raw: name }; } };
}
function routerWith(providers, priv) {
  const r = new ProviderRouter(undefined, { privacy: priv });
  for (const [k, v] of Object.entries(providers)) r._instances[k] = v;
  r._preferenceFor = () => Object.values(providers);
  return r;
}

test('router: SECRET never reaches a cloud provider, even when local is absent (fails closed)', async () => {
  const log = [];
  const r = routerWith({ claude: fakeProvider('claude', true, log), ollama: fakeProvider('ollama', false, log) }, privacy);
  await assert.rejects(() => r.complete('chat', { messages: [{ role: 'user', content: 'key sk-abcdefghijklmnopqrstuvwx' }] }), /refusing to send/);
  assert.equal(log.length, 0);
});

test('router: SECRET goes to local when available; privacy hint is not forwarded', async () => {
  const log = [];
  const r = routerWith({ claude: fakeProvider('claude', true, log), ollama: fakeProvider('ollama', true, log) }, privacy);
  await r.complete('chat', { privacy: 'PRIVATE', messages: [{ role: 'user', content: 'password: hunter22222' }] });
  assert.equal(log[0][0], 'ollama'); assert.equal('privacy' in log[0][1], false);
});

test('router: SENSITIVE without local is redacted before cloud; PUBLIC untouched', async () => {
  const log = [];
  const r = routerWith({ claude: fakeProvider('claude', true, log) }, privacy);
  await r.complete('chat', { messages: [{ role: 'user', content: 'ssn 123-45-6789' }] });
  assert.match(log[0][1].messages[0].content, /REDACTED:ssn/);
  await r.complete('chat', { messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(log[1][1].messages[0].content, 'hello');
});

test('router: privacy OFF keeps previous behavior', async () => {
  const log = [];
  const r = routerWith({ claude: fakeProvider('claude', true, log) }, null);
  await r.complete('chat', { messages: [{ role: 'user', content: 'sk-abcdefghijklmnopqrstuvwx' }] });
  assert.equal(log.length, 1);
});
