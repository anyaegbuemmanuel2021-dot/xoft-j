'use strict';
const { CdpConnection, CdpError } = require('./cdp-connection');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * CdpClient — target discovery over the browser's HTTP debugging endpoint plus
 * attaching a CdpConnection to one page target. SECURITY: only loopback hosts are
 * accepted; XOFT never opens a CDP session to a remote machine.
 */
class CdpClient {
  constructor({ host = '127.0.0.1', port = 9222, fetchImpl = globalThis.fetch, WebSocketImpl, requestTimeoutMs = 5000 } = {}) {
    if (!LOOPBACK.has(host)) throw new CdpError(`Refusing non-loopback CDP host '${host}'. Remote debugging endpoints are never contacted.`);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CdpError(`Invalid CDP port '${port}'`);
    this.host = host;
    this.port = port;
    this.fetch = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  get baseUrl() { return `http://${this.host.includes(':') ? `[${this.host}]` : this.host}:${this.port}`; }

  async _http(path, { method = 'GET' } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.requestTimeoutMs);
    try {
      const res = await this.fetch(`${this.baseUrl}${path}`, { method, signal: ctl.signal });
      const text = await res.text();
      if (!res.ok) throw new CdpError(`CDP HTTP ${method} ${path} -> ${res.status}`);
      try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
    } catch (err) {
      if (err instanceof CdpError) throw err;
      throw new CdpError(`Cannot reach browser debugging endpoint at ${this.baseUrl}: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  version() { return this._http('/json/version'); }

  /** Page targets only (never service workers, extensions, devtools pages). */
  async listPages() {
    const targets = await this._http('/json/list');
    return (Array.isArray(targets) ? targets : [])
      .filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'))
      .map((t) => ({ id: t.id, title: t.title ?? '', url: t.url ?? '', wsUrl: t.webSocketDebuggerUrl ?? null }));
  }

  /** Opens a new tab. Chrome >= 111 requires PUT for /json/new. */
  async newPage(url = 'about:blank') {
    const t = await this._http(`/json/new?${encodeURI(url)}`, { method: 'PUT' });
    return { id: t.id, title: t.title ?? '', url: t.url ?? '', wsUrl: t.webSocketDebuggerUrl ?? null };
  }

  async activatePage(targetId) {
    await this._http(`/json/activate/${encodeURIComponent(targetId)}`);
  }

  async closePage(targetId) {
    await this._http(`/json/close/${encodeURIComponent(targetId)}`);
  }

  /** Connects a CdpConnection to a page target (by listing, so stale ids fail clearly). */
  async attach(targetId, connOptions = {}) {
    const pages = await this.listPages();
    const page = pages.find((p) => p.id === targetId);
    if (!page) throw new CdpError(`No page target with id '${targetId}' (tab closed or id stale)`);
    if (!page.wsUrl) throw new CdpError(`Target '${targetId}' has no debugger URL — another DevTools client may already be attached`);
    const conn = new CdpConnection({ url: page.wsUrl, WebSocketImpl: this.WebSocketImpl ?? globalThis.WebSocket, ...connOptions });
    await conn.connect();
    return { connection: conn, page };
  }
}

module.exports = { CdpClient };
