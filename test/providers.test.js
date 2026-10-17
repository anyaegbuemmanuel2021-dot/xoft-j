import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GrokProvider } from '../src/providers/GrokProvider.js';
import { ModelHealthManager } from '../src/providers/ModelHealthManager.js';
import { config } from '../src/config/index.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('GrokProvider — unit tested (no real API key available in this environment; mocked fetch)', () => {
  test('isConfigured() is false with no XAI_API_KEY, true once set', () => {
    const before = config.providers.xai.apiKey;
    config.providers.xai.apiKey = null;
    assert.equal(new GrokProvider().isConfigured(), false);
    config.providers.xai.apiKey = 'test-key';
    assert.equal(new GrokProvider().isConfigured(), true);
    config.providers.xai.apiKey = before;
  });

  test('complete() throws a clear error when not configured, never silently returns a fake response', async () => {
    const before = config.providers.xai.apiKey;
    config.providers.xai.apiKey = null;
    const provider = new GrokProvider();
    await assert.rejects(() => provider.complete({ messages: [{ role: 'user', content: 'hi' }] }), /XAI_API_KEY is not set/);
    config.providers.xai.apiKey = before;
  });

  test('complete() posts to the real xAI endpoint in the OpenAI-compatible shape and parses a real-shaped response', async () => {
    const before = config.providers.xai.apiKey;
    config.providers.xai.apiKey = 'test-key';
    let capturedUrl, capturedBody, capturedHeaders;
    globalThis.fetch = mock.fn(async (url, opts) => {
      capturedUrl = url;
      capturedHeaders = opts.headers;
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'hello from grok' } }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
      };
    });

    const provider = new GrokProvider();
    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }], system: 'be terse', maxTokens: 50 });

    assert.equal(capturedUrl, 'https://api.x.ai/v1/chat/completions');
    assert.equal(capturedHeaders.Authorization, 'Bearer test-key');
    assert.equal(capturedBody.messages[0].role, 'system');
    assert.equal(capturedBody.messages[0].content, 'be terse');
    assert.equal(capturedBody.max_tokens, 50);
    assert.equal(result.text, 'hello from grok');
    assert.equal(result.usage.inputTokens, 5);
    assert.equal(result.usage.outputTokens, 3);
    assert.equal(result.raw, 'grok');

    config.providers.xai.apiKey = before;
  });

  test('complete() surfaces a real API error rather than swallowing it', async () => {
    const before = config.providers.xai.apiKey;
    config.providers.xai.apiKey = 'test-key';
    globalThis.fetch = mock.fn(async () => ({ ok: false, status: 401, text: async () => 'invalid key' }));
    const provider = new GrokProvider();
    await assert.rejects(() => provider.complete({ messages: [{ role: 'user', content: 'hi' }] }), /GrokProvider: API error 401/);
    config.providers.xai.apiKey = before;
  });

  test('complete() forwards tool schemas in OpenAI function-calling shape and parses tool_calls back', async () => {
    const before = config.providers.xai.apiKey;
    config.providers.xai.apiKey = 'test-key';
    let capturedBody;
    globalThis.fetch = mock.fn(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '', tool_calls: [{ function: { name: 'get_weather', arguments: '{"city":"Lagos"}' } }] } }],
          usage: {},
        }),
      };
    });
    const provider = new GrokProvider();
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [{ name: 'get_weather', description: 'x', inputSchema: { type: 'object' } }],
    });
    assert.equal(capturedBody.tools[0].function.name, 'get_weather');
    assert.equal(result.toolCalls[0].name, 'get_weather');
    assert.deepEqual(result.toolCalls[0].input, { city: 'Lagos' });
    config.providers.xai.apiKey = before;
  });
});

describe('ModelHealthManager — status field', () => {
  test('a provider with no data yet reports UNKNOWN', () => {
    const health = new ModelHealthManager();
    assert.equal(health.getStats('nothing-seen').status, 'UNKNOWN');
  });

  test('a provider with only successes reports AVAILABLE', () => {
    const health = new ModelHealthManager();
    health.recordSuccess('grok', { latencyMs: 100 });
    assert.equal(health.getStats('grok').status, 'AVAILABLE');
  });

  test('a provider with a recent-but-not-yet-unhealthy failure reports DEGRADED', () => {
    const health = new ModelHealthManager();
    health.recordSuccess('grok', { latencyMs: 100 });
    health.recordFailure('grok', { errorType: 'timeout' });
    assert.equal(health.getStats('grok').status, 'DEGRADED');
  });

  test('enough consecutive failures trips isHealthy() false and reports the specific error type', () => {
    const health = new ModelHealthManager();
    health.recordFailure('grok', { errorType: 'rate_limit' });
    health.recordFailure('grok', { errorType: 'rate_limit' });
    health.recordFailure('grok', { errorType: 'rate_limit' });
    assert.equal(health.isHealthy('grok'), false);
    assert.equal(health.getStats('grok').status, 'RATE_LIMITED');
  });

  test('auth and timeout failures map to their own specific statuses, not a generic UNAVAILABLE', () => {
    const authHealth = new ModelHealthManager();
    for (let i = 0; i < 3; i++) authHealth.recordFailure('p', { errorType: 'auth' });
    assert.equal(authHealth.getStats('p').status, 'AUTH_ERROR');

    const timeoutHealth = new ModelHealthManager();
    for (let i = 0; i < 3; i++) timeoutHealth.recordFailure('p', { errorType: 'timeout' });
    assert.equal(timeoutHealth.getStats('p').status, 'TIMEOUT');

    const unknownHealth = new ModelHealthManager();
    for (let i = 0; i < 3; i++) unknownHealth.recordFailure('p', { errorType: 'unknown' });
    assert.equal(unknownHealth.getStats('p').status, 'UNAVAILABLE');
  });
});

