import { AIProvider } from './AIProvider.js';
import { config } from '../config/index.js';

const BASE_URL = 'https://api.openai.com/v1';

function responseText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  return (data.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text' || part.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}

function responseToolCalls(data) {
  return (data.output ?? [])
    .filter((item) => item.type === 'function_call' && item.name)
    .map((item) => {
      let input = {};
      try {
        input = typeof item.arguments === 'string'
          ? JSON.parse(item.arguments || '{}')
          : (item.arguments ?? {});
      } catch {
        throw new Error(`OpenAIProvider: model returned invalid JSON arguments for tool "${item.name}"`);
      }
      return { name: item.name, input };
    });
}

export class OpenAIProvider extends AIProvider {
  name = 'openai';
  capabilities = ['fast', 'cheap', 'coding', 'general', 'embeddings', 'vision', 'tools'];

  constructor({ fast = false, model = null } = {}) {
    super();
    this.model = model ?? (fast ? config.providers.openai.fastModel : config.providers.openai.chatModel);
  }

  isConfigured() {
    return Boolean(config.providers.openai.apiKey);
  }

  async complete({ messages = [], system, tools, maxTokens = 1024, signal } = {}) {
    if (!this.isConfigured()) {
      throw new Error('OpenAIProvider: OPENAI_API_KEY is not set');
    }

    // Use the Responses API: current frontier models expose tool calling and multimodal
    // features here. Keep the provider-neutral interface unchanged for the rest of XOFT.
    const body = {
      model: this.model,
      max_output_tokens: maxTokens,
      input: messages.map((message) => ({
        role: message.role === 'system' ? 'developer' : message.role,
        content: message.content,
      })),
    };
    if (system) body.instructions = system;

    if (tools?.length) {
      body.tools = tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
        strict: false,
      }));
    }

    const res = await fetch(`${BASE_URL}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.providers.openai.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAIProvider: API error ${res.status} - ${errText}`);
    }

    const data = await res.json();
    if (data.status === 'incomplete' && data.incomplete_details?.reason === 'max_output_tokens') {
      // Return any partial output transparently; callers can decide whether to continue.
    }

    return {
      text: responseText(data),
      toolCalls: responseToolCalls(data),
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
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
    const vectors = (data.data ?? []).map((item) => item.embedding);
    if (vectors.length === 0) throw new Error('OpenAIProvider: embeddings response contained no vectors');
    return Array.isArray(input) ? vectors : vectors[0];
  }
}
