import { AIProvider } from './AIProvider.js';
import { config } from '../config/index.js';
import { ProviderError } from './errors.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiProvider extends AIProvider {
  name = 'gemini';
  capabilities = ['fast', 'long-context', 'general'];

  constructor() {
    super();
    this.model = config.providers.gemini.model;
  }

  isConfigured() {
    return Boolean(config.providers.gemini.apiKey);
  }

  async complete({ messages, system, maxTokens = 1024 }) {
    if (!this.isConfigured()) {
      throw new Error('GeminiProvider: GEMINI_API_KEY is not set');
    }

    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const body = {
      contents,
      generationConfig: { maxOutputTokens: maxTokens },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const res = await fetch(
      `${BASE_URL}/models/${this.model}:generateContent?key=${config.providers.gemini.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      let payload = null;
      try { payload = JSON.parse(errText); } catch { /* upstream error was not JSON */ }
      const upstreamMessage = String(payload?.error?.message ?? payload?.message ?? errText ?? 'Unknown Gemini API error');
      const lower = upstreamMessage.toLowerCase();
      let errorType = 'unknown';
      if (res.status === 401 || res.status === 403) errorType = 'auth';
      else if (res.status === 429 || /quota|rate.?limit|resource_exhausted|too many requests/.test(lower)) errorType = 'rate_limit';
      else if (res.status === 408 || /timeout|deadline exceeded/.test(lower)) errorType = 'timeout';
      else if (res.status >= 500) errorType = 'server_error';
      else if (res.status === 400 || res.status === 404 || /model.*not found|not found|unsupported model|invalid argument/.test(lower)) errorType = 'invalid_request';
      else if (res.status === 0) errorType = 'unavailable';
      throw new ProviderError(`GeminiProvider: API error ${res.status} - ${upstreamMessage.slice(0, 500)}`, {
        errorType, status: res.status, provider: 'gemini',
      });
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';

    return {
      text,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
      raw: 'gemini',
    };
  }
}
