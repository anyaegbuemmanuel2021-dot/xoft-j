import test from 'node:test';
import assert from 'node:assert/strict';

// Deliberately fake credentials: these tests never contact external providers.
process.env.OPENAI_API_KEY = 'simulation-openai-key';
process.env.ANTHROPIC_API_KEY = 'simulation-claude-key';
process.env.GEMINI_API_KEY = 'simulation-gemini-key';
process.env.XAI_API_KEY = 'simulation-grok-key';

const [{ OpenAIProvider }, { ClaudeProvider }, { GeminiProvider }, { GrokProvider }] = await Promise.all([
  import('../src/providers/OpenAIProvider.js'),
  import('../src/providers/ClaudeProvider.js'),
  import('../src/providers/GeminiProvider.js'),
  import('../src/providers/GrokProvider.js'),
]);

test('provider simulation: all configured cloud adapters normalize a successful response', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : null });
    const target = String(url);
    if (target.includes('/responses')) {
      return Response.json({
        status: 'completed',
        output_text: 'simulated OpenAI response',
        output: [],
        usage: { input_tokens: 4, output_tokens: 3 },
      });
    }
    if (target.includes('api.anthropic.com/v1/messages')) {
      return Response.json({
        content: [{ type: 'text', text: 'simulated Claude response' }],
        usage: { input_tokens: 5, output_tokens: 2 },
      });
    }
    if (target.includes('generativelanguage.googleapis.com')) {
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'simulated Gemini response' }] } }],
        usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2 },
      });
    }
    if (target.includes('api.x.ai/v1/chat/completions')) {
      return Response.json({
        choices: [{ message: { content: 'simulated Grok response' } }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
      });
    }
    return new Response('Unexpected simulated provider URL: ' + target, { status: 500 });
  };

  try {
    const cases = [
      { name: 'openai', provider: new OpenAIProvider({ model: 'simulation-model' }), expected: 'simulated OpenAI response', inputTokens: 4 },
      { name: 'claude', provider: new ClaudeProvider(), expected: 'simulated Claude response', inputTokens: 5 },
      { name: 'gemini', provider: new GeminiProvider(), expected: 'simulated Gemini response', inputTokens: 6 },
      { name: 'grok', provider: new GrokProvider(), expected: 'simulated Grok response', inputTokens: 7 },
    ];

    for (const item of cases) {
      assert.equal(item.provider.isConfigured(), true, item.name + ' should accept the fake key');
      const result = await item.provider.complete({
        system: 'You are XOFT. This is a simulation.',
        messages: [{ role: 'user', content: 'Reply with a short test message.' }],
        maxTokens: 64,
      });
      assert.equal(result.raw, item.name);
      assert.equal(result.text, item.expected);
      assert.equal(result.usage.inputTokens, item.inputTokens);
      assert.ok(requests.some((request) => request.url.includes(
        item.name === 'openai' ? '/responses'
          : item.name === 'claude' ? 'api.anthropic.com'
          : item.name === 'gemini' ? 'generativelanguage.googleapis.com'
          : 'api.x.ai'
      )), item.name + ' should have issued a simulated request');
    }
    assert.equal(requests.length, 4, 'each provider should make exactly one mocked request');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
