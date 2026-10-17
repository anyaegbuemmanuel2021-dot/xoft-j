import { WebSocketServer } from 'ws';

/**
 * RealtimeServer — bridges the existing in-process EventBus to WebSocket
 * clients (Phase 3E: "event bus + WebSocket"). It does not replace REST or
 * the event bus; it's a thin broadcast layer on top of both.
 *
 * Deliberately minimal for the target hardware (single low-end machine,
 * single-user assistant): no per-client topic subscriptions, no message
 * queue infrastructure, no reconnection protocol beyond what `ws` gives for
 * free — every event goes to every connected client, and a client that
 * misses one because it was briefly disconnected is expected to re-sync via
 * the existing REST GET endpoints (`/api/tasks`, `/api/events`, etc.) on
 * reconnect, the same "REST remains the source of truth, WebSocket is a
 * push convenience" split the spec asks for.
 *
 * If `ws` fails to bind for any reason, the whole thing degrades to a no-op
 * (`this.wss` stays null) rather than crashing the process — REST keeps
 * working exactly as before, per "do not break operation because WebSocket
 * failed."
 */
export class RealtimeServer {
  constructor({ server, eventBus, activityLog, apiKeys = [], deviceTokenService = null, path = '/ws', heartbeatMs = 30000 }) {
    this.eventBus = eventBus;
    this.activityLog = activityLog;
    this.apiKeys = apiKeys;
    this.deviceTokenService = deviceTokenService;
    this.clients = new Set();
    this.wss = null;
    this._heartbeat = null;
    this._unlistenEventBus = null;

    try {
      this.wss = new WebSocketServer({ server, path });
    } catch (err) {
      this.activityLog?.log({ type: 'realtime_init_failed', detail: { error: err.message } });
      return;
    }

    this.wss.on('connection', (ws, req) => {
      if (!this._authenticate(req)) {
        // 4401 (a private-use close code) rather than just severing the
        // socket, so a well-behaved client can distinguish "rejected" from
        // "network blip" and knows retrying with the same credentials is pointless.
        ws.close(4401, 'unauthorized');
        return;
      }
      this.clients.add(ws);
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
      ws.send(JSON.stringify({ type: 'connected', ts: new Date().toISOString() }));
    });

    this.wss.on('error', (err) => {
      this.activityLog?.log({ type: 'realtime_server_error', detail: { error: err.message } });
    });

    // Heartbeat: prune dead sockets instead of letting them accumulate.
    // 30s default is deliberately relaxed — a handful of clients (one
    // browser tab, maybe one PC agent), not a reason to wake the CPU often.
    this._heartbeat = setInterval(() => {
      for (const ws of this.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          this.clients.delete(ws);
          continue;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch { this.clients.delete(ws); }
      }
    }, heartbeatMs);
    this._heartbeat.unref?.();

    // Bridge: every EventBus event goes out to every connected client.
    if (this.eventBus) {
      const forward = (event) => this.broadcast(event);
      this.eventBus.on('*', forward);
      this._unlistenEventBus = () => this.eventBus.off('*', forward);
    }
  }

  /**
   * Browsers can't set custom headers on a WebSocket handshake, so the same
   * shared API key / device token accepted via header on REST is also
   * accepted as a `?key=` query param here — same credential, same
   * `config.auth.apiKeys` / DeviceTokenService check as `/api/*`, not a
   * separate weaker auth path.
   */
  _authenticate(req) {
    if (!this.apiKeys.length) return true; // matches REST's own "open on localhost by default" behavior
    let key = null;
    try {
      key = new URL(req.url, 'http://localhost').searchParams.get('key');
    } catch { /* fall through to header */ }
    key = key ?? req.headers['x-api-key'] ?? null;
    if (key && this.apiKeys.includes(key)) return true;
    const deviceId = key && this.deviceTokenService ? this.deviceTokenService.verify(key) : null;
    return Boolean(deviceId);
  }

  broadcast(event) {
    if (!this.wss || this.clients.size === 0) return;
    const payload = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(payload); } catch { this.clients.delete(ws); }
      }
    }
  }

  clientCount() {
    return this.clients.size;
  }

  stop() {
    if (this._heartbeat) clearInterval(this._heartbeat);
    this._unlistenEventBus?.();
    for (const ws of this.clients) ws.terminate();
    this.wss?.close();
  }
}
