import { OpenAIProvider } from './OpenAIProvider.js';
import { GeminiProvider } from './GeminiProvider.js';
import { ClaudeProvider } from './ClaudeProvider.js';
import { GrokProvider } from './GrokProvider.js';
import { OllamaProvider } from './OllamaProvider.js';
import { ExperientialProvider } from './ExperientialProvider.js';
import { FreeLLMAPIProvider } from './FreeLLMAPIProvider.js';
import { LiteLLMProvider } from './LiteLLMProvider.js';
import { NoAiProviderError, AllProvidersFailedError, ProviderRoutingConfigError, classifyProviderError } from './errors.js';
import { gatewayConfigState, GATEWAY_IDS } from './gatewayConfig.js';
import { deriveProviderState } from './providerState.js';
import { config } from '../config/index.js';

// How long an OPTIONAL gateway is parked (not retried while any other candidate can answer) after each kind of failure.
// Deliberately short for "server down"/"timeout" (it may just be starting) and long for "bad key" (retrying cannot help).
// Cleared immediately by a successful connection test or a settings change (router.resetProviderHealth).
const GATEWAY_COOLDOWN_MS = { auth: 5 * 60_000, unavailable: 30_000, timeout: 30_000, server_error: 30_000, rate_limit: 60_000, invalid_request: 0, unknown: 15_000, cancelled: 0 };

const isGateway = (p) => p?.kind === 'gateway';
// A provider whose isConfigured() throws must be treated as "not configured" — never let one provider break routing.
const safeConfigured = (p) => { try { return Boolean(p?.isConfigured?.()); } catch { return false; } };
const hasImages = (params) => (params?.messages ?? []).some((m) => Array.isArray(m?.content) && m.content.some((c) => c && (c.type === 'image' || c.type === 'image_url')));

/**
 * Task types the router understands. Callers (Orchestrator, agents) pass one
 * of these instead of naming a model — the router decides which configured
 * provider actually handles it.
 */
export const TaskType = {
  SIMPLE: 'simple', // quick classification, short replies -> cheap/fast model
  REASONING: 'reasoning', // multi-step planning, complex judgement -> strongest model
  CODING: 'coding', // code generation/debugging
  LONG_CONTEXT: 'long_context', // large documents
  RESEARCH: 'research', // paired with web search tool results
  EMBEDDING: 'embedding', // vector memory
};

export class ProviderRouter {
  /** @param {import('./ModelHealthManager.js').ModelHealthManager} [healthManager] */
  constructor(healthManager, { privacy = null } = {}) {
    /** Optional PrivacyClassifier module. null = privacy routing OFF (previous behavior). */
    this.privacy = privacy;
    // Instantiated lazily so missing API keys don't throw at import time.
    this._instances = {
      openai: new OpenAIProvider(),
      openaiFast: new OpenAIProvider({ fast: true }),
      gemini: new GeminiProvider(),
      claude: new ClaudeProvider(),
      grok: new GrokProvider(),
      ollama: new OllamaProvider(),
      experiential: new ExperientialProvider(),
      // Optional OpenAI-compatible gateways: independent peers of every other provider, disabled unless configured.
      freellmapi: new FreeLLMAPIProvider(),
      litellm: new LiteLLMProvider(),
    };
    this.healthManager = healthManager ?? null;
  }

