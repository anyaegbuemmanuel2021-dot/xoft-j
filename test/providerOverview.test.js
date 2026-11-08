import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderOverview, PROVIDER_META } from '../src/providers/providerOverview.js';

const config = { providers: {
  openai: { chatModel: 'gpt-x', apiKey: 'sk-SECRET-1' }, gemini: { model: 'gem-x', apiKey: 'SECRET-2' }, claude: { model: 'cl-x', apiKey: 'SECRET-3' },
  xai: { model: 'grok-x', apiKey: 'SECRET-4' }, ollama: { model: 'llama', baseUrl: 'http://127.0.0.1:11434' },
  experiential: { model: 'exp-default', apiKey: 'SECRET-5', baseUrl: 'https://internal.example/v1' },
} };

function fakeRouter(configured, { ollamaUp = true } = {}) {
  const inst = (id) => ({ isConfigured: () => configured.includes(id), ...(id === 'ollama' ? { ping: async () => ollamaUp } : {}) });
  return { getInstance: (id) => inst(id), getModel: () => 'exp-selected' };
}
const health = (map) => ({ getStats: (id) => map[id] ?? { status: 'UNKNOWN', avgLatencyMs: null, calls: 0, failureCount: 0 } });

test('lists every provider (the six original plus the optional FreeLLMAPI and LiteLLM gateways) with status, model and latency', async () => {
  const out = await buildProviderOverview({ router: fakeRouter(['claude', 'experiential']), modelHealth: health({ claude: { status: 'AVAILABLE', avgLatencyMs: 812, calls: 4, failureCount: 0 }, experiential: { status: 'DEGRADED', avgLatencyMs: null, calls: 3, failureCount: 2 } }), config });
  assert.deepEqual(out.map((p) => p.label), ['OpenAI', 'Gemini', 'Claude', 'Grok', 'Ollama', 'Experiential Labs', 'FreeLLMAPI', 'LiteLLM']);
  assert.equal(PROVIDER_META.length, 8);
  // the original six keep their exact order and are unchanged; the optional gateways are simply appended
  assert.equal(out.find((p) => p.id === 'freellmapi').status, 'NOT_CONFIGURED');
  const by = Object.fromEntries(out.map((p) => [p.id, p]));
  assert.equal(by.claude.status, 'AVAILABLE'); assert.equal(by.claude.avgLatencyMs, 812);
  assert.equal(by.experiential.status, 'DEGRADED'); assert.equal(by.experiential.avgLatencyMs, null);
  assert.equal(by.experiential.model, 'exp-selected', 'reflects the runtime-selected model');
  assert.equal(by.openai.status, 'NOT_CONFIGURED');
  assert.equal(by.experiential.switchable, true); assert.equal(by.claude.switchable, false);
});

test('never leaks API keys or base URLs', async () => {
  const out = await buildProviderOverview({ router: fakeRouter(['openai', 'gemini', 'claude', 'grok', 'ollama', 'experiential']), modelHealth: health({}), config });
  const json = JSON.stringify(out);
  assert.doesNotMatch(json, /SECRET|sk-|internal\.example|127\.0\.0\.1/);
});

test('ollama that is enabled but unreachable is reported OFFLINE-ish (UNAVAILABLE)', async () => {
  const out = await buildProviderOverview({ router: fakeRouter(['ollama'], { ollamaUp: false }), modelHealth: health({}), config });
  const o = out.find((p) => p.id === 'ollama');
  assert.equal(o.status, 'UNAVAILABLE'); assert.equal(o.reachable, false);
});
