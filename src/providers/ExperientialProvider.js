import { AIProvider } from './AIProvider.js';
import { config } from '../config/index.js';

const DEFAULT_BASE_URL = 'https://api.experientiallabs.ai/v1';
// How long a fetched "which models can this key call for free" result is
// trusted before being re-fetched. Free-only is a safety check, not a
// performance-critical path, so this stays short rather than caching for a
// long time and risking a stale "yes this is free" verdict.
const FREE_CATALOG_CACHE_MS = 5 * 60 * 1000;

/**
 * Experiential Labs OpenAI-compatible model gateway
 * (https://platform.experientiallabs.ai/docs — real, currently-operating
 * service; verified against its live documentation, not assumed).
 *
 * One XOFT provider can address many model slugs. The active model may be
 * changed at runtime by ProviderRouter without changing the rest of XOFT.
 *
 * IMPORTANT — free-only safety: Experiential Labs' real API has no ":free"
 * model-slug suffix convention (that is an OpenRouter convention, not
 * theirs — confirmed against their live docs, which address models by
 * plain slugs like `claude-opus-5`). A model is either called on the
 * BYOK/pass-through lane (billed by the underlying provider, not
 * Experiential) or the platform-funded lane (billed from Experiential
 * credits, priced from their public catalog in nano-USD per million
 * tokens). There is no dedicated "free tier" flag documented. Given that,
 * `EXPERIENTIAL_FREE_ONLY=true` is implemented here as: only ever call a
 * model this key can use whose catalog entry the code can positively
 * confirm has zero cost. If a model's pricing can't be determined, it is
 * treated as NOT free — failing closed, never silently spending money on
 * an unverified assumption, and never mutating the model slug itself.
 */
export class ExperientialProvider extends AIProvider {
  name = 'experiential';
  capabilities = ['multi-model', 'routing', 'fallback', 'coding', 'reasoning', 'general', 'long-context'];

  constructor({ fetchImpl = fetch } = {}) {
    super();
    this.baseUrl = String(config.providers.experiential.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.model = config.providers.experiential.model;
    this._fetch = fetchImpl;
    this._freeModelCache = { ids: null, fetchedAt: 0 };
  }

  isConfigured() {
    return Boolean(config.providers.experiential.apiKey);
  }

  getModel() {
    return this.model;
  }

  setModel(model) {
    if (!model || typeof model !== 'string') throw new Error('ExperientialProvider: model slug is required');
    this.model = model.trim();
    return this.model;
  }

  /**
   * Best-effort, conservative free-cost check for one catalog entry. Checks
   * every pricing field shape Experiential's docs mention or that a
   * `/v1/models` "pricing extension" plausibly uses. Returns false (not
   * confirmed free) whenever the price can't be positively determined —
   * this is the fail-closed side of the zero-budget guarantee.
   */
  static _isFreeCatalogEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    const candidates = [
      entry.pricing?.input_nano_usd_per_million,
      entry.pricing?.output_nano_usd_per_million,
      entry.input_nano_usd_per_million,
      entry.output_nano_usd_per_million,
      entry.pricing?.prompt,
      entry.pricing?.completion,
      entry.price,
    ].filter((v) => v !== undefined && v !== null);
    if (candidates.length === 0) return false; // unknown price -> not eligible
    return candidates.every((v) => Number(v) === 0);
  }

  /**
   * The set of model ids this key can call at zero cost, per the
   * authenticated `/v1/models` catalog (what the key can actually call —
   * not the public, unauthenticated `/api/models` catalog, which mixes
   * models this key may not be able to use at all). Cached briefly; never
   * assumed without a real catalog fetch.
   */
  async _freeEligibleModelIds() {
    const now = Date.now();
    if (this._freeModelCache.ids && now - this._freeModelCache.fetchedAt < FREE_CATALOG_CACHE_MS) {
      return this._freeModelCache.ids;
    }
    const catalog = await this.listModels();
    const ids = new Set(
      (Array.isArray(catalog) ? catalog : [])
        .filter((entry) => ExperientialProvider._isFreeCatalogEntry(entry))
        .map((entry) => entry.id ?? entry.slug)
        .filter(Boolean),
    );
    this._freeModelCache = { ids, fetchedAt: now };
    return ids;
  }

  _resolveModel(requestedModel) {
    const selected = requestedModel || this.model;
    if (!selected) throw new Error('ExperientialProvider: no model selected. Set EXPERIENTIAL_MODEL or select a model at runtime.');
    return selected;
  }

  async complete({ messages, system, tools, maxTokens = 1024, model }) {
    if (!this.isConfigured()) throw new Error('ExperientialProvider: EXPERIENTIAL_API_KEY is not set');
    const resolvedModel = this._resolveModel(model);

    if (config.providers.experiential.freeOnly) {
      const eligible = await this._freeEligibleModelIds();
      if (!eligible.has(resolvedModel)) {
        // Fail closed and say exactly why, rather than either silently
        // spending platform credits or silently rewriting the model slug
        // into something invalid.
        throw new Error(
          `ExperientialProvider: EXPERIENTIAL_FREE_ONLY is enabled and model '${resolvedModel}' is not confirmed free for this API key ` +
          `(either its price is nonzero, or its cost could not be determined from the catalog). Select a confirmed-free model, ` +
          `or set EXPERIENTIAL_FREE_ONLY=false if paid usage is intended.`,
        );
      }
    }

    const body = {
      model: resolvedModel,
      max_tokens: maxTokens,
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    };

    if (tools?.length) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }

    const res = await this._fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.providers.experiential.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`ExperientialProvider: API error ${res.status} - ${errText}`);
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
        costUSD: data.usage?.cost ?? data.usage?.cost_usd ?? null,
      },
      raw: `experiential:${resolvedModel}`,
    };
  }

  async listModels() {
    // Authenticated /v1/models (what this key can actually call, with its
    // pricing extension) when configured; falls back to the public,
    // unauthenticated /api/models catalog (browsable, but does not reflect
    // what a specific key can call) only for browsing before a key exists.
    const url = this.isConfigured() ? `${this.baseUrl}/models` : 'https://api.experientiallabs.ai/api/models?limit=200';
    const headers = this.isConfigured() ? { Authorization: `Bearer ${config.providers.experiential.apiKey}` } : {};
    const res = await this._fetch(url, { headers });
    if (!res.ok) throw new Error(`ExperientialProvider: model catalog error ${res.status} - ${await res.text()}`);
    const data = await res.json();
    return data.data ?? data.models ?? data;
  }
}