  /**
   * Ordered preference list per task type. First configured provider wins.
   * Ollama (local, offline-capable) is always last — it's a fallback for
   * "no internet / all cloud providers down", not a first choice, since a
   * local model is weaker than any cloud model.
   *
   * If AI_PRIMARY_PROVIDER is set (config.aiRouting.primaryProvider), it
   * overrides this task-aware ordering for EVERY task type: that provider
   * goes first, then AI_FALLBACK_PROVIDERS in the given order, then Ollama
   * last as always. If AI_FALLBACK_ENABLED=false, the list is just the
   * primary provider alone (plus Ollama, since Ollama is an explicit local
   * opt-in the user enabled separately — "no fallback" means no *cloud*
   * fallback, not "ignore the local model you configured").
   */
  _preferenceFor(taskType) {
    const local = this._instances.ollama;
    const { primaryProvider, fallbackEnabled, fallbackProviders } = config.aiRouting;

    if (primaryProvider) {
      const byName = (n) => this._instances[n] ?? null;
      const primary = byName(primaryProvider);
      if (!primary) {
        throw new ProviderRoutingConfigError(`ProviderRouter: AI_PRIMARY_PROVIDER='${primaryProvider}' does not match any known provider (${Object.keys(this._instances).filter((n) => n !== 'openaiFast').join(', ')}).`);
      }
      if (!fallbackEnabled) return [primary, local].filter((p, i, arr) => p && arr.indexOf(p) === i);
      const fallbacks = fallbackProviders.map(byName).filter(Boolean);
      return [primary, ...fallbacks, local].filter((p, i, arr) => p && arr.indexOf(p) === i);
    }

    const experiential = this._instances.experiential;
    const gateway = safeConfigured(experiential) ? [experiential] : [];
    // FreeLLMAPI / LiteLLM are peers, not "the best provider": by default they rank after the direct providers and before the local
    // model, so enabling one never changes which direct provider answers. To make one primary, use AI_PRIMARY_PROVIDER / AI_FALLBACK_PROVIDERS.
    const gw = [this._instances.litellm, this._instances.freellmapi];
    switch (taskType) {
      case TaskType.SIMPLE:
        return [...gateway, this._instances.openaiFast, this._instances.gemini, this._instances.claude, this._instances.grok, ...gw, local];
      case TaskType.REASONING:
        return [...gateway, this._instances.claude, this._instances.grok, this._instances.openai, this._instances.gemini, ...gw, local];
      case TaskType.CODING:
        return [...gateway, this._instances.claude, this._instances.openai, this._instances.grok, this._instances.gemini, ...gw, local];
      case TaskType.LONG_CONTEXT:
        return [...gateway, this._instances.gemini, this._instances.claude, this._instances.openai, this._instances.grok, ...gw, local];
      case TaskType.RESEARCH:
        return [...gateway, this._instances.claude, this._instances.openai, this._instances.grok, this._instances.gemini, ...gw, local];
      default:
        return [...gateway, this._instances.openai, this._instances.claude, this._instances.grok, this._instances.gemini, ...gw, local];
    }
  }

  /**
   * Picks the first configured provider for the task type. Throws a structured NoAiProviderError
   * (code NO_AI_PROVIDER_AVAILABLE) if none is configured — never silently falls back to a fake response.
   */
  select(taskType) {
    const candidates = this._preferenceFor(taskType);
    const chosen = candidates.find((p) => safeConfigured(p));
    if (!chosen) {
      const names = candidates.map((p) => p.name);
      throw new NoAiProviderError(
        `ProviderRouter: no configured provider available for task '${taskType}'. ` +
          `Tried: ${names.join(', ')}. Set at least one API key in .env.`,
        { taskType, tried: names },
      );
    }
    return chosen;
  }

  /**
   * Provider used specifically for embeddings (vector memory). OpenAI first (unchanged); otherwise a gateway that has an
   * embedding model configured (FREELLMAPI_EMBEDDING_MODEL / LITELLM_EMBEDDING_MODEL). No embedding provider => semantic
   * memory is simply off (MemoryManager already handles this), everything else keeps working.
   */
  selectEmbedding() {
    const p = this._instances.openai;
    if (safeConfigured(p)) return p;
    const gw = [this._instances.litellm, this._instances.freellmapi].find((g) => safeConfigured(g) && g.supportsEmbeddings?.());
    if (gw) return gw;
    throw new NoAiProviderError('ProviderRouter: embeddings require OPENAI_API_KEY, or a gateway with an embedding model set (LITELLM_EMBEDDING_MODEL / FREELLMAPI_EMBEDDING_MODEL).', { taskType: 'embedding', tried: ['openai', 'litellm', 'freellmapi'] });
  }

  /**
   * Provider used specifically for image/screenshot understanding.
   * Only Claude and OpenAI accept image content blocks natively in this codebase — GeminiProvider.complete() has no image branch, so
   * it is deliberately excluded. A gateway is included ONLY when the operator asserted its model accepts images
   * (FREELLMAPI_VISION=true / LITELLM_VISION=true): the router never assumes a gateway model is vision-capable.
   */
  selectVision() {
    const candidates = [this._instances.claude, this._instances.openai, this._instances.litellm, this._instances.freellmapi]
      .filter((p) => safeConfigured(p) && (!isGateway(p) || p.supports({ vision: true })));
    if (!candidates.length) {
      throw new NoAiProviderError(
        'ProviderRouter: no vision-capable provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or enable a gateway and set <GATEWAY>_VISION=true for a vision model. ' +
          '(Gemini is not wired for image input in this codebase.)',
        { taskType: 'vision', tried: ['claude', 'openai', 'litellm', 'freellmapi'] },
      );
    }
    return candidates[0];
  }

  /** Raw instance lookup, no isConfigured() check — used for things like reachability pings. */
  getInstance(name) {
    return this._instances[name] ?? null;
  }

  getProvider(name) {
    const provider = this._instances[name];
    if (!provider) throw new Error(`ProviderRouter: unknown provider '${name}'`);
    if (!safeConfigured(provider)) throw new Error(`ProviderRouter: provider '${name}' is not configured`);
    return provider;
  }

