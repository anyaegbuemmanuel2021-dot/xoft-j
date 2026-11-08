import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Spawns the real src/index.js as a child process on a scratch data dir/port, waits until it answers, and returns a cleanup fn. Mirrors test/apiAuth.test.js's harness. */
async function bootServer(env, port) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-ws-test-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), MEMORY_DATA_DIR: dataDir, STORAGE_MODE: 'sqlite', SQLITE_PATH: path.join(dataDir, 'test.sqlite'), ...env },
    stdio: 'pipe',
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const deadline = Date.now() + 8000;
  const probeKey = (env.AUTH_API_KEYS ?? '').split(',')[0]?.trim();
  const headers = probeKey ? { Authorization: `Bearer ${probeKey}` } : {};
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, { headers });
      if (res.ok) return { child, base: `http://127.0.0.1:${port}`, dataDir, stop: () => child.kill('SIGKILL') };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`Server on port ${port} never became ready. stderr:\n${stderr}`);
}

function waitForMessageMatching(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for matching WebSocket message after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.on('message', onMessage);
  });
}


function waitFor(ws, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for '${event}'`)), timeoutMs);
    ws.once(event, (...args) => { clearTimeout(t); resolve(args[0]); });
  });
}

describe('RealtimeServer (WebSocket bridge)', () => {
  test('with no AUTH_API_KEYS set, WebSocket connections are accepted (matches REST\'s own open-on-localhost default)', async () => {
    const port = 34801;
    const { stop } = await bootServer({ AUTH_API_KEYS: '' }, port);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const msg = await waitFor(ws, 'message');
      const parsed = JSON.parse(msg.toString());
      assert.equal(parsed.type, 'connected');
      ws.close();
    } finally {
      stop();
    }
  });

  test('with AUTH_API_KEYS set, a connection with no key is rejected', async () => {
    const port = 34802;
    const { stop } = await bootServer({ AUTH_API_KEYS: 'secret-key-123' }, port);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const closeEvent = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out waiting for close')), 5000);
        ws.on('close', (code) => { clearTimeout(t); resolve(code); });
        ws.on('open', () => {}); // ignore — we only care about the close
      });
      assert.equal(closeEvent, 4401);
    } finally {
      stop();
    }
  });

  test('a correct first-frame token authenticates without placing secrets in the WebSocket URL', async () => {
    const port = 34803;
    const { stop } = await bootServer({ AUTH_API_KEYS: 'secret-key-456' }, port);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await waitFor(ws, 'open');
      const connected = waitFor(ws, 'message');
      ws.send(JSON.stringify({ type: 'authenticate', token: 'secret-key-456' }));
      const msg = await connected;
      assert.equal(JSON.parse(msg.toString()).type, 'connected');
      ws.close();
    } finally {
      stop();
    }
  });

  test('a correct-looking bearer token in the URL is ignored and the unauthenticated socket is closed', async () => {
    const port = 34810;
    const { stop } = await bootServer({ AUTH_API_KEYS: 'secret-key-url-test' }, port);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?key=secret-key-url-test`);
      const closeEvent = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out waiting for close')), 5000);
        ws.on('close', (code) => { clearTimeout(t); resolve(code); });
      });
      assert.equal(closeEvent, 4401);
    } finally {
      stop();
    }
  });

  test('a wrong first-frame token is rejected immediately', async () => {
    const port = 34804;
    const { stop } = await bootServer({ AUTH_API_KEYS: 'secret-key-789' }, port);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await waitFor(ws, 'open');
      const closePromise = waitFor(ws, 'close');
      ws.send(JSON.stringify({ type: 'authenticate', token: 'wrong-key' }));
      const code = await closePromise;
      assert.equal(code, 4401);
    } finally {
      stop();
    }
  });

  test('a real event (emergency_stop_activated) is actually pushed to a connected client, not just theoretically wired', async () => {
    const port = 34805;
    const { stop } = await bootServer({ AUTH_API_KEYS: '' }, port);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await waitFor(ws, 'message'); // the initial "connected" message

      const nextMessage = waitFor(ws, 'message', 5000);
      const activateRes = await fetch(`http://127.0.0.1:${port}/api/emergency-stop/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'ws broadcast test' }),
      });
      assert.equal(activateRes.status, 200);

      const raw = await nextMessage;
      const event = JSON.parse(raw.toString());
      assert.equal(event.type, 'emergency_stop_activated');
      assert.equal(event.payload.reason, 'ws broadcast test');
      ws.close();
    } finally {
      stop();
    }
  });

  test('GET /api/realtime/status reports connected clients accurately', async () => {
    const port = 34807;
    const { stop } = await bootServer({ AUTH_API_KEYS: '' }, port);
    try {
      const before = await (await fetch(`http://127.0.0.1:${port}/api/realtime/status`)).json();
      assert.equal(before.clients, 0);

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await waitFor(ws, 'message');
      const during = await (await fetch(`http://127.0.0.1:${port}/api/realtime/status`)).json();
      assert.equal(during.clients, 1);
      ws.close();
    } finally {
      stop();
    }
  });

  test('GET /api/realtime/status reports 0 clients when none are connected', async () => {
    const port = 34806;
    const { stop } = await bootServer({ AUTH_API_KEYS: '' }, port);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/realtime/status`);
      const body = await res.json();
      assert.equal(body.available, true);
      assert.equal(body.clients, 0);
    } finally {
      stop();
    }
  });

  test('device WebSockets receive only their own device events, never global or another device events', async () => {
    const port = 34808;
    const ADMIN = 'realtime-device-admin-key';
    const { base, stop } = await bootServer({ AUTH_API_KEYS: ADMIN }, port);
    const call = async (method, urlPath, { key = ADMIN, body } = {}) => {
      const headers = { 'X-API-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) };
      const response = await fetch(`${base}${urlPath}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() };
    };
    try {
      const regA = await call('POST', '/api/devices', { body: { name: 'ws-device-a', platform: 'desktop' } });
      const trustA = await call('POST', `/api/devices/${regA.body.id}/trust`);
      const regB = await call('POST', '/api/devices', { body: { name: 'ws-device-b', platform: 'desktop' } });
      assert.equal(regA.status, 200);
      assert.equal(trustA.status, 200);
      assert.equal(regB.status, 200);

      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await waitFor(socket, 'open');
      const connected = waitFor(socket, 'message');
      socket.send(JSON.stringify({ type: 'authenticate', token: trustA.body.deviceToken }));
      await connected;
      try {
        // A device must not learn about another device's state.
        const otherStateEvent = waitForMessageMatching(socket, (m) => m.type === 'device.state.updated' && m.payload?.deviceId === regB.body.id, 500);
        await call('POST', `/api/devices/${regB.body.id}/state`, { body: { state: { battery: 12 } } });
        await assert.rejects(otherStateEvent, /timed out waiting for matching/);

        // It may receive its own device-scoped event.
        const ownStateEvent = waitForMessageMatching(socket, (m) => m.type === 'device.state.updated' && m.payload?.deviceId === regA.body.id);
        const ownUpdate = await call('POST', `/api/devices/${regA.body.id}/state`, { key: trustA.body.deviceToken, body: { state: { battery: 80 } } });
        assert.equal(ownUpdate.status, 200);
        const ownEvent = await ownStateEvent;
        assert.equal(ownEvent.payload.deviceId, regA.body.id);

        // Global operational state must not be broadcast to a device credential.
        const globalStopEvent = waitForMessageMatching(socket, (m) => m.type === 'emergency_stop_activated', 500);
        await call('POST', '/api/emergency-stop/activate', { body: { reason: 'device stream isolation test' } });
        await assert.rejects(globalStopEvent, /timed out waiting for matching/);
        await call('POST', '/api/emergency-stop/deactivate');
      } finally {
        socket.close();
      }
    } finally {
      stop();
    }
  });

  test('revoking a device immediately closes its existing WebSocket and invalidates its token', async () => {
    const port = 34809;
    const ADMIN = 'realtime-device-revoke-admin-key';
    const { base, stop } = await bootServer({ AUTH_API_KEYS: ADMIN, STORAGE_MODE: 'sqlite', SQLITE_PATH: path.join(os.tmpdir(), `xoft-ws-${port}.sqlite`) }, port);
    const call = async (method, urlPath, { key = ADMIN, body } = {}) => {
      const headers = { 'X-API-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) };
      const response = await fetch(`${base}${urlPath}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() };
    };
    let socket;
    try {
      const reg = await call('POST', '/api/devices', { body: { name: 'ws-device-revoked', platform: 'desktop' } });
      const trust = await call('POST', `/api/devices/${reg.body.id}/trust`);
      assert.equal(trust.status, 200);
      socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await waitFor(socket, 'open');
      const connected = waitFor(socket, 'message');
      socket.send(JSON.stringify({ type: 'authenticate', token: trust.body.deviceToken }));
      await connected;

      const closed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('device socket remained connected after token revocation')), 3000);
        socket.once('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      const revoke = await call('POST', `/api/devices/${reg.body.id}/revoke`);
      assert.equal(revoke.status, 200);
      assert.equal(await closed, 4403);

      const heartbeat = await call('POST', `/api/devices/${reg.body.id}/heartbeat`, { key: trust.body.deviceToken });
      assert.equal(heartbeat.status, 401);
    } finally {
      socket?.close();
      stop();
    }
  });

});
