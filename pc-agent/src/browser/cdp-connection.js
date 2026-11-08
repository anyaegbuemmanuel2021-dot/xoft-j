'use strict';
const { EventEmitter } = require('node:events');

/**
 * CdpConnection — the ONLY place raw CDP WebSocket protocol lives.
 * Handles: connect/close, monotonically increasing command ids, request→response
 * correlation, per-command timeouts, AbortSignal cancellation, and event fan-out.
 * Everything above this (cdp-page, cdp-dom, BrowserController) speaks methods, not frames.
 *
 * The WebSocket implementation is injectable so this is unit-testable without a
 * browser; the default is Node's built-in global WebSocket (Node >= 22).
 */
class CdpError extends Error {
  constructor(message, { code = null, method = null } = {}) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
    this.method = method;
  }
}

class CdpConnection extends EventEmitter {
  constructor({ url, WebSocketImpl = globalThis.WebSocket, commandTimeoutMs = 15000, connectTimeoutMs = 8000 } = {}) {
    super();
    if (!url) throw new Error('CdpConnection: url is required');
    if (!WebSocketImpl) throw new Error('CdpConnection: no WebSocket implementation available (need Node >= 22 or inject one)');
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.commandTimeoutMs = commandTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this._ws = null;
    this._nextId = 1;
    this._pending = new Map(); // id -> { resolve, reject, timer, method }
    this._closed = false;
  }

  get isOpen() {
    return Boolean(this._ws) && this._ws.readyState === 1 && !this._closed;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new this.WebSocketImpl(this.url);
      this._ws = ws;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* ignore */ }
        reject(new CdpError(`CDP connect timed out after ${this.connectTimeoutMs}ms (${this.url})`));
      }, this.connectTimeoutMs);

      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(this);
      });
      ws.addEventListener('error', (ev) => {
        const msg = ev?.message ?? 'websocket error';
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new CdpError(`CDP connect failed: ${msg}`));
        } else {
          this.emit('transportError', new CdpError(msg));
        }
      });
      ws.addEventListener('close', () => this._onClose());
      ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
    } catch {
      this.emit('protocolError', new CdpError('CDP sent a non-JSON frame'));
      return;
    }
    if (msg.id !== undefined) {
      const p = this._pending.get(msg.id);
      if (!p) return; // late reply for a timed-out/cancelled command
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(msg.error.message ?? 'CDP command failed', { code: msg.error.code, method: p.method }));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      const ev = { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId };
      this.emit('event', ev);
      this.emit(msg.method, ev.params);
    }
  }

  _onClose() {
    if (this._closed) return;
    this._closed = true;
    const err = new CdpError('CDP connection closed');
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(err); }
    this._pending.clear();
    this.emit('close');
  }

  /** Sends one CDP command. Rejects on protocol error, timeout, abort, or closed socket. */
  send(method, params = {}, { timeoutMs = this.commandTimeoutMs, signal } = {}) {
    if (!this.isOpen) return Promise.reject(new CdpError('CDP connection is not open', { method }));
    if (signal?.aborted) return Promise.reject(new CdpError('CDP command aborted', { method }));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new CdpError(`CDP command ${method} timed out after ${timeoutMs}ms`, { method }));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer, method });
      signal?.addEventListener('abort', () => {
        if (!this._pending.has(id)) return;
        this._pending.delete(id);
        clearTimeout(timer);
        reject(new CdpError('CDP command aborted', { method }));
      }, { once: true });
      try {
        this._ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(new CdpError(`CDP send failed: ${err.message}`, { method }));
      }
    });
  }

  /** Resolves with the params of the next `method` event, or rejects on timeout. */
  waitForEvent(method, { timeoutMs = 10000, predicate = () => true, signal } = {}) {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off(method, handler); this.off('close', onClose); };
      const handler = (params) => { if (predicate(params)) { cleanup(); resolve(params); } };
      const onClose = () => { cleanup(); reject(new CdpError(`Connection closed while waiting for ${method}`)); };
      const timer = setTimeout(() => { cleanup(); reject(new CdpError(`Timed out waiting for ${method}`)); }, timeoutMs);
      signal?.addEventListener('abort', () => { cleanup(); reject(new CdpError('aborted')); }, { once: true });
      this.on(method, handler);
      this.on('close', onClose);
    });
  }

  close() {
    if (this._closed) return;
    try { this._ws?.close(); } catch { /* ignore */ }
    this._onClose();
  }
}

module.exports = { CdpConnection, CdpError };