describe('ProviderRouter — configurable AI_PRIMARY_PROVIDER / AI_FALLBACK_PROVIDERS', () => {
  const originalRouting = { ...config.aiRouting };
  afterEach(() => { Object.assign(config.aiRouting, originalRouting); });

  test('with no AI_PRIMARY_PROVIDER set, task-aware defaults are used (unaffected by this feature existing)', async () => {
    const { ProviderRouter, TaskType } = await import('../src/providers/ProviderRouter.js');
    config.aiRouting.primaryProvider = null;
    const router = new ProviderRouter();
    const before = { claude: config.providers.claude.apiKey, xai: config.providers.xai.apiKey, openai: config.providers.openai.apiKey, gemini: config.providers.gemini.apiKey };
    config.providers.claude.apiKey = 'k'; config.providers.xai.apiKey = 'k'; config.providers.openai.apiKey = null; config.providers.gemini.apiKey = null;
    assert.equal(router.select(TaskType.REASONING).name, 'claude');
    config.providers.claude.apiKey = before.claude;
    config.providers.xai.apiKey = before.xai; config.providers.openai.apiKey = before.openai; config.providers.gemini.apiKey = before.gemini;
  });

  test('AI_PRIMARY_PROVIDER pins one provider first for every task type, overriding the task-aware default', async () => {
    const { ProviderRouter, TaskType } = await import('../src/providers/ProviderRouter.js');
    const before = { claude: config.providers.claude.apiKey, xai: config.providers.xai.apiKey };
    config.providers.claude.apiKey = 'k'; config.providers.xai.apiKey = 'k';
    config.aiRouting.primaryProvider = 'grok';
    config.aiRouting.fallbackEnabled = true;
    config.aiRouting.fallbackProviders = ['claude'];

    const router = new ProviderRouter();
    assert.equal(router.select(TaskType.REASONING).name, 'grok');
    assert.equal(router.select(TaskType.SIMPLE).name, 'grok');

    config.providers.claude.apiKey = before.claude; config.providers.xai.apiKey = before.xai;
  });

  test('AI_FALLBACK_ENABLED=false means only the primary is tried — no cloud fallback even if others are configured', async () => {
    const { ProviderRouter, TaskType } = await import('../src/providers/ProviderRouter.js');
    const before = { claude: config.providers.claude.apiKey, xai: config.providers.xai.apiKey };
    config.providers.claude.apiKey = 'k'; config.providers.xai.apiKey = null;
    config.aiRouting.primaryProvider = 'grok';
    config.aiRouting.fallbackEnabled = false;
    config.aiRouting.fallbackProviders = ['claude'];

    const router = new ProviderRouter();
    assert.throws(() => router.select(TaskType.REASONING), /no configured provider available/);

    config.providers.claude.apiKey = before.claude; config.providers.xai.apiKey = before.xai;
  });

  test('an unknown AI_PRIMARY_PROVIDER name fails loudly instead of silently falling back to defaults', async () => {
    const { ProviderRouter, TaskType } = await import('../src/providers/ProviderRouter.js');
    config.aiRouting.primaryProvider = 'not-a-real-provider';
    const router = new ProviderRouter();
    assert.throws(() => router.select(TaskType.SIMPLE), /does not match any known provider/);
  });
});

describe('ProviderRouter — Grok is a real, wired candidate, not a silent no-op', () => {
  test('configuredProviders() includes grok once XAI_API_KEY is set', async () => {
    const { ProviderRouter } = await import('../src/providers/ProviderRouter.js');
    const before = config.providers.xai.apiKey;
    config.providers.xai.apiKey = 'test-key';
    const router = new ProviderRouter();
    assert.ok(router.configuredProviders().includes('grok'));
    config.providers.xai.apiKey = before;
  });

  test('getInstance("grok") returns a real GrokProvider instance', async () => {
    const { ProviderRouter } = await import('../src/providers/ProviderRouter.js');
    const router = new ProviderRouter();
    assert.ok(router.getInstance('grok') instanceof GrokProvider);
  });
});
