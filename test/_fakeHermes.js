// Test helper (not a test): an in-process fake of the Hermes Agent API server — /health, /v1/capabilities, /v1/toolsets,
// /v1/runs (+ SSE events, stop, approval). Behaviour is scripted per run so tests can drive success, failure, approvals,
// crashes and reconnects deterministically. Mirrors the endpoints documented at hermes-agent.nousresearch.com.
import http from 'node:http';

export async function startFakeHermes({ apiKey = 'test-key', port = 0, model = 'ok', toolsets, script } = {}) {
  const state = { runs: new Map(), idem: new Map(), requests: [], approvals: [], apiKey, model, toolsets, script, stopped: [], sockets: new Set() };
  const defaultToolsets = [
    { name: 'terminal', enabled: true, configured: true, tools: [{ name: 'terminal' }] },
    { name: 'file', enabled: true, configured: true, tools: [{ name: 'read_file' }, { name: 'write_file' }, { name: 'patch' }] },
    { name: 'web', enabled: true, configured: true, tools: [{ name: 'web_search' }] },
  ];
  const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const authed = (req) => req.headers.authorization === `Bearer ${state.apiKey}`;
  const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } }); });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    state.requests.push({ method: req.method, path: url.pathname, headers: req.headers });
    if (url.pathname === '/health') return json(res, 200, { status: 'ok', platform: 'hermes-agent' });
    if (!authed(req)) return json(res, 401, { error: { message: 'invalid api key' } });
    if (url.pathname === '/health/detailed') return json(res, 200, { status: 'ok', readiness: { checks: { config: 'ok', model: state.model, disk: 'ok' } } });
    if (url.pathname === '/v1/capabilities') return json(res, 200, { features: { run_submission: true, run_events_sse: true, run_stop: true, run_approval: true } });
    if (url.pathname === '/v1/toolsets') return json(res, 200, { toolsets: state.toolsets ?? defaultToolsets });
    if (url.pathname === '/v1/runs' && req.method === 'POST') {
      const body = await readBody(req);
      const key = req.headers['idempotency-key'];
      if (key && state.idem.has(key)) return json(res, 202, { run_id: state.idem.get(key), status: 'started' }, { 'Idempotency-Replayed': 'true' });
      const id = `run_${state.runs.size + 1}`;
      const run = { id, body, status: 'running', events: [], listeners: new Set(), output: null, error: null, approvalWaiters: new Map(), stopped: false };
      state.runs.set(id, run);
      if (key) state.idem.set(key, id);
      queueMicrotask(() => drive(run));
      return json(res, 202, { run_id: id, status: 'started' });
    }
    const m = url.pathname.match(/^\/v1\/runs\/([^/]+)(?:\/(events|stop|approval))?$/);
    if (m) {
      const run = state.runs.get(m[1]);
      if (!run) return json(res, 404, { error: { message: 'run not found' } });
      if (!m[2] && req.method === 'GET') return json(res, 200, { run_id: run.id, status: run.status, output: run.output, error: run.error });
      if (m[2] === 'stop') { state.stopped.push(run.id); run.stopped = true; finish(run, 'cancelled', { }); return json(res, 200, { status: 'stopping' }); }
      if (m[2] === 'approval') {
        const body = await readBody(req); state.approvals.push({ runId: run.id, body });
        const w = [...run.approvalWaiters.values()][0]; if (w) w(body.decision);
        return json(res, 200, { status: 'resolved' });
      }
      if (m[2] === 'events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(': keepalive\n\n');
        const send = (e) => { res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`); };
        for (const e of run.events) send(e);
        if (run.status !== 'running') return res.end();
        const l = { send, end: () => res.end() };
        run.listeners.add(l);
        req.on('close', () => run.listeners.delete(l));
        return undefined;
      }
    }
    return json(res, 404, { error: 'not found' });
  });
  server.on('connection', (s) => { state.sockets.add(s); s.on('close', () => state.sockets.delete(s)); });

  const emit = (run, event, data) => { const e = { event, data }; run.events.push(e); for (const l of run.listeners) l.send(e); };
  const finish = (run, status, data) => {
    if (run.status !== 'running') return;
    run.status = status; run.output = data.output ?? null; run.error = data.error ?? null;
    emit(run, `run.${status}`, data);
    for (const l of run.listeners) l.end();
    run.listeners.clear();
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function drive(run) {
    const steps = (state.script ?? (() => [{ event: 'run.completed', data: { output: 'done' } }]))(run, state);
    for (const step of steps) {
      if (run.status !== 'running') return;
      if (step.delay) await sleep(step.delay);
      if (run.status !== 'running') return;
      if (step.waitApproval) {
        emit(run, 'approval.request', step.data);
        const decision = await new Promise((resolve) => { run.approvalWaiters.set('a', resolve); });
        run.approvalWaiters.clear();
        if (decision === 'deny') { emit(run, 'tool.completed', { tool: step.data.tool, error: 'denied by user' }); continue; }
        continue;
      }
      if (step.hang) { await new Promise(() => {}); }
      if (step.crash) { for (const s of state.sockets) s.destroy(); server.close(); return; }
      if (step.event.startsWith('run.')) finish(run, step.event.slice(4), step.data ?? {}); else emit(run, step.event, step.data ?? {});
    }
  }

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;
  return {
    state, port: actualPort, url: `http://127.0.0.1:${actualPort}`,
    close: () => new Promise((resolve) => { for (const s of state.sockets) s.destroy(); server.close(() => resolve()); }),
    /** Restart on the same port (simulates the Hermes gateway coming back after a crash). Run state is lost, like a real restart without persistence. */
    async restart() {
      await new Promise((r) => { for (const s of state.sockets) s.destroy(); server.close(() => r()); });
      // A real gateway restart leaves in-flight runs as `interrupted` (their events are replayable).
      for (const run of state.runs.values()) if (run.status === 'running') { run.status = 'interrupted'; emit(run, 'run.interrupted', {}); run.listeners.clear(); }
      await new Promise((r) => server.listen(actualPort, '127.0.0.1', r));
    },
    /** Simulates a crash that the server never comes back from until restart() is called. */
    async crashNow() { for (const s of state.sockets) s.destroy(); await new Promise((r) => server.close(() => r())); },
  };
}
