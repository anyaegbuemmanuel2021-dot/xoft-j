import { AIProvider } from './AIProvider.js';
import { config } from '../config/index.js';

const BASE_URL = 'https://api.anthropic.com/v1';

export class ClaudeProvider extends AIProvider {
  name = 'claude';
  capabilities = ['reasoning', 'coding', 'long-context', 'general'];

  constructor() {
    super();
    this.model = config.providers.claude.model;
  }

  isConfigured() {
    return Boolean(config.providers.claude.apiKey);
  }

  async complete({ messages, system, tools, maxTokens = 1024 }) {
    if (!this.isConfigured()) {
      throw new Error('ClaudeProvider: ANTHROPIC_API_KEY is not set');
    }

    const body = {
      model: this.model,
      max_tokens: maxTokens,
      messages,
    };
    if (system) body.system = system;
    if (tools?.length) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    const res = await fetch(`${BASE_URL}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.providers.claude.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`ClaudeProvider: API error ${res.status} - ${errText}`);
    }

    const data = await res.json();
    const textBlocks = data.content.filter((b) => b.type === 'text').map((b) => b.text);
    const toolCalls = data.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ name: b.name, input: b.input }));

    return {
      text: textBlocks.join('\n'),
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
      raw: 'claude',
    };
  }
}
