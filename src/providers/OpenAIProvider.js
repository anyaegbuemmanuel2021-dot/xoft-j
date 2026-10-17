import { AIProvider } from './AIProvider.js';
import { config } from '../config/index.js';

const BASE_URL = 'https://api.openai.com/v1';

export class OpenAIProvider extends AIProvider {
  name = 'openai';
  capabilities = ['fast', 'cheap', 'coding', 'general', 'embeddings'];

  constructor({ fast = false } = {}) {
    super();
    this.model = fast ? config.providers.openai.fastModel : config.providers.openai.chatModel;
  }

  isConfigured() {
    return Boolean(config.providers.openai.apiKey);
  }

  async complete({ messages, system, tools, maxTokens = 1024 }) {
    if (!this.isConfigured()) {
      throw new Error('OpenAIProvider: OPENAI_API_KEY is not set');
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
        Authorization: `Bearer ${config.providers.openai.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAIProvider: API error ${res.status} - ${errText}`);
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
      raw: 'openai',
    };
  }

  async embed(input) {
    if (!this.isConfigured()) {
      throw new Error('OpenAIProvider: OPENAI_API_KEY is not set');
    }
    const res = await fetch(`${BASE_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.providers.openai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.providers.openai.embeddingModel,
        input,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAIProvider: embeddings error ${res.status} - ${errText}`);
    }

    const data = await res.json();
    const vectors = data.data.map((d) => d.embedding);
    return Array.isArray(input) ? vectors : vectors[0];
  }
}
