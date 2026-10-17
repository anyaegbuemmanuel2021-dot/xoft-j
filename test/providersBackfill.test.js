import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider } from '../src/providers/OpenAIProvider.js';
import { GeminiProvider } from '../src/providers/GeminiProvider.js';
import { ClaudeProvider } from '../src/providers/ClaudeProvider.js';
import { config } from '../src/config/index.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('OpenAIProvider — unit tested (no real API key in this environment; mocked fetch)', () => {
  test('isConfigured() reflects OPENAI_API_KEY', () => {
    const before = config.providers.openai.apiKey;
    config.providers.openai.apiKey = null;
    assert.equal(new OpenAIProvider().isConfigured(), false);
    config.providers.openai.apiKey = 'k';
    assert.equal(new OpenAIProvider().isConfigured(), true);
    config.providers.openai.apiKey = before;
  });

  test('complete() throws a clear error when not configured', async () => {
    const before = config.providers.openai.apiKey;
    config.providers.openai.apiKey = null;
    await assert.rejects(() => new OpenAIProvider().complete({ messages: [{ role: 'user', content: 'hi' }] }), /OPENAI_API_KEY is not set/);
    config.providers.openai.apiKey = before;
  });

  test('the fast variant uses OPENAI_FAST_MODEL, the default uses OPENAI_CHAT_MODEL', () => {
    assert.equal(new OpenAIProvider({ fast: true }).model, config.providers.openai.fastModel);
    assert.equal(new OpenAIProvider().model, config.providers.openai.chatModel);
  });

  test('complete() posts the real request shape and parses a real-shaped response, including tool_calls', async () => {
    const before = config.providers.openai.apiKey;
    config.providers.openai.apiKey = 'k';
    let capturedUrl, capturedBody, capturedHeaders;
    globalThis.fetch = mock.fn(async (url, opts) => {
      capturedUrl = url; capturedHeaders = opts.headers; capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'hi there', tool_calls: [{ function: { name: 'lookup', arguments: '{"q":"x"}' } }] } }],
          usage: { prompt_tokens: 4, completion_tokens: 2 },
        }),
      };
    });
    const result = await new OpenAIProvider().complete({
      messages: [{ role: 'user', content: 'hi' }], system: 'be brief', maxTokens: 20,
      tools: [{ name: 'lookup', description: 'x', inputSchema: {} }],
    });
    assert.equal(capturedUrl, 'https://api.openai.com/v1/chat/completions');
    assert.equal(capturedHeaders.Authorization, 'Bearer k');
    assert.equal(capturedBody.messages[0].role, 'system');
    assert.equal(capturedBody.tools[0].function.name, 'lookup');
    assert.equal(result.text, 'hi there');
    assert.equal(result.toolCalls[0].name, 'lookup');
    assert.deepEqual(result.toolCalls[0].input, { q: 'x' });
    assert.equal(result.usage.inputTokens, 4);
    config.providers.openai.apiKey = before;
  });

  test('complete() surfaces a real API error', async () => {
    const before = config.providers.openai.apiKey;
    config.providers.openai.apiKey = 'k';
    globalThis.fetch = mock.fn(async () => ({ ok: false, status: 429, text: async () => 'rate limited' }));
    await assert.rejects(() => new OpenAIProvider().complete({ messages: [] }), /OpenAIProvider: API error 429/);
    config.providers.openai.apiKey = before;
  });

  test('embed() posts to the embeddings endpoint and returns a single vector for a single string, an array for an array', async () => {
    const before = config.providers.openai.apiKey;
    config.providers.openai.apiKey = 'k';
    let capturedBody;
    globalThis.fetch = mock.fn(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ data: capturedBody.input.map ? capturedBody.input.map((_, i) => ({ embedding: [i] })) : [{ embedding: [0] }] }) };
    });
    const single = await new OpenAIProvider().embed('hello');
    assert.deepEqual(single, [0]);
    const multi = await new OpenAIProvider().embed(['a', 'b']);
    assert.deepEqual(multi, [[0], [1]]);
    config.providers.openai.apiKey = before;
  });

  test('embed() throws when not configured', async () => {
    const before = config.providers.openai.apiKey;
    config.providers.openai.apiKey = null;
    await assert.rejects(() => new OpenAIProvider().embed('x'), /OPENAI_API_KEY is not set/);
    config.providers.openai.apiKey = before;
  });
});

