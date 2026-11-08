import { AIProvider } from './AIProvider.js';
import { ProviderError } from './errors.js';
import { config } from '../config/index.js';
import { GATEWAY_DEFAULTS, gatewayConfigState, redactSecrets } from './gatewayConfig.js';

const MODELS_OK_TTL_MS = 60_000;
const MODELS_FAIL_TTL_MS = 15_000; // don't hammer a gateway that just failed model discovery
const NETWORK_UNREACHABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_SOCKET']);
const NETWORK_TIMEOUT = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

function parseRetryAfter(h) {
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, Math.min(secs * 1000, 5 * 60_000));
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, Math.min(t - Date.now(), 5 * 60_000)) : null;
}

/**
 * OpenAICompatibleGateway — shared implementation for optional OpenAI-compatible gateways (FreeLLMAPI, LiteLLM).
 *
 * A gateway is *just another provider inside the existing ProviderRouter*. It never owns tools, self-editing, files, the browser or
 * the terminal: it only supplies model output. Tool calls come back normalized ({name, input}) and are executed by Xoft's own executor.
 *
 * Failure model: nothing in here can crash Xoft. Missing/invalid configuration is a *state* (see gatewayConfigState); network/HTTP
 * failures become typed ProviderErrors that ProviderRouter isolates and falls back from. Settings are read from `config` at call time,
 * so they can be changed at runtime (Settings UI) without a restart.
 */
export class OpenAICompatibleGateway extends AIProvider {
  kind = 'gateway';
  capabilities = ['gateway', 'multi-model', 'fallback', 'general', 'tools'];

  /** @param {{ id:string, fetchImpl?:Function }} o */
  constructor({ id, fetchImpl = null }) {
    super();
    this.name = id;
    this.id = id;
    this.label = GATEWAY_DEFAULTS[id].label;
    this._fetch = fetchImpl;
    this._modelOverride = null;
    this._models = { at: 0, ok: false, models: [], error: null };
    this.lastProbe = null;
  }

  get cfg() { return config.providers[this.id]; }
  isEnabled() { return Boolean(this.cfg?.enabled); }
  configState() { return gatewayConfigState(this.id, this.cfg); }
  isConfigured() { return this.configState().configured; }

  getModel() { return this._modelOverride ?? (this.cfg?.model || null); }
  setModel(model) {
    if (!model || typeof model !== 'string' || model.length > 200) throw new Error(`${this.label}: a model name (string, max 200 chars) is required`);
    this._modelOverride = model.trim();
    return this._modelOverride;
  }

  /** Capability query used by ProviderRouter to avoid sending a request a provider was not configured to handle. */
  supports({ tools = false, vision = false } = {}) {
    if (tools && this.cfg?.tools === false) return false;
    if (vision && !this.cfg?.vision) return false;
    return true;
  }

