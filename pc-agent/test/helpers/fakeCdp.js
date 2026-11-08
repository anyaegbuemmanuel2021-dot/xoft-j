'use strict';
/**
 * Deterministic in-memory stand-in for a Chrome DevTools WebSocket. NOT a browser:
 * it only answers the CDP methods a test scripts. Tests using it prove XOFT's
 * protocol handling and orchestration logic — they do NOT prove behavior against
 * real Chrome (that is listed as REQUIRES LOCAL TESTING).
 */
function makeFakeWebSocket(handler, { openDelayMs = 0 } = {}) {
  const instances = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this._l = { open: [], close: [], message: [], error: [] };
      instances.push(this);
      setTimeout(() => {
        if (handler.refuseConnect) { this._fire('error', { message: 'ECONNREFUSED' }); return; }
        this.readyState = 1;
        this._fire('open', {});
      }, openDelayMs);
    }
    addEventListener(type, fn) { this._l[type].push(fn); }
    _fire(type, ev) { for (const fn of this._l[type]) fn(ev); }
    /** Push a CDP event to the client as the browser would. */
    emit(method, params = {}) { this._fire('message', { data: JSON.stringify({ method, params }) }); }
    send(data) {
      const msg = JSON.parse(data);
      this.sent.push(msg);
      setTimeout(async () => {
        if (this.readyState !== 1) return;
        try {
          if (handler.silent?.has(msg.method)) return; // simulate a hung command
          const result = await handler.respond(msg.method, msg.params ?? {}, this);
          this._fire('message', { data: JSON.stringify({ id: msg.id, result: result ?? {} }) });
        } catch (err) {
          this._fire('message', { data: JSON.stringify({ id: msg.id, error: { code: err.code ?? -32000, message: err.message } }) });
        }
      }, 0);
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; this._fire('close', {}); }
  }
  FakeWebSocket.instances = instances;
  return FakeWebSocket;
}

function makeFakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname + u.search, method: opts.method ?? 'GET' });
    const route = routes[u.pathname];
    if (!route) return { ok: false, status: 404, text: async () => 'not found' };
    const body = typeof route === 'function' ? route(u, opts) : route;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  fn.calls = calls;
  return fn;
}

module.exports = { makeFakeWebSocket, makeFakeFetch };
