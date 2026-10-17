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
    env: { ...process.env, PORT: String(port), MEMORY_DATA_DIR: dataDir, ...env },
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
      if (res.ok) return { child, stop: () => child.kill('SIGKILL') };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`Server on port ${port} never became ready. stderr:\n${stderr}`);
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
        const t = setTimeout(() => reject(new Error('timed out waiting for close')), 3000);
        ws.on('close', (code) => { clearTimeout(t); resolve(code); });
        ws.on('open', () => {}); // ignore — we only care about the close
      });
      assert.equal(closeEvent, 4401);
    } finally {
      stop();
    }
  });

  test('with AUTH_API_KEYS set, a connection with the correct ?key= is accepted', async () => {
    const port = 34803;
    const { stop } = await bootServer({ AUTH_API_KEYS: 'secret-key-456' }, port);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?key=secret-key-456`);
      const msg = await waitFor(ws, 'message');
      assert.equal(JSON.parse(msg.toString()).type, 'connected');
      ws.close();
    } finally {
      stop();
    }
  });

  test('with AUTH_API_KEYS set, a connection with the wrong key is rejected', async () => {
    const port = 34804;
    const { stop } = await bootServer({ AUTH_API_KEYS: 'secret-key-789' }, port);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?key=wrong-key`);
      const closeEvent = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out waiting for close')), 3000);
        ws.on('close', (code) => { clearTimeout(t); resolve(code); });
      });
      assert.equal(closeEvent, 4401);
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
});
