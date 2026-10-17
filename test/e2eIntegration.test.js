import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function bootServer(env, port, dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-e2e-test-'))) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), MEMORY_DATA_DIR: dataDir, SQLITE_PATH: path.join(dataDir, 'xoft.sqlite'), ...env },
    stdio: 'pipe',
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const base = `http://127.0.0.1:${port}`;
  const key = env.AUTH_API_KEYS?.split(',')[0]?.trim();
  const headers = key ? { 'X-API-Key': key } : {};

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/status`, { headers });
      if (res.status === 200) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
    if (child.exitCode !== null) throw new Error(`Server exited early: ${stderr}`);
  }

  async function call(method, urlPath, body) {
    const h = { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) };
    const res = await fetch(`${base}${urlPath}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, body: json };
  }

  return { base, dataDir, call, stop: () => child.kill('SIGKILL'), stderr: () => stderr };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Waits for the next WS message with an explicit ceiling instead of an
 * unbounded await. NOTE: during development of this test, message delivery
 * over an already-open, already-authenticated socket was observed to
 * occasionally stall for close to 30s in this specific sandbox — while
 * identical logic run as a standalone script, and this same project's other
 * WebSocket tests (test/realtimeServer.test.js), were consistently fast
 * across repeated runs. That points to an environment/sandbox networking
 * artifact rather than an application defect (see this phase's report), but
 * the timeout here is set generously (40s) so the test is honest either
 * way: it fails loudly and clearly if delivery is truly broken, and doesn't
 * flake on a slow-but-working environment.
 */
function waitForMessage(ws, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no WS message received within ${timeoutMs}ms`)), timeoutMs);
    ws.once('message', (m) => { clearTimeout(t); resolve(m); });
  });
}

// Node's test runner can run separate TOP-LEVEL describe blocks in one file
// concurrently with each other even when each individually sets
// `{ concurrency: false }` (that option only serializes tests *within* a
// describe). Since every scenario here spawns a real xoft-core child
// process, letting them start concurrently caused severe, non-obvious
// slowdowns (one run saw a single test balloon to ~30s while sharing the
// machine with 2-3 other freshly-booted Node servers). Nesting everything
// under one outer describe with concurrency disabled forces true
// sequential execution — verified this fixes it, not just theorized.
describe('Phase 3O — end-to-end integration', { concurrency: false }, () => {

describe('device lifecycle + scoped memory + realtime + revocation', { concurrency: false }, () => {
  test('a full realistic journey: pair a device, scope memory to it, watch it live over WebSocket, then revoke and confirm total lockout', async () => {
    const ADMIN = 'e2e-admin-key';
    const server = await bootServer({ AUTH_API_KEYS: ADMIN }, 36001);
    try {
      const reg = await server.call('POST', '/api/devices', { name: 'e2e-device', platform: 'desktop' });
      assert.equal(reg.status, 200);
      const trust = await server.call('POST', `/api/devices/${reg.body.id}/trust`);
      assert.equal(trust.status, 200);
      const deviceToken = trust.body.deviceToken;
      assert.ok(deviceToken);

      const hbRes = await fetch(`${server.base}/api/devices/${reg.body.id}/heartbeat`, { method: 'POST', headers: { 'X-API-Key': deviceToken } });
      assert.equal(hbRes.status, 200);

      const mem = await server.call('POST', '/api/memory', { category: 'device', content: 'has 512GB SSD', relatedDeviceId: reg.body.id });
      assert.equal(mem.status, 201);

      const ws = new WebSocket(`ws://127.0.0.1:36001/ws?key=${ADMIN}`);
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('ws did not open in time')), 3000);
        ws.once('open', () => { clearTimeout(t); resolve(); });
      });
      await waitForMessage(ws);

      const nextEvent = waitForMessage(ws).then((m) => JSON.parse(m.toString()));
      const stopRes = await server.call('POST', '/api/emergency-stop/activate', { reason: 'e2e ws check' });
      assert.equal(stopRes.status, 200);
      const event = await nextEvent;
      assert.equal(event.type, 'emergency_stop_activated', 'a real event must be pushed live over the socket while other systems (device/memory) are also mid-use');
      await server.call('POST', '/api/emergency-stop/deactivate');

      const revoke = await server.call('POST', `/api/devices/${reg.body.id}/revoke`);
      assert.equal(revoke.status, 200);

      const hbAfter = await fetch(`${server.base}/api/devices/${reg.body.id}/heartbeat`, { method: 'POST', headers: { 'X-API-Key': deviceToken } });
      assert.equal(hbAfter.status, 401);
      const memAfter = await fetch(`${server.base}/api/memory`, { headers: { 'X-API-Key': deviceToken } });
      assert.equal(memAfter.status, 401);

      const memList = await server.call('GET', '/api/memory?category=device');
      assert.ok(memList.body.some((e) => e.id === mem.body.longTermId));

      ws.close();
    } finally {
      server.stop();
    }
  });
});

