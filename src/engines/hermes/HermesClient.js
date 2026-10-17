import { EngineError, ErrorCode } from '../constants.js';

/**
 * Minimal HTTP/SSE client for the Hermes Agent API server.
 *
 * Endpoints used (all documented at hermes-agent.nousresearch.com/docs/user-guide/features/api-server):
 *   GET  /health                      public liveness
 *   GET  /health/detailed             authed readiness (config / model / disk / active runs)
 *   GET  /v1/capabilities             feature flags (run_submission, run_events_sse, run_stop, run_approval, …)
 *   GET  /v1/toolsets                 enabled native toolsets and their concrete tool names
 *   POST /v1/runs                     start a run  → 202 { run_id, status }   (Idempotency-Key supported)
 *   GET  /v1/runs/{id}                poll a run
 *   GET  /v1/runs/{id}/events         SSE: tool.started / tool.completed / message.* / approval.request / run.*
 *   POST /v1/runs/{id}/stop           interrupt
 *   POST /v1/runs/{id}/approval       resolve a pending approval (`once` | `deny`)
 *
 * No dependencies: Node 22's global fetch + a small SSE parser. Nothing here logs request bodies or the API key.
 */
export class HermesClient {
  /**
   * @param {{baseUrl:string, apiKey?:string, fetchImpl?:typeof fetch, requestTimeoutMs?:number}} opts
   */
  constructor({ baseUrl, apiKey = '', fetchImpl = globalThis.fetch, requestTimeoutMs = 15000 }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  setApiKey(key) { this.apiKey = key ?? ''; }
  get hasKey() { return Boolean(this.apiKey); }

  _headers(extra = {}, { auth = true } = {}) {
    const h = { Accept: 'application/json', ...extra };
    if (auth && this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async _request(method, path, { body, headers, auth = true, timeoutMs = this.requestTimeoutMs, signal } = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal) { if (signal.aborted) controller.abort(signal.reason); else signal.addEventListener('abort', onAbort, { once: true }); }
    const timer = setTimeout(() => controller.abort(new EngineError(ErrorCode.TIMEOUT, `Hermes ${method} ${path} timed out after ${timeoutMs}ms`, { retryable: true })), timeoutMs);
    try {
      const res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this._headers({ ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, { auth }),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      return res;
    } catch (err) {
      throw this._networkError(err, method, path, controller.signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  _networkError(err, method, path, signal) {
    if (err instanceof EngineError) return err;
    const reason = signal?.reason;
    if (reason instanceof EngineError) return reason;
    if (err?.name === 'AbortError' || signal?.aborted) return new EngineError(ErrorCode.INTERRUPTED, `Request ${method} ${path} was aborted`, { cause: err });
    return new EngineError(ErrorCode.UNAVAILABLE, `Cannot reach Hermes at ${this.baseUrl} (${err?.cause?.code ?? err?.code ?? err?.message ?? 'network error'})`, { retryable: true, cause: err });
  }

  async _json(res, method, path) {
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; } }
    if (res.ok) return data ?? {};
    throw this._httpError(res, data, method, path);
  }

  _httpError(res, data, method, path) {
    const detail = data?.error?.message ?? data?.message ?? data?.error ?? data?.detail ?? data?.raw ?? res.statusText ?? '';
    const msg = typeof detail === 'string' ? detail : JSON.stringify(detail);
    const tag = `Hermes ${method} ${path} → ${res.status}${msg ? ` ${msg}`.slice(0, 300) : ''}`;
    if (res.status === 401 || res.status === 403) return new EngineError(ErrorCode.UNAUTHORIZED, `${tag} (check HERMES_API_KEY / API_SERVER_KEY)`, { status: res.status });
    if (res.status === 404) return new EngineError(ErrorCode.NOT_FOUND, tag, { status: 404 });
    if (res.status === 429) return new EngineError(ErrorCode.RATE_LIMITED, tag, { status: 429, retryable: true, details: { retryAfter: Number(res.headers?.get?.('retry-after')) || null } });
    if (res.status === 409) return new EngineError(ErrorCode.INVALID, tag, { status: 409, details: { code: data?.code ?? data?.error?.code ?? null } });
    if (res.status >= 500) return new EngineError(ErrorCode.UNAVAILABLE, tag, { status: res.status, retryable: true });
    return new EngineError(ErrorCode.INVALID, tag, { status: res.status });
  }

  // ---- read-only probes ---------------------------------------------------------------------------------

  /** Public liveness probe (no auth needed). Never throws: returns { ok, status?, error? }. */
  async health() {
    try {
      const res = await this._request('GET', '/health', { auth: false, timeoutMs: 4000 });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok && (body?.status === undefined || body.status === 'ok'), httpStatus: res.status, body };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code };
    }
  }

  async detailedHealth() { return this._json(await this._request('GET', '/health/detailed', { timeoutMs: 8000 }), 'GET', '/health/detailed'); }
  async capabilities() { return this._json(await this._request('GET', '/v1/capabilities', { timeoutMs: 6000 }), 'GET', '/v1/capabilities'); }
  async toolsets() { return this._json(await this._request('GET', '/v1/toolsets', { timeoutMs: 8000 }), 'GET', '/v1/toolsets'); }
  async models() { return this._json(await this._request('GET', '/v1/models', { timeoutMs: 6000 }), 'GET', '/v1/models'); }

  // ---- runs ---------------------------------------------------------------------------------------------

  /**
   * Starts a run. `sessionId` ties every attempt of one Xoft task to one Hermes session so a resumed task keeps context.
   * @returns {Promise<{runId:string, status:string, replayed:boolean}>}
   */
  async createRun({ input, sessionId, instructions, conversationHistory, previousResponseId, model, provider, modelOptions }, { idempotencyKey, sessionKey, signal } = {}) {
    const body = { input };
    if (sessionId) body.session_id = sessionId;
    if (instructions) body.instructions = instructions;
    if (conversationHistory) body.conversation_history = conversationHistory;
    if (previousResponseId) body.previous_response_id = previousResponseId;
    if (model) body.model = model;
    if (provider) body.provider = provider;
    if (modelOptions) body.model_options = modelOptions;
    const headers = {};
    if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 255);
    if (sessionKey) headers['X-Hermes-Session-Key'] = String(sessionKey).slice(0, 256);
    const res = await this._request('POST', '/v1/runs', { body, headers, signal, timeoutMs: 30000 });
    const data = await this._json(res, 'POST', '/v1/runs');
    const runId = data.run_id ?? data.id;
    if (!runId) throw new EngineError(ErrorCode.PROTOCOL, 'Hermes /v1/runs did not return a run_id');
    return { runId, status: data.status ?? 'started', replayed: res.headers?.get?.('idempotency-replayed') === 'true' };
  }

  async getRun(runId) { return this._json(await this._request('GET', `/v1/runs/${encodeURIComponent(runId)}`), 'GET', `/v1/runs/${runId}`); }

  async stopRun(runId) { return this._json(await this._request('POST', `/v1/runs/${encodeURIComponent(runId)}/stop`, { body: {} }), 'POST', `/v1/runs/${runId}/stop`); }

  /**
   * Resolves a pending approval. Hermes documents `once` (run the tool) and `deny` (block it); the request body carries
   * the decision. `approvalId` is forwarded only when Hermes supplied one in its approval.request event.
   */
  async approveRun(runId, decision, approvalId = null) {
    const body = { decision };
    if (approvalId) body.approval_id = approvalId;
    return this._json(await this._request('POST', `/v1/runs/${encodeURIComponent(runId)}/approval`, { body }), 'POST', `/v1/runs/${runId}/approval`);
  }

  /**
   * Async iterator over a run's SSE stream: yields `{ event, data, id }` (data parsed as JSON when possible).
   * Comment lines (`: keepalive`) are skipped. Ends when the server closes the stream; throws EngineError on failure.
   * `idleTimeoutMs` aborts a silent connection (Hermes sends a keepalive at least every 10 s).
   */
  async *events(runId, { signal, idleTimeoutMs = 45000 } = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal) { if (signal.aborted) controller.abort(signal.reason); else signal.addEventListener('abort', onAbort, { once: true }); }
    let idle;
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(new EngineError(ErrorCode.TIMEOUT, `Hermes event stream for ${runId} went silent for ${idleTimeoutMs}ms`, { retryable: true })), idleTimeoutMs);
    };
    try {
      armIdle();
      let res;
      try {
        res = await this.fetch(`${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
          method: 'GET', headers: this._headers({ Accept: 'text/event-stream' }), signal: controller.signal,
        });
      } catch (err) { throw this._networkError(err, 'GET', `/v1/runs/${runId}/events`, controller.signal); }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let data = null; try { data = JSON.parse(text); } catch { data = text ? { raw: text } : null; }
        throw this._httpError(res, data, 'GET', `/v1/runs/${runId}/events`);
      }
      const decoder = new TextDecoder();
      let buffer = '';
      let frame = { event: null, data: [], id: null };
      const flush = function* flush() {
        if (frame.event === null && frame.data.length === 0) return;
        const raw = frame.data.join('\n');
        let data = raw;
        if (raw) { try { data = JSON.parse(raw); } catch { /* keep as text */ } }
        yield { event: frame.event, data, id: frame.id };
        frame = { event: null, data: [], id: null };
      };
      try {
        for await (const chunk of res.body) {
          armIdle();
          buffer += decoder.decode(chunk, { stream: true });
          let nl;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            let line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            if (line === '') { yield* flush(); continue; }
            if (line.startsWith(':')) continue; // comment / keepalive
            const colon = line.indexOf(':');
            const field = colon === -1 ? line : line.slice(0, colon);
            let value = colon === -1 ? '' : line.slice(colon + 1);
            if (value.startsWith(' ')) value = value.slice(1);
            if (field === 'event') frame.event = value;
            else if (field === 'data') frame.data.push(value);
            else if (field === 'id') frame.id = value;
          }
        }
        if (buffer.trim()) { /* trailing partial line without newline */ const l = buffer.replace(/\r$/, ''); if (l.startsWith('data:')) frame.data.push(l.slice(5).replace(/^ /, '')); }
        yield* flush();
      } catch (err) {
        throw this._networkError(err, 'GET', `/v1/runs/${runId}/events`, controller.signal);
      }
    } finally {
      clearTimeout(idle);
      signal?.removeEventListener?.('abort', onAbort);
      controller.abort();
    }
  }
}
