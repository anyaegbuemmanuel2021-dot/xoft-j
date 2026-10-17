import { AIProvider } from './AIProvider.js';
import { config } from '../config/index.js';

const BASE_URL = 'https://api.x.ai/v1';

/**
 * GrokProvider — xAI's chat completion API is OpenAI-compatible (same
 * request/response shape as /v1/chat/completions), so this mirrors
 * OpenAIProvider's complete() rather than inventing a new shape. No embed()
 * here: xAI's embedding support isn't wired into this codebase's vector
 * memory path (OpenAI remains the only embedding provider — see
 * ProviderRouter.selectEmbedding), so adding a half-used embed() here would
 * be exactly the kind of unused abstraction the implementation rules warn
 * against.
 */
export class GrokProvider extends AIProvider {
  name = 'grok';
  capabilities = ['fast', 'reasoning', 'general'];

  constructor() {
    super();
    this.model = config.providers.xai.model;
  }

  isConfigured() {
    return Boolean(config.providers.xai.apiKey);
  }

  async complete({ messages, system, tools, maxTokens = 1024 }) {
    if (!this.isConfigured()) {
      throw new Error('GrokProvider: XAI_API_KEY is not set');
    }

    const body = {
      model: this.model,
      max_tokens: maxTokens,
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    };

    if (tools?.length) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }

    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.providers.xai.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`GrokProvider: API error ${res.status} - ${errText}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    const toolCalls = choice?.message?.tool_calls?.map((tc) => ({
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments || '{}'),
    }));

    return {
      text: choice?.message?.content ?? '',
      toolCalls,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      raw: 'grok',
    };
  }
}
