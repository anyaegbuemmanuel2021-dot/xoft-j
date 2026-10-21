import { WebSocketServer } from 'ws';
import { EventType } from '../events/EventBus.js';

// Device credentials are not dashboard credentials. A device socket may
// receive only events explicitly classified as device-scoped, and only when
// the payload names that same authenticated device.
const DEVICE_EVENT_TYPES = new Set([
  EventType.DEVICE_CONNECTED,
  EventType.DEVICE_REVOKED,
  EventType.DEVICE_TRUSTED,
  EventType.DEVICE_ONLINE,
  EventType.DEVICE_OFFLINE,
  EventType.DEVICE_STATE_UPDATED,
  EventType.DEVICE_BATTERY_LOW,
  EventType.DEVICE_CAPABILITIES_UPDATED,
  EventType.DEVICE_COMMAND_QUEUED,
  EventType.DEVICE_COMMAND_STARTED,
  EventType.DEVICE_COMMAND_COMPLETED,
  EventType.DEVICE_COMMAND_FAILED,
  EventType.DEVICE_SECURITY_ALERT,
]);

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
      const auth = this._authenticate(req);
      if (!auth) {
        // 4401 (a private-use close code) distinguishes invalid credentials
        // from a network interruption.
        ws.close(4401, 'unauthorized');
        return;
      }
      ws.xoftAuth = auth;
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
   * Authenticated identity is kept on the connection for authorization on
   * every broadcast. This is important because a device token is scoped to
   * one device and can be revoked while its WebSocket is already open.
   *
   * Query-string credentials remain accepted for backwards compatibility
   * with browser clients; clients should prefer first-party secure session
   * auth or headers wherever the platform permits because URLs can be logged.
   */
  _authenticate(req) {
    let key = null;
    try {
      key = new URL(req.url, 'http://localhost').searchParams.get('key');
    } catch { /* fall through to header */ }
    key = key ?? req.headers['x-api-key'] ?? null;

    if (key && this.apiKeys.includes(key)) return { kind: 'admin' };

    const deviceId = key && this.deviceTokenService ? this.deviceTokenService.verify(key) : null;
    if (deviceId) return { kind: 'device', deviceId, token: key };

    // Preserve the existing open-local-development mode only when no shared
    // API keys are configured. A valid device token above is still identified
    // and scoped even in this mode.
    if (!this.apiKeys.length) return { kind: 'open' };
    return null;
  }

  _closeRevokedDeviceSocket(ws, code = 4401, reason = 'unauthorized') {
    this.clients.delete(ws);
    try {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close(code, reason);
      }
    } catch {
      ws.terminate();
    }
  }

  _mayReceiveEvent(ws, event) {
    const auth = ws.xoftAuth;
    if (!auth || auth.kind !== 'device') return true;

    // Device revocation is emitted before its stored tokens are invalidated.
    // Close that device's stream synchronously on this event so there is no
    // race window in which it can keep receiving privileged/global events.
    if (event?.type === EventType.DEVICE_REVOKED && event.payload?.deviceId === auth.deviceId) {
      this._closeRevokedDeviceSocket(ws, 4403, 'device revoked');
      return false;
    }

    // Re-check stored credentials as defense in depth for any token revocation
    // path that did not emit a device_revoked event through this EventBus.
    const liveDeviceId = this.deviceTokenService?.verify(auth.token);
    if (liveDeviceId !== auth.deviceId) {
      this._closeRevokedDeviceSocket(ws, 4401, 'device token revoked');
      return false;
    }

    // Deny by default: engine status, chat, approvals, task state, memory and
    // all other global/server events are dashboard-only. Device clients may
    // see only explicitly allowlisted device events for their own identity.
    return DEVICE_EVENT_TYPES.has(event?.type)
      && event?.payload?.deviceId === auth.deviceId;
  }

  broadcast(event) {
    if (!this.wss || this.clients.size === 0) return;
    let payload;
    try {
      payload = JSON.stringify(event);
    } catch (err) {
      this.activityLog?.log({ type: 'realtime_serialize_failed', detail: { error: err?.message ?? String(err) } });
      return;
    }

    for (const ws of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (!this._mayReceiveEvent(ws, event)) continue;
      try {
        ws.send(payload);
      } catch {
        this.clients.delete(ws);
        try { ws.terminate(); } catch { /* already closed */ }
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
