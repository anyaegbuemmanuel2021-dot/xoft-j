import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ADMIN_KEY = 'admin-secret-key';

async function bootServer(port) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-device-scope-test-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), MEMORY_DATA_DIR: dataDir, AUTH_API_KEYS: ADMIN_KEY },
    stdio: 'pipe',
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/status`, { headers: { 'X-API-Key': ADMIN_KEY } });
      if (res.status === 200) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
    if (child.exitCode !== null) throw new Error(`Server exited early: ${stderr}`);
  }

  async function call(method, urlPath, { key, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['X-API-Key'] = key;
    const res = await fetch(`${base}${urlPath}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, body: json };
  }

  /** Registers + admin-trusts a device, returns { deviceId, token }. */
  async function registerAndTrust(name) {
    const reg = await call('POST', '/api/devices', { key: ADMIN_KEY, body: { name, platform: 'desktop' } });
    const deviceId = reg.body.id;
    const trust = await call('POST', `/api/devices/${deviceId}/trust`, { key: ADMIN_KEY });
    return { deviceId, token: trust.body.deviceToken };
  }

  return { call, registerAndTrust, stop: () => child.kill('SIGKILL') };
}

describe('Per-device token scoping (Phase 3F)', { concurrency: false }, () => {
  test('a device token authenticates but is rejected by requireAdmin on trust/revoke/permission-grant', async () => {
    const server = await bootServer(35801);
    try {
      const a = await server.registerAndTrust('device-a');
      assert.ok(a.token, 'trust must return a real device token');

      // Device A's own token is valid for SOME routes (proves it's a real credential)...
      const ownState = await server.call('POST', `/api/devices/${a.deviceId}/state`, { key: a.token, body: { state: { cpu: 10 } } });
      assert.equal(ownState.status, 200);

      // ...but admin-only actions must reject it even against its OWN device id.
      const selfTrust = await server.call('POST', `/api/devices/${a.deviceId}/trust`, { key: a.token });
      assert.equal(selfTrust.status, 403);

      const selfRevoke = await server.call('POST', `/api/devices/${a.deviceId}/revoke`, { key: a.token });
      assert.equal(selfRevoke.status, 403);

      const selfGrant = await server.call('POST', `/api/devices/${a.deviceId}/permissions`, { key: a.token, body: { permission: 'files.read' } });
      assert.equal(selfGrant.status, 403);

      const listAll = await server.call('GET', '/api/devices', { key: a.token });
      assert.equal(listAll.status, 403);
    } finally {
      server.stop();
    }
  });

  test("device A's token cannot act on device B's heartbeat, state, commands, or details", async () => {
    const server = await bootServer(35802);
    try {
      const a = await server.registerAndTrust('device-a');
      const b = await server.registerAndTrust('device-b');

      const heartbeatB = await server.call('POST', `/api/devices/${b.deviceId}/heartbeat`, { key: a.token });
      assert.equal(heartbeatB.status, 403);

      const stateB = await server.call('POST', `/api/devices/${b.deviceId}/state`, { key: a.token, body: { state: {} } });
      assert.equal(stateB.status, 403);

      const detailB = await server.call('GET', `/api/devices/${b.deviceId}`, { key: a.token });
      assert.equal(detailB.status, 403);

      const commandsB = await server.call('GET', `/api/devices/${b.deviceId}/commands`, { key: a.token });
      assert.equal(commandsB.status, 403);

      const pendingB = await server.call('GET', `/api/devices/${b.deviceId}/commands/pending`, { key: a.token });
      assert.equal(pendingB.status, 403);

      const permsB = await server.call('GET', `/api/devices/${b.deviceId}/permissions`, { key: a.token });
      assert.equal(permsB.status, 403);

      // But B's own token works fine for its own routes — this isn't a
      // blanket lockout, just cross-device isolation.
      const ownHeartbeat = await server.call('POST', `/api/devices/${b.deviceId}/heartbeat`, { key: b.token });
      assert.equal(ownHeartbeat.status, 200);
    } finally {
      server.stop();
    }
  });

  test('the admin key is unaffected by any of these restrictions', async () => {
    const server = await bootServer(35803);
    try {
      const a = await server.registerAndTrust('device-a');
      const listAll = await server.call('GET', '/api/devices', { key: ADMIN_KEY });
      assert.equal(listAll.status, 200);
      assert.ok(Array.isArray(listAll.body));

      const detail = await server.call('GET', `/api/devices/${a.deviceId}`, { key: ADMIN_KEY });
      assert.equal(detail.status, 200);

      const revoke = await server.call('POST', `/api/devices/${a.deviceId}/revoke`, { key: ADMIN_KEY });
      assert.equal(revoke.status, 200);
    } finally {
      server.stop();
    }
  });

  test("a revoked device's token stops working immediately", async () => {
    const server = await bootServer(35804);
    try {
      const a = await server.registerAndTrust('device-a');
      const before = await server.call('POST', `/api/devices/${a.deviceId}/heartbeat`, { key: a.token });
      assert.equal(before.status, 200);

      await server.call('POST', `/api/devices/${a.deviceId}/revoke`, { key: ADMIN_KEY });

      const after = await server.call('POST', `/api/devices/${a.deviceId}/heartbeat`, { key: a.token });
      assert.equal(after.status, 401, 'a revoked token must no longer authenticate at all');
    } finally {
      server.stop();
    }
  });
});
