import http from 'node:http';

/**
 * A REAL local HTTP server that behaves like an OpenAI-compatible gateway (FreeLLMAPI / LiteLLM shape): GET /v1/models,
 * POST /v1/chat/completions (JSON or SSE), POST /v1/embeddings, bearer auth, plus switchable failure modes.
 * It is a stand-in for the wire protocol — it does NOT prove behaviour against the real FreeLLMAPI/LiteLLM programs.
 */
export async function startMockGateway({ apiKey = null, models = ['model-a', 'model-b'], label = 'mock' } = {}) {
  const state = { mode: 'ok', requests: [], apiKey, models, label, routedVia: `${label}/upstream-x`, retryAfter: null };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { /* leave null */ }
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (status, obj, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
      if (state.mode === 'hang') return; // never answer: exercises client timeouts
      if (state.mode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>login page</html>'); }
      if (state.mode === '404') return send(404, { error: 'not found' });
      if (state.apiKey && req.headers.authorization !== `Bearer ${state.apiKey}`) return send(401, { error: { message: `Invalid API key provided: ${req.headers.authorization ?? '(none)'}` } });
      if (state.mode === '429') return send(429, { error: 'rate limited' }, state.retryAfter ? { 'Retry-After': String(state.retryAfter) } : {});
      if (state.mode === '500') return send(500, { error: 'boom' });
      if (state.mode === '503') return send(503, { error: 'overloaded' });
      if (req.method === 'GET' && req.url === '/v1/models') return send(200, { object: 'list', data: state.models.map((id) => ({ id, object: 'model', owned_by: label })) });
      if (req.method === 'POST' && req.url === '/v1/embeddings') {
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        // Deliberately returned OUT of index order so a client that fails to sort by `index` gets the vectors swapped.
        return send(200, { data: inputs.map((_, i) => ({ index: i, embedding: [i, i + 0.5] })).reverse() });
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const last = body?.messages?.at(-1)?.content;
        const lastText = typeof last === 'string' ? last : JSON.stringify(last);
        const wantsTool = body.tools?.length && /USE_TOOL/.test(lastText);
        const bad = /BAD_TOOL/.test(lastText);
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Routed-Via': state.routedVia });
          if (state.mode === 'stream-fail-early') { res.write('data: {"error":{"message":"upstream exploded"}}\n\n'); return res.end(); }
          const frame = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
          if (wantsTool) {
            frame({ model: body.model, choices: [{ delta: { tool_calls: [{ index: 0, function: { name: body.tools[0].function.name, arguments: '{"path":' } }] } }] });
            frame({ model: body.model, choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: 'tool_calls' }] });
          } else {
            for (const w of ['Hel', 'lo ', 'stream']) frame({ model: body.model, choices: [{ delta: { content: w } }] });
            frame({ model: body.model, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
          }
          res.write(': keep-alive\n\ndata: [DONE]\n\n'); return res.end();
        }
        const message = wantsTool || bad
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: (body.tools?.[0]?.function?.name ?? 'tool'), arguments: bad ? '{not json' : '{"path":"a.txt"}' } }] }
          : { role: 'assistant', content: `reply from ${label} model=${body.model}` };
        return send(200, { model: body.model, choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 5 } }, { 'X-Routed-Via': state.routedVia });
      }
      send(404, { error: 'no such route' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { state, port, baseUrl: `http://127.0.0.1:${port}/v1`, chatCalls: () => state.requests.filter((r) => r.url === '/v1/chat/completions').length, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

/** A port with nothing listening — for "gateway is offline" tests. */
export async function closedPort() {
  const s = http.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address(); await new Promise((r) => s.close(r)); return port;
}
