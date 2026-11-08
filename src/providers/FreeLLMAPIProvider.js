import { OpenAICompatibleGateway } from './OpenAICompatibleGateway.js';

/**
 * FreeLLMAPI (https://github.com/tashfeenahmed/freellmapi) — a self-hosted OpenAI-compatible proxy that stacks the free tiers of many
 * LLM providers behind one /v1 endpoint (default http://localhost:3001/v1, bearer key `freellmapi-…` from its dashboard's Keys page).
 * Model `auto` lets its own router choose; `auto:fast` / `auto:smart` / a concrete model id are also accepted.
 *
 * OPTIONAL: disabled by default. Xoft does not require it; it is one independent provider among peers.
 * Its README describes it as for personal experimentation, not production — Xoft ranks it after the direct providers by default.
 */
export class FreeLLMAPIProvider extends OpenAICompatibleGateway {
  constructor(opts = {}) {
    super({ id: 'freellmapi', ...opts });
    this.capabilities = ['gateway', 'free', 'multi-model', 'fallback', 'general', 'coding', 'tools'];
  }
}
