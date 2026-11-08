import { AIProvider } from './AIProvider.js';
import { config } from '../config/index.js';

/**
 * OllamaProvider — talks to a locally-running Ollama daemon
 * (https://ollama.com), so XOFT can keep answering with zero internet
 * access as long as a model has already been pulled on this machine.
 *
 * This is a genuine offline path, not a stub: it hits a real local HTTP
 * server and returns real model output. It is deliberately opt-in
 * (OLLAMA_ENABLED=true) and placed last in every provider preference list —
 * a local 8B-class model is real but weaker than the cloud models, so it
 * should only be used when nothing else is reachable.
 */
export class OllamaProvider extends AIProvider {
  name = 'ollama';
  capabilities = ['offline', 'local', 'free', 'general'];

  constructor() {
    super();
    this.baseUrl = config.providers.ollama.baseUrl;
    this.model = config.providers.ollama.model;
  }

  isConfigured() {
    // "Configured" here means "opted in", not "reachable right now" — reachability
    // can only be known at call time (the whole point is it may be offline).
    return Boolean(config.providers.ollama.enabled && this.model);
  }

  async complete({ messages, system, tools, maxTokens = 1024 }) {
    if (!this.isConfigured()) {
      throw new Error('OllamaProvider: not enabled (set OLLAMA_ENABLED=true and OLLAMA_MODEL)');
    }

    const body = {
      model: this.model,
      stream: false,
      options: { num_predict: maxTokens },
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    };

    if (tools?.length) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }

    let res;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Distinct, greppable error so ProviderRouter/ModelHealthManager can tell
      // "local daemon unreachable" apart from "model returned an error".
      throw new Error(`OllamaProvider: cannot reach local Ollama at ${this.baseUrl} (${err.message}). Is 'ollama serve' running?`);
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OllamaProvider: API error ${res.status} - ${errText}`);
    }

    const data = await res.json();
    const toolCalls = data.message?.tool_calls?.map((tc) => ({
      name: tc.function?.name,
      input: typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : (tc.function?.arguments ?? {}),
    }));

    return {
      text: data.message?.content ?? '',
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
      raw: 'ollama',
    };
  }

  /** Quick reachability probe — used by /api/status so the UI can show "local model: reachable/unreachable" without waiting for a real chat call to fail. */
  async ping() {
    if (!this.isConfigured()) return false;
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