  /** Select a model on the Experiential gateway for subsequent requests. */
  setModel(model, { provider = 'experiential' } = {}) {
    const target = this.getProvider(provider);
    if (typeof target.setModel !== 'function') throw new Error(`ProviderRouter: provider '${provider}' does not support runtime model selection`);
    return { provider, model: target.setModel(model) };
  }

  getModel(provider = 'experiential') {
    const target = this._instances[provider];
    if (!target) throw new Error(`ProviderRouter: unknown provider '${provider}'`);
    return typeof target.getModel === 'function' ? target.getModel() : null;
  }

  async listModels(provider = 'experiential') {
    const target = this._instances[provider];
    if (!target || typeof target.listModels !== 'function') throw new Error(`ProviderRouter: provider '${provider}' does not expose a model catalog`);
    return target.listModels();
  }

  /** Candidates for a call: configured, capable of what the request needs, privacy-filtered. Pure selection — no network. */
  _candidates(taskType, params) {
    let candidates = this._preferenceFor(taskType).filter((p) => safeConfigured(p));
    // Capability gating: never send a request to a gateway that was not configured for what it needs.
    const needsTools = Boolean(params?.tools?.length);
    const needsVision = hasImages(params);
    candidates = candidates.filter((p) => !isGateway(p) || p.supports({ tools: needsTools, vision: needsVision }));
    // Privacy routing (opt-in via PRIVACY_ROUTING=true). Fails closed: SECRET data is never sent to a cloud provider, even if
    // that means the call fails. Gateways are treated as remote (a localhost gateway forwards to cloud models), so only Ollama qualifies.
    if (this.privacy) {
      const level = this.privacy.classifyParams(params);
      const local = candidates.filter((p) => p.name === 'ollama');
      const route = this.privacy.routeFor(level, { localAvailable: local.length > 0 });
      if (route.requireLocal) {
        if (!local.length) throw new NoAiProviderError(`ProviderRouter: ${level} content requires a local provider (enable Ollama); refusing to send it to a cloud provider.`, { taskType, tried: candidates.map((p) => p.name) });
        candidates = local;
      }
      if (route.redact) params = this.privacy.redactParams(params);
      params = { ...params };
      delete params.privacy; // routing hint only — never forwarded to a provider
    }
    return { candidates, params };
  }

  /**
   * Try order: healthy configured providers first, then merely-unhealthy ones as a last resort ("degraded beats dead"). Optional
   * gateways that are hard-cooling (offline / bad key / rate-limited) are NOT retried while they cool down — Xoft must not hammer a
   * dead or rejecting gateway on every request. Each provider is tried at most once per call, so this is bounded.
   */
  _tryOrder(candidates) {
    const hm = this.healthManager;
    const parked = candidates.filter((p) => isGateway(p) && hm?.isHardCooling?.(p.name));
    const active = candidates.filter((p) => !parked.includes(p));
    const healthy = active.filter((p) => hm?.isHealthy(p.name) ?? true);
    const unhealthy = active.filter((p) => !(hm?.isHealthy(p.name) ?? true));
    return { order: [...healthy, ...unhealthy], parked };
  }

  _recordFailure(provider, err) {
    const errorType = classifyProviderError(err);
    const hard = isGateway(provider) ? (err?.retryAfterMs && errorType === 'rate_limit' ? Math.min(err.retryAfterMs, 5 * 60_000) : (GATEWAY_COOLDOWN_MS[errorType] ?? 0)) : 0;
    this.healthManager?.recordFailure(provider.name, hard ? { errorType, hardCooldownMs: hard } : { errorType });
    return errorType;
  }

  _throwExhausted(taskType, candidates, attempts, parked) {
    const tried = candidates.map((p) => p.name);
    if (attempts.length === 0) {
      const why = parked.length ? ` (${parked.map((p) => p.name).join(', ')} cooling down after recent failures)` : '';
      throw new NoAiProviderError(`ProviderRouter: no available provider for task '${taskType}'${why}. Tried: ${tried.join(', ')}.`, { taskType, tried, attempts });
    }
    const last = attempts[attempts.length - 1];
    throw new AllProvidersFailedError(`ProviderRouter: all configured providers failed for task '${taskType}'. Last error: ${last.message}`, { taskType, tried, attempts });
  }

