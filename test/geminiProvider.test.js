import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider } from '../src/providers/GeminiProvider.js';
import { config } from '../src/config/index.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('Gemini refuses to return fake answers when no API key is configured', async () => {
  const before = config.providers.gemini.apiKey;
  config.providers.gemini.apiKey = '';
  try {
    await assert.rejects(
      () => new GeminiProvider().complete({ messages: [{ role: 'user', content: 'hello' }] }),
      /GEMINI_API_KEY is not set/,
    );
  } finally {
    config.providers.gemini.apiKey = before;
  }
});

test('Gemini sends a request to the configured model and parses a real-shaped response', async () => {
  const beforeKey = config.providers.gemini.apiKey;
  const beforeModel = config.providers.gemini.model;
  config.providers.gemini.apiKey = 'test-key';
  config.providers.gemini.model = 'gemini-3.8-flash';
  let capturedUrl, capturedBody;
  globalThis.fetch = mock.fn(async (url, options) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'real-shaped reply' }] } }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4 },
      }),
    };
  });
  try {
    const result = await new GeminiProvider().complete({
      messages: [{ role: 'user', content: 'hello' }],
      system: 'Be helpful',
      maxTokens: 64,
    });
    assert.equal(capturedUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=test-key');
    assert.equal(capturedBody.systemInstruction.parts[0].text, 'Be helpful');
    assert.equal(capturedBody.generationConfig.maxOutputTokens, 64);
    assert.equal(result.text, 'real-shaped reply');
    assert.equal(result.usage.inputTokens, 7);
    assert.equal(result.usage.outputTokens, 4);
    assert.equal(result.raw, 'gemini');
  } finally {
    config.providers.gemini.apiKey = beforeKey;
    config.providers.gemini.model = beforeModel;
  }
});

test('Gemini surfaces a retired or unavailable model response as a real error', async () => {
  const beforeKey = config.providers.gemini.apiKey;
  config.providers.gemini.apiKey = 'test-key';
  globalThis.fetch = mock.fn(async () => ({
    ok: false,
    status: 404,
    text: async () => JSON.stringify({ error: { message: 'Model not found' } }),
  }));
  try {
    await assert.rejects(
      () => new GeminiProvider().complete({ messages: [{ role: 'user', content: 'hello' }] }),
      /API error 404 - Model not found/,
    );
  } finally {
    config.providers.gemini.apiKey = beforeKey;
  }
});