  // ---------- transport ----------
  _secrets() { return [this.cfg?.apiKey]; }
  _clean(text) { return redactSecrets(text, this._secrets()); }
  _headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json', ...extra };
    if (this.cfg?.apiKey) h.Authorization = `Bearer ${this.cfg.apiKey}`;
    return h;
  }
  _requireConfigured() {
    const st = this.configState();
    if (!st.configured) throw new ProviderError(`${this.label}: not available — ${st.state === 'disabled' ? `disabled (set ${this.id.toUpperCase()}_ENABLED=true)` : st.issue}`, { errorType: 'unavailable', provider: this.id });
    return st.baseUrl;
  }

  async _http(path, { method = 'GET', body, timeoutMs, signal, headers } = {}) {
    const base = this._requireConfigured();
    const to = timeoutMs ?? this.cfg.timeoutMs ?? 60000;
    const signals = [AbortSignal.timeout(to)];
    if (signal) signals.push(signal);
    let res;
    try {
      res = await (this._fetch ?? globalThis.fetch)(`${base}${path}`, { method, headers: this._headers(headers), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any(signals) });
    } catch (err) {
      const code = err?.cause?.code ?? err?.code;
      if (signal?.aborted) throw new ProviderError(`${this.label}: request cancelled`, { errorType: 'cancelled', provider: this.id });
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || NETWORK_TIMEOUT.has(code)) throw new ProviderError(`${this.label}: timeout after ${to}ms`, { errorType: 'timeout', provider: this.id });
      if (NETWORK_UNREACHABLE.has(code) || err instanceof TypeError) throw new ProviderError(`${this.label}: cannot reach ${base} (${code ?? 'network error'}). Is the gateway running?`, { errorType: 'unavailable', provider: this.id });
      throw new ProviderError(`${this.label}: request failed (${this._clean(err?.message)})`, { errorType: 'unknown', provider: this.id });
    }
    if (!res.ok) {
      let snippet = '';
      try { snippet = this._clean((await res.text()).slice(0, 200)).replace(/\s+/g, ' '); } catch { /* body unreadable */ }
      const s = res.status;
      const errorType = s === 401 || s === 403 ? 'auth' : s === 429 ? 'rate_limit' : s === 408 || s === 504 ? 'timeout' : s >= 500 ? 'server_error' : 'invalid_request';
      throw new ProviderError(`${this.label}: HTTP ${s} (${errorType})${snippet ? ` — ${snippet}` : ''}`, { errorType, status: s, provider: this.id, retryAfterMs: parseRetryAfter(res.headers?.get?.('retry-after')) });
    }
    return res;
  }

  async _json(res) {
    try { return await res.json(); } catch { throw new ProviderError(`${this.label}: the gateway returned a non-JSON response (is the base URL correct? it should end in /v1)`, { errorType: 'server_error', provider: this.id }); }
  }

  // ---------- models ----------
  /** Discovery. Cached briefly (also on failure). Never assumes models exist. */
  async listModels({ force = false } = {}) {
    const now = Date.now();
    const c = this._models;
    if (!force && c.at && now - c.at < (c.ok ? MODELS_OK_TTL_MS : MODELS_FAIL_TTL_MS)) {
      if (c.ok) return c.models;
      throw c.error;
    }
    try {
      const res = await this._http('/models', { timeoutMs: Math.min(this.cfg.timeoutMs ?? 10000, 10000) });
      const data = await this._json(res);
      const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : Array.isArray(data?.models) ? data.models : null;
      if (!arr) throw new ProviderError(`${this.label}: /models returned an unrecognised shape`, { errorType: 'server_error', provider: this.id });
      const models = arr.map((m) => (typeof m === 'string' ? { id: m } : { id: m.id ?? m.name ?? m.model, ...m })).filter((m) => m.id);
      this._models = { at: now, ok: true, models, error: null };
      return models;
    } catch (err) {
      this._models = { at: now, ok: false, models: [], error: err };
      throw err;
    }
  }

  /** Configured model, else the runtime-selected one, else the first discovered model. Throws a clear error if none can be determined. */
  async _resolveModel(requested) {
    const m = requested || this.getModel();
    if (m) return m;
    let models = [];
    try { models = await this.listModels(); } catch { /* discovery failure handled below */ }
    if (models.length) return models[0].id;
    throw new ProviderError(`${this.label}: no model configured and none discovered — set ${this.id.toUpperCase()}_MODEL to a model name your gateway serves`, { errorType: 'invalid_request', provider: this.id });
  }

  // ---------- chat ----------
  _buildBody({ messages, system, tools, maxTokens = 1024, model, temperature }, resolvedModel, stream = false) {
    const body = { model: resolvedModel, max_tokens: maxTokens, messages: system ? [{ role: 'system', content: system }, ...messages] : messages };
    if (temperature !== undefined) body.temperature = temperature;
    if (tools?.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    if (stream) body.stream = true;
    return body;
  }

  _parseToolCalls(list) {
    if (!Array.isArray(list) || !list.length) return undefined;
    return list.map((tc) => {
      const name = tc?.function?.name;
      const raw = tc?.function?.arguments;
      let input = {};
      if (typeof raw === 'string' && raw.trim()) {
        try { input = JSON.parse(raw); } catch { throw new ProviderError(`${this.label}: the model produced tool call '${name}' with malformed JSON arguments`, { errorType: 'invalid_request', provider: this.id }); }
      } else if (raw && typeof raw === 'object') input = raw;
      if (!name) throw new ProviderError(`${this.label}: a tool call had no name`, { errorType: 'invalid_request', provider: this.id });
      return { name, input };
    });
  }

  _normalize(data, model, res) {
    const choice = data?.choices?.[0];
    if (!choice) throw new ProviderError(`${this.label}: response had no choices`, { errorType: 'server_error', provider: this.id });
    const content = choice.message?.content;
    const text = Array.isArray(content) ? content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('') : (content ?? '');
    return {
      text,
      toolCalls: this._parseToolCalls(choice.message?.tool_calls),
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0, costUSD: data.usage?.cost ?? null },
      raw: `${this.id}:${data.model ?? model}`,
      routedVia: res?.headers?.get?.('x-routed-via') ?? null, // FreeLLMAPI reports which upstream actually served the request
      finishReason: choice.finish_reason ?? null,
    };
  }

  async complete(params) {
    const model = await this._resolveModel(params.model);
    const res = await this._http('/chat/completions', { method: 'POST', body: this._buildBody(params, model), signal: params.signal });
    return this._normalize(await this._json(res), model, res);
  }

  /**
   * Streaming (SSE). Yields { type:'text', delta } then one { type:'done', result }. Errors before the first chunk reject cleanly so the router
   * can fall back to another provider; an error after output has started surfaces as a thrown ProviderError (a stream cannot be re-homed).
   */
  async *stream(params) {
    const model = await this._resolveModel(params.model);
    const res = await this._http('/chat/completions', { method: 'POST', body: this._buildBody(params, model, true), signal: params.signal, headers: { Accept: 'text/event-stream' } });
    const ctype = res.headers?.get?.('content-type') ?? '';
    if (!res.body || ctype.includes('application/json')) { // gateway ignored stream:true and answered in one piece
      const result = this._normalize(await this._json(res), model, res);
      if (result.text) yield { type: 'text', delta: result.text };
      yield { type: 'done', result };
      return;
    }
    const idleMs = Math.min(this.cfg.timeoutMs ?? 60000, 60000);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = ''; let text = ''; let usage = null; let finish = null; let respModel = model;
    const tcs = new Map();
    const readChunk = () => {
      let timer;
      const idle = new Promise((_, rej) => { timer = setTimeout(() => rej(new ProviderError(`${this.label}: stream idle for ${idleMs}ms`, { errorType: 'timeout', provider: this.id })), idleMs); });
      return Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
    };
    const handleLine = (line) => {
      if (!line.startsWith('data:')) return null;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return payload === '[DONE]' ? 'done' : null;
      let j; try { j = JSON.parse(payload); } catch { return null; } // ignore keep-alive / non-JSON frames
      if (j.error) throw new ProviderError(`${this.label}: stream error — ${this._clean(String(j.error.message ?? j.error).slice(0, 200))}`, { errorType: 'server_error', provider: this.id });
      respModel = j.model ?? respModel;
      if (j.usage) usage = j.usage;
      const ch = j.choices?.[0]; if (!ch) return null;
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta ?? {};
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? 0; const cur = tcs.get(i) ?? { function: { name: '', arguments: '' } };
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        tcs.set(i, cur);
      }
      return typeof d.content === 'string' && d.content ? d.content : null;
    };
    try {
      let done = false;
      while (!done) {
        const { value, done: eof } = await readChunk();
        if (eof) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, ''); buf = buf.slice(nl + 1);
          const out = handleLine(line);
          if (out === 'done') { done = true; break; }
          if (out) { text += out; yield { type: 'text', delta: out }; }
        }
      }
      if (buf.trim()) { const out = handleLine(buf.trim()); if (out && out !== 'done') { text += out; yield { type: 'text', delta: out }; } }
    } finally { try { await reader.cancel(); } catch { /* already closed */ } }
    yield { type: 'done', result: { text, toolCalls: this._parseToolCalls([...tcs.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)), usage: { inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0, costUSD: usage?.cost ?? null }, raw: `${this.id}:${respModel}`, routedVia: res.headers?.get?.('x-routed-via') ?? null, finishReason: finish } };
  }

  // ---------- embeddings ----------
  supportsEmbeddings() { return Boolean(this.cfg?.embeddingModel) && this.isConfigured(); }
  async embed(input) {
    if (!this.cfg?.embeddingModel) throw new ProviderError(`${this.label}: no embedding model configured (set ${this.id.toUpperCase()}_EMBEDDING_MODEL)`, { errorType: 'invalid_request', provider: this.id });
    const res = await this._http('/embeddings', { method: 'POST', body: { model: this.cfg.embeddingModel, input } });
    const data = await this._json(res);
    const rows = Array.isArray(data?.data) ? [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : null;
    if (!rows?.length || !rows.every((r) => Array.isArray(r.embedding))) throw new ProviderError(`${this.label}: embeddings response had an unrecognised shape`, { errorType: 'server_error', provider: this.id });
    const vectors = rows.map((r) => r.embedding);
    return Array.isArray(input) ? vectors : vectors[0];
  }

  // ---------- connection test ----------
  /**
   * Real connectivity + credential check (GET /models). A URL merely existing is never "healthy".
   * @returns {{result:'CONNECTED'|'NOT_CONFIGURED'|'UNAVAILABLE'|'AUTHENTICATION_ERROR'|'TIMEOUT'|'SERVER_ERROR'|'INVALID_CONFIGURATION', latencyMs:number|null, modelCount:number|null, message:string, httpStatus:number|null}}
   */
  async probe() {
    const st = this.configState();
    const done = (result, message, extra = {}) => { const r = { result, latencyMs: null, modelCount: null, httpStatus: null, message, ...extra }; this.lastProbe = { result, at: Date.now() }; return r; };
    if (st.state === 'disabled') return done('NOT_CONFIGURED', `${this.label} is disabled.`);
    if (st.state === 'unconfigured') return done('NOT_CONFIGURED', st.issue);
    if (st.state === 'invalid_configuration') return done('INVALID_CONFIGURATION', st.issue);
    const t0 = Date.now();
    try {
      const models = await this.listModels({ force: true });
      return done('CONNECTED', `Connected. ${models.length} model(s) discoverable.`, { latencyMs: Date.now() - t0, modelCount: models.length });
    } catch (err) {
      const latencyMs = Date.now() - t0;
      const msg = this._clean(err.message);
      if (err.status === 404) return done('INVALID_CONFIGURATION', `${msg} — the /models endpoint was not found; check the base URL (it should end in /v1).`, { latencyMs, httpStatus: 404 });
      if (/non-JSON|unrecognised shape/.test(err.message)) return done('INVALID_CONFIGURATION', msg, { latencyMs });
      const map = { auth: 'AUTHENTICATION_ERROR', timeout: 'TIMEOUT', server_error: 'SERVER_ERROR', rate_limit: 'SERVER_ERROR', unavailable: 'UNAVAILABLE' };
      return done(map[err.errorType] ?? 'UNAVAILABLE', msg, { latencyMs, httpStatus: err.status ?? null });
    }
  }
}