  async complete(taskType, params) {
    const prepared = this._candidates(taskType, params);
    const { candidates } = prepared; params = prepared.params;
    if (candidates.length === 0) {
      const names = this._preferenceFor(taskType).map((p) => p.name);
      throw new NoAiProviderError(
        `ProviderRouter: no configured provider available for task '${taskType}'. ` +
          `Tried: ${names.join(', ')}. Set at least one API key in .env.`,
        { taskType, tried: names },
      );
    }
    const { order, parked } = this._tryOrder(candidates);
    const attempts = [];
    for (const provider of order) {
      const start = Date.now();
      try {
        const result = await provider.complete(params);
        this.healthManager?.recordSuccess(provider.name, { latencyMs: Date.now() - start, inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens });
        return result;
      } catch (err) {
        // Failure isolation: whatever a provider throws (typed error, plain Error, even a non-Error) is recorded and we move on.
        if (err?.errorType === 'cancelled') throw err; // the caller aborted; that is not a provider failure
        const errorType = this._recordFailure(provider, err);
        attempts.push({ provider: provider.name, errorType, message: String(err?.message ?? err).slice(0, 300) });
      }
    }
    this._throwExhausted(taskType, candidates, attempts, parked);
  }

  /**
   * Streaming with the same selection, health and fallback rules as complete(). Yields {type:'text', delta} chunks and a final
   * {type:'done', result}. Providers without native streaming (all the older ones) are served via complete() and yielded as one
   * chunk, so callers can always use this. If a provider fails BEFORE producing any output the router falls back to the next
   * one; once text has been emitted a stream cannot be re-homed, so the error is thrown to the caller.
   */
  async *stream(taskType, params) {
    const prepared = this._candidates(taskType, params);
    const { candidates } = prepared; params = prepared.params;
    if (candidates.length === 0) {
      const names = this._preferenceFor(taskType).map((p) => p.name);
      throw new NoAiProviderError(`ProviderRouter: no configured provider available for task '${taskType}'. Tried: ${names.join(', ')}. Set at least one API key in .env.`, { taskType, tried: names });
    }
    const { order, parked } = this._tryOrder(candidates);
    const attempts = [];
    for (const provider of order) {
      const start = Date.now();
      let emitted = false;
      try {
        if (typeof provider.stream === 'function') {
          for await (const ev of provider.stream(params)) {
            if (ev.type === 'text') emitted = true;
            if (ev.type === 'done') this.healthManager?.recordSuccess(provider.name, { latencyMs: Date.now() - start, inputTokens: ev.result.usage?.inputTokens, outputTokens: ev.result.usage?.outputTokens });
            yield ev;
            if (ev.type === 'done') return;
          }
          throw Object.assign(new Error(`${provider.name}: stream ended without a completion event`), { errorType: 'server_error' });
        }
        const result = await provider.complete(params);
        this.healthManager?.recordSuccess(provider.name, { latencyMs: Date.now() - start, inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens });
        if (result.text) yield { type: 'text', delta: result.text };
        yield { type: 'done', result };
        return;
      } catch (err) {
        if (err?.errorType === 'cancelled') throw err;
        const errorType = this._recordFailure(provider, err);
        attempts.push({ provider: provider.name, errorType, message: String(err?.message ?? err).slice(0, 300) });
        if (emitted) throw err; // partial output already delivered — cannot silently switch providers mid-answer
      }
    }
    this._throwExhausted(taskType, candidates, attempts, parked);
  }

  // ---------- status, connection tests ----------

  /** Forget health history for a provider (its config changed, or a connection test just succeeded). */
  resetProviderHealth(name) { this.healthManager?.reset?.(name); }

  /** Secret-free status for one gateway. */
  gatewayStatus(id) {
    const p = this._instances[id];
    const cfg = config.providers[id];
    const cs = gatewayConfigState(id, cfg);
    const health = this.healthManager?.getStats(id) ?? null;
    const derived = deriveProviderState({ config: cs, health, cooldown: this.healthManager?.getCooldown?.(id) ?? null, probe: p?.lastProbe ?? null });
    const available = derived.state === 'available' || (derived.state === 'starting' && derived.configured); // configured & nothing has failed => usable (unproven until first call/test)
    return { id, label: p.label, enabled: Boolean(cfg.enabled), available, health: derived.state === 'available' ? 'healthy' : derived.state === 'starting' ? (derived.configured ? 'untested' : 'unconfigured') : derived.state, ...derived, model: p.getModel?.() ?? null, calls: health?.calls ?? 0, failures: health?.failureCount ?? 0, avgLatencyMs: health?.avgLatencyMs ?? null };
  }

  /** Real connectivity/credential test for a gateway. A successful test clears any cooldown so the fix takes effect immediately. */
  async probeProvider(id) {
    const p = this._instances[id];
    if (!p || typeof p.probe !== 'function') throw new Error(`ProviderRouter: provider '${id}' has no connection test`);
    const r = await p.probe();
    if (r.result === 'CONNECTED') this.resetProviderHealth(id);
    return r;
  }

  configuredProviders() {
    return Object.values(this._instances)
      .filter((p) => safeConfigured(p))
      .map((p) => p.name);
  }
}