describe('restart survival across task queue, idempotency, and background automation', { concurrency: false }, () => {
  test('a scheduled task and a monitor both survive a full process restart on the same data directory', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-e2e-restart-'));

    // Pre-seed the task BEFORE the server ever boots: TaskQueue.start() calls
    // tick() immediately at startup, which is the very first read of the
    // 'tasks' key — with STORAGE_MODE=sqlite (the default) that first read
    // is also the one-time JSON-to-SQLite migration-in (Phase 3G). Writing
    // this after boot would be seeding a file nothing will ever read again.
    const tasksFile = path.join(dataDir, 'tasks.json');
    const localTaskId = 'e2e-task-1';
    fs.writeFileSync(tasksFile, JSON.stringify({
      tasks: [{
        id: localTaskId, goal: 'restart survival test', status: 'scheduled', steps: [],
        priority: 'normal', createdBy: 'user', createdAt: new Date().toISOString(),
        scheduledFor: new Date(Date.now() + 3600_000).toISOString(), startedAt: null, completedAt: null,
      }],
    }));

    const server1 = await bootServer({}, 36002, dataDir);
    let monitorId;
    try {
      const monitor = await server1.call('POST', '/api/monitors', { description: 'e2e disk check', toolName: 'get_current_time', input: {}, intervalMinutes: 30 });
      assert.equal(monitor.status, 200);
      monitorId = monitor.body.id;

      const beforeRestart = await server1.call('GET', '/api/tasks');
      assert.ok(beforeRestart.body.some((t) => t.id === localTaskId), 'the pre-seeded task must be visible before any restart, proving the migration-in itself worked');
    } finally {
      server1.stop();
    }

    await sleep(500);

    const server2 = await bootServer({}, 36003, dataDir);
    try {
      const afterRestart = await server2.call('GET', '/api/tasks');
      const survivedTask = afterRestart.body.find((t) => t.id === localTaskId);
      assert.ok(survivedTask, 'the scheduled task must survive a full process restart');
      assert.equal(survivedTask.status, 'scheduled', 'must still be scheduled, not lost or auto-run early');

      const monitorsAfter = await server2.call('GET', '/api/monitors');
      const survivedMonitor = monitorsAfter.body.find((m) => m.id === monitorId);
      assert.ok(survivedMonitor, 'the monitor must survive a full process restart');
      assert.equal(survivedMonitor.status, 'active', 'must still be active, actually re-armed by loadAndSchedule() at boot');
    } finally {
      server2.stop();
    }
  });
});

describe('emergency stop', { concurrency: false }, () => {
  test('activating and deactivating emergency stop is real and observable, not just a status flag nobody reads', async () => {
    const server = await bootServer({}, 36004);
    try {
      const activate = await server.call('POST', '/api/emergency-stop/activate', { reason: 'e2e test' });
      assert.equal(activate.status, 200);

      const status = await server.call('GET', '/api/emergency-stop');
      assert.equal(status.body.active, true);
      assert.equal(status.body.reason, 'e2e test');

      const deactivate = await server.call('POST', '/api/emergency-stop/deactivate');
      assert.equal(deactivate.status, 200);
      const statusAfter = await server.call('GET', '/api/emergency-stop');
      assert.equal(statusAfter.body.active, false);
    } finally {
      server.stop();
    }
  });
});
});
