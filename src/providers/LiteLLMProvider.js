import { OpenAICompatibleGateway } from './OpenAICompatibleGateway.js';

/**
 * LiteLLM proxy (https://docs.litellm.ai/docs/simple_proxy) — a self-hosted OpenAI-compatible gateway that routes to 100+ providers
 * (default http://localhost:4000/v1). Model names are whatever the operator defines under `model_list[].model_name` in the proxy's
 * config.yaml — Xoft never hard-codes any; set LITELLM_MODEL or let Xoft discover them from GET /v1/models.
 * The proxy's master key is optional (a proxy started without one is open); when set, Xoft sends it as a bearer token.
 *
 * OPTIONAL: disabled by default. Xoft does not require it.
 */
export class LiteLLMProvider extends OpenAICompatibleGateway {
  constructor(opts = {}) {
    super({ id: 'litellm', ...opts });
    this.capabilities = ['gateway', 'multi-model', 'fallback', 'general', 'coding', 'reasoning', 'tools'];
  }
}