describe('GeminiProvider — unit tested (no real API key in this environment; mocked fetch)', () => {
  test('isConfigured() reflects GEMINI_API_KEY', () => {
    const before = config.providers.gemini.apiKey;
    config.providers.gemini.apiKey = null;
    assert.equal(new GeminiProvider().isConfigured(), false);
    config.providers.gemini.apiKey = 'k';
    assert.equal(new GeminiProvider().isConfigured(), true);
    config.providers.gemini.apiKey = before;
  });

  test('complete() throws a clear error when not configured', async () => {
    const before = config.providers.gemini.apiKey;
    config.providers.gemini.apiKey = null;
    await assert.rejects(() => new GeminiProvider().complete({ messages: [{ role: 'user', content: 'hi' }] }), /GEMINI_API_KEY is not set/);
    config.providers.gemini.apiKey = before;
  });

  test('complete() maps roles to Gemini\'s user/model shape, sends the key as a query param, and parses candidates back', async () => {
    const before = config.providers.gemini.apiKey;
    config.providers.gemini.apiKey = 'k';
    let capturedUrl, capturedBody;
    globalThis.fetch = mock.fn(async (url, opts) => {
      capturedUrl = url; capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'hello' }] } }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
        }),
      };
    });
    const result = await new GeminiProvider().complete({
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }],
      system: 'be brief', maxTokens: 10,
    });
    assert.ok(capturedUrl.includes('key=k'));
    assert.equal(capturedBody.contents[0].role, 'user');
    assert.equal(capturedBody.contents[1].role, 'model', 'assistant must map to Gemini\'s "model" role');
    assert.equal(capturedBody.systemInstruction.parts[0].text, 'be brief');
    assert.equal(result.text, 'hello');
    assert.equal(result.usage.inputTokens, 3);
    config.providers.gemini.apiKey = before;
  });

  test('complete() surfaces a real API error', async () => {
    const before = config.providers.gemini.apiKey;
    config.providers.gemini.apiKey = 'k';
    globalThis.fetch = mock.fn(async () => ({ ok: false, status: 400, text: async () => 'bad request' }));
    await assert.rejects(() => new GeminiProvider().complete({ messages: [] }), /GeminiProvider: API error 400/);
    config.providers.gemini.apiKey = before;
  });

  test('complete() tolerates an empty candidates response rather than throwing on missing text', async () => {
    const before = config.providers.gemini.apiKey;
    config.providers.gemini.apiKey = 'k';
    globalThis.fetch = mock.fn(async () => ({ ok: true, json: async () => ({}) }));
    const result = await new GeminiProvider().complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.text, '');
    config.providers.gemini.apiKey = before;
  });
});

describe('ClaudeProvider — unit tested (no real API key in this environment; mocked fetch)', () => {
  test('isConfigured() reflects ANTHROPIC_API_KEY', () => {
    const before = config.providers.claude.apiKey;
    config.providers.claude.apiKey = null;
    assert.equal(new ClaudeProvider().isConfigured(), false);
    config.providers.claude.apiKey = 'k';
    assert.equal(new ClaudeProvider().isConfigured(), true);
    config.providers.claude.apiKey = before;
  });

  test('complete() throws a clear error when not configured', async () => {
    const before = config.providers.claude.apiKey;
    config.providers.claude.apiKey = null;
    await assert.rejects(() => new ClaudeProvider().complete({ messages: [{ role: 'user', content: 'hi' }] }), /ANTHROPIC_API_KEY is not set/);
    config.providers.claude.apiKey = before;
  });

  test('complete() sends x-api-key + anthropic-version headers, tools in input_schema shape, and parses content blocks back', async () => {
    const before = config.providers.claude.apiKey;
    config.providers.claude.apiKey = 'k';
    let capturedHeaders, capturedBody;
    globalThis.fetch = mock.fn(async (url, opts) => {
      capturedHeaders = opts.headers; capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'search', input: { q: 'x' } }],
          usage: { input_tokens: 6, output_tokens: 2 },
        }),
      };
    });
    const result = await new ClaudeProvider().complete({
      messages: [{ role: 'user', content: 'hi' }], system: 'be brief',
      tools: [{ name: 'search', description: 'x', inputSchema: { type: 'object' } }],
    });
    assert.equal(capturedHeaders['x-api-key'], 'k');
    assert.equal(capturedHeaders['anthropic-version'], '2023-06-01');
    assert.equal(capturedBody.system, 'be brief');
    assert.equal(capturedBody.tools[0].input_schema.type, 'object');
    assert.equal(result.text, 'hi');
    assert.equal(result.toolCalls[0].name, 'search');
    assert.deepEqual(result.toolCalls[0].input, { q: 'x' });
    assert.equal(result.usage.inputTokens, 6);
    config.providers.claude.apiKey = before;
  });

  test('complete() joins multiple text blocks with newlines and omits toolCalls when there are none', async () => {
    const before = config.providers.claude.apiKey;
    config.providers.claude.apiKey = 'k';
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }], usage: {} }),
    }));
    const result = await new ClaudeProvider().complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.text, 'line1\nline2');
    assert.equal(result.toolCalls, undefined);
    config.providers.claude.apiKey = before;
  });

  test('complete() surfaces a real API error', async () => {
    const before = config.providers.claude.apiKey;
    config.providers.claude.apiKey = 'k';
    globalThis.fetch = mock.fn(async () => ({ ok: false, status: 529, text: async () => 'overloaded' }));
    await assert.rejects(() => new ClaudeProvider().complete({ messages: [] }), /ClaudeProvider: API error 529/);
    config.providers.claude.apiKey = before;
  });
});
