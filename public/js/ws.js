// ws.js — thin client for the Phase 3E realtime bridge (/ws). Reconnects
// with backoff on its own; consumers just listen on `wsEvents` and don't
// need to know or care whether the socket is currently up. REST (via
// api.js) remains the source of truth — this only pushes "something
// changed, you may want to refresh" faster than polling would.

export const wsEvents = new EventTarget();

let socket = null;
let backoffMs = 1000;
const MAX_BACKOFF_MS = 30000;
let manuallyClosed = false;

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const key = localStorage.getItem('xoft_api_key');
  return `${proto}//${location.host}/ws${key ? '?key=' + encodeURIComponent(key) : ''}`;
}

export function isConnected() {
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

export function connect() {
  manuallyClosed = false;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  try {
    socket = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', () => {
    backoffMs = 1000;
    wsEvents.dispatchEvent(new Event('open'));
  });

  socket.addEventListener('message', (msg) => {
    let event;
    try { event = JSON.parse(msg.data); } catch { return; }
    if (event.type === 'connected') return;
    wsEvents.dispatchEvent(new CustomEvent('event', { detail: event }));
  });

  socket.addEventListener('close', () => {
    wsEvents.dispatchEvent(new Event('close'));
    if (!manuallyClosed) scheduleReconnect();
  });

  socket.addEventListener('error', () => { /* 'close' always follows 'error' on a WebSocket */ });
}

function scheduleReconnect() {
  setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

export function disconnect() {
  manuallyClosed = true;
  socket?.close();
}

/** Subscribe to one or more EventBus type(s); pass '*' for everything. Returns an unsubscribe fn. */
export function onEvent(types, handler) {
  const list = Array.isArray(types) ? types : [types];
  const listener = (e) => {
    if (list.includes('*') || list.includes(e.detail.type)) handler(e.detail);
  };
  wsEvents.addEventListener('event', listener);
  return () => wsEvents.removeEventListener('event', listener);
}
