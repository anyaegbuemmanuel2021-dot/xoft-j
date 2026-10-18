import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';
const { OpenAIProvider } = await import('../src/providers/OpenAIProvider.js');

test('OpenAI provider uses Responses API and normalizes text, tools and usage', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      status: 'completed',
      output_text: 'Hello from XOFT.',
      output: [
        { type: 'function_call', name: 'get_weather', arguments: '{"city":"Enugu"}' },
      ],
      usage: { input_tokens: 12, output_tokens: 7 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const provider = new OpenAIProvider({ model: 'gpt-test-model' });
    const result = await provider.complete({
      system: 'You are XOFT.',
      messages: [{ role: 'user', content: 'Weather?' }],
      tools: [{ name: 'get_weather', description: 'Get weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } }],
      maxTokens: 300,
    });

    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    assert.equal(request.options.headers.Authorization, 'Bearer test-key');
    assert.equal(request.body.model, 'gpt-test-model');
    assert.equal(request.body.max_output_tokens, 300);
    assert.equal(request.body.instructions, 'You are XOFT.');
    assert.deepEqual(request.body.input, [{ role: 'user', content: 'Weather?' }]);
    assert.deepEqual(request.body.tools[0], {
      type: 'function',
      name: 'get_weather',
      description: 'Get weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
      strict: false,
    });
    assert.equal(result.text, 'Hello from XOFT.');
    assert.deepEqual(result.toolCalls, [{ name: 'get_weather', input: { city: 'Enugu' } }]);
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 7 });
    assert.equal(result.raw, 'openai');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI provider reports API errors without hiding the response body', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('model not available', { status: 404 });
  try {
    const provider = new OpenAIProvider({ model: 'unavailable-model' });
    await assert.rejects(
      provider.complete({ messages: [{ role: 'user', content: 'Hi' }] }),
      /API error 404 - model not available/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
