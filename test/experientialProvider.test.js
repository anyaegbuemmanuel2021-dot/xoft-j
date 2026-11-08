// See test/whatsappService.test.js for why this must be a dynamic import
// after setting process.env, not a static one (ESM import hoisting).
process.env.EXPERIENTIAL_API_KEY = 'xpl_test_key_not_real';
process.env.EXPERIENTIAL_BASE_URL = 'https://api.experientiallabs.ai/v1';
process.env.EXPERIENTIAL_MODEL = 'qwen3.8-27b';
process.env.EXPERIENTIAL_FREE_ONLY = 'true';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
const { ExperientialProvider } = await import('../src/providers/ExperientialProvider.js');

describe('ExperientialProvider — configuration and model selection', () => {
  test('isConfigured() is true once EXPERIENTIAL_API_KEY is set', () => {
    assert.equal(new ExperientialProvider().isConfigured(), true);
  });

  test('getModel() reflects EXPERIENTIAL_MODEL by default; setModel() overrides it at runtime', () => {
    const provider = new ExperientialProvider();
    assert.equal(provider.getModel(), 'qwen3.8-27b');
    assert.equal(provider.setModel('claude-opus-5'), 'claude-opus-5');
    assert.equal(provider.getModel(), 'claude-opus-5');
  });

  test('setModel() rejects an empty or non-string model', () => {
    const provider = new ExperientialProvider();
    assert.throws(() => provider.setModel(''), /model slug is required/);
    assert.throws(() => provider.setModel(null), /model slug is required/);
  });

  test('complete() with no model ever selected throws a clear error, never guesses', async () => {
    const provider = new ExperientialProvider({ fetchImpl: async () => { throw new Error('should not be called'); } });
    provider.model = null; // simulate nothing configured and nothing selected at runtime
    await assert.rejects(() => provider.complete({ messages: [{ role: 'user', content: 'hi' }] }), /no model selected/);
  });
});

describe('ExperientialProvider — free-only safety (the specific bug this was fixed for)', () => {
  test('never rewrites the model slug — the real API has no ":free" suffix convention', async () => {
    // Regression test for the exact bug found in the forensic audit: the
    // model sent on the wire must be exactly what was selected, byte for
    // byte, never mutated with an invented suffix.
    let sentBody;
    const fetchImpl = async (url, init) => {
      if (String(url).includes('/models')) {
        return { ok: true, json: async () => ({ data: [{ id: 'qwen3.8-27b', pricing: { input_nano_usd_per_million: 0, output_nano_usd_per_million: 0 } }] }) };
      }
      sentBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'hi back' } }], usage: {} }) };
    };
    const provider = new ExperientialProvider({ fetchImpl });
    provider.setModel('qwen3.8-27b');
    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(sentBody.model, 'qwen3.8-27b', 'the model slug must never be mutated with a :free suffix or anything else');
  });

  test('refuses to call a model that is not confirmed free when EXPERIENTIAL_FREE_ONLY=true (fails closed)', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('/models')) {
        // catalog says this model has a real, nonzero price
        return { ok: true, json: async () => ({ data: [{ id: 'claude-opus-5', pricing: { input_nano_usd_per_million: 15000, output_nano_usd_per_million: 75000 } }] }) };
      }
      throw new Error('chat/completions must never be called for an unconfirmed-free model in free-only mode');
    };
    const provider = new ExperientialProvider({ fetchImpl });
    provider.setModel('claude-opus-5');
    await assert.rejects(
      () => provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      /not confirmed free/,
    );
  });

  test('refuses a model whose price cannot be determined at all — unknown price is treated as NOT free', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('/models')) {
        // catalog entry with no pricing information whatsoever
        return { ok: true, json: async () => ({ data: [{ id: 'mystery-model' }] }) };
      }
      throw new Error('must not call chat/completions when eligibility is unknown');
    };
    const provider = new ExperientialProvider({ fetchImpl });
    provider.setModel('mystery-model');
    await assert.rejects(() => provider.complete({ messages: [{ role: 'user', content: 'hi' }] }), /not confirmed free/);
  });

  test('allows a model the catalog positively confirms is zero-cost', async () => {
    let calledChat = false;
    const fetchImpl = async (url) => {
      if (String(url).includes('/models')) {
        return { ok: true, json: async () => ({ data: [{ id: 'qwen3.8-27b', pricing: { input_nano_usd_per_million: 0, output_nano_usd_per_million: 0 } }] }) };
      }
      calledChat = true;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }) };
    };
    const provider = new ExperientialProvider({ fetchImpl });
    provider.setModel('qwen3.8-27b');
    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(calledChat, true);
    assert.equal(result.text, 'ok');
  });
});

describe('ExperientialProvider — request/response shape', () => {
  test('complete() sends the Bearer auth header, the messages array, and maps tool schemas to OpenAI function format', async () => {
    let capturedInit, capturedUrl;
    const fetchImpl = async (url, init) => {
      if (String(url).includes('/models')) {
        return { ok: true, json: async () => ({ data: [{ id: 'qwen3.8-27b', pricing: { input_nano_usd_per_million: 0, output_nano_usd_per_million: 0 } }] }) };
      }
      capturedUrl = url;
      capturedInit = init;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'response text', tool_calls: [{ function: { name: 'lookup', arguments: '{"q":"x"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 } }) };
    };
    const provider = new ExperientialProvider({ fetchImpl });
    provider.setModel('qwen3.8-27b');
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      system: 'be helpful',
      tools: [{ name: 'lookup', description: 'look something up', inputSchema: { type: 'object' } }],
      maxTokens: 500,
    });

    assert.equal(capturedUrl, 'https://api.experientiallabs.ai/v1/chat/completions');
    assert.equal(capturedInit.headers.Authorization, 'Bearer xpl_test_key_not_real');
    const body = JSON.parse(capturedInit.body);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[0].content, 'be helpful');
    assert.equal(body.messages[1].content, 'hi');
    assert.equal(body.max_tokens, 500);
    assert.equal(body.tools[0].type, 'function');
    assert.equal(body.tools[0].function.name, 'lookup');

    assert.equal(result.text, 'response text');
    assert.equal(result.toolCalls[0].name, 'lookup');
    assert.deepEqual(result.toolCalls[0].input, { q: 'x' });
    assert.equal(result.usage.inputTokens, 10);
    assert.equal(result.usage.outputTokens, 5);
  });

  test('complete() surfaces the real API error rather than swallowing it or fabricating a response', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('/models')) {
        return { ok: true, json: async () => ({ data: [{ id: 'qwen3.8-27b', pricing: { input_nano_usd_per_million: 0, output_nano_usd_per_million: 0 } }] }) };
      }
      return { ok: false, status: 502, text: async () => 'all_routes_failed' };
    };
    const provider = new ExperientialProvider({ fetchImpl });
    provider.setModel('qwen3.8-27b');
    await assert.rejects(() => provider.complete({ messages: [{ role: 'user', content: 'hi' }] }), /502/);
  });

  test('listModels() authenticates against /v1/models when a key is configured', async () => {
    let capturedUrl, capturedHeaders;
    const fetchImpl = async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init?.headers;
      return { ok: true, json: async () => ({ data: [{ id: 'model-a' }] }) };
    };
    const provider = new ExperientialProvider({ fetchImpl });
    const models = await provider.listModels();
    assert.equal(capturedUrl, 'https://api.experientiallabs.ai/v1/models');
    assert.equal(capturedHeaders.Authorization, 'Bearer xpl_test_key_not_real');
    assert.deepEqual(models, [{ id: 'model-a' }]);
  });
});
