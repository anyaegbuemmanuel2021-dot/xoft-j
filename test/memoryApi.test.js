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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-memory-api-test-'));
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

  async function call(method, urlPath, { key = ADMIN_KEY, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['X-API-Key'] = key;
    const res = await fetch(`${base}${urlPath}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, body: json };
  }

  return { call, stop: () => child.kill('SIGKILL') };
}

describe('Memory API (Phase 3H)', { concurrency: false }, () => {
  test('unauthenticated requests are rejected', async () => {
    const server = await bootServer(35901);
    try {
      const res = await server.call('GET', '/api/memory', { key: null });
      assert.equal(res.status, 401);
    } finally {
      server.stop();
    }
  });

  test('full lifecycle: create, retrieve, update, correct, delete', async () => {
    const server = await bootServer(35902);
    try {
      const created = await server.call('POST', '/api/memory', { body: { category: 'preference', content: 'likes tea' } });
      assert.equal(created.status, 201);
      assert.ok(created.body.longTermId);
      const id = created.body.longTermId;

      const listed = await server.call('GET', `/api/memory?category=preference`);
      assert.equal(listed.status, 200);
      assert.ok(listed.body.some((e) => e.id === id));
      const entry = listed.body.find((e) => e.id === id);
      assert.equal(entry.source, 'USER_STATED', 'direct API creation is a direct statement, not an inference');

      const patched = await server.call('PATCH', `/api/memory/${id}`, { body: { tags: ['drinks'] } });
      assert.equal(patched.status, 200);
      assert.deepEqual(patched.body.tags, ['drinks']);
      assert.equal(patched.body.content, 'likes tea', 'PATCH must not silently change content');

      const corrected = await server.call('POST', `/api/memory/${id}/correct`, { body: { content: 'likes coffee, not tea', reason: 'corrected by user' } });
      assert.equal(corrected.status, 200);
      assert.equal(corrected.body.content, 'likes coffee, not tea');
      assert.equal(corrected.body.source, 'USER_CORRECTED');
      assert.equal(corrected.body.history.length, 1);
      assert.equal(corrected.body.history[0].content, 'likes tea');

      const deleted = await server.call('DELETE', `/api/memory/${id}`);
      assert.equal(deleted.status, 200);
      assert.equal(deleted.body.removed, true);

      const afterDelete = await server.call('GET', `/api/memory?category=preference`);
      assert.equal(afterDelete.body.some((e) => e.id === id), false, 'a deleted entry must not reappear');
    } finally {
      server.stop();
    }
  });

  test('POST /api/memory requires category and content', async () => {
    const server = await bootServer(35903);
    try {
      const res = await server.call('POST', '/api/memory', { body: { category: 'fact' } });
      assert.equal(res.status, 400);
    } finally {
      server.stop();
    }
  });

  test('PATCH/correct on a non-existent id return 404', async () => {
    const server = await bootServer(35904);
    try {
      assert.equal((await server.call('PATCH', '/api/memory/nope', { body: { tags: [] } })).status, 404);
      assert.equal((await server.call('POST', '/api/memory/nope/correct', { body: { content: 'x' } })).status, 404);
    } finally {
      server.stop();
    }
  });

  test("a device token cannot read, edit, correct, or delete another device's scoped memory", async () => {
    const server = await bootServer(35905);
    try {
      const regA = await server.call('POST', '/api/devices', { body: { name: 'device-a', platform: 'desktop' } });
      const trustA = await server.call('POST', `/api/devices/${regA.body.id}/trust`);
      const tokenA = trustA.body.deviceToken;

      const regB = await server.call('POST', '/api/devices', { body: { name: 'device-b', platform: 'desktop' } });
      const trustB = await server.call('POST', `/api/devices/${regB.body.id}/trust`);
      const tokenB = trustB.body.deviceToken;

      const created = await server.call('POST', '/api/memory', { body: { category: 'device', content: 'device B has Firefox', relatedDeviceId: regB.body.id } });
      const id = created.body.longTermId;

      const listAsA = await server.call('GET', '/api/memory', { key: tokenA });
      assert.equal(listAsA.body.some((e) => e.id === id), false);

      assert.equal((await server.call('PATCH', `/api/memory/${id}`, { key: tokenA, body: { tags: ['x'] } })).status, 403);
      assert.equal((await server.call('POST', `/api/memory/${id}/correct`, { key: tokenA, body: { content: 'hacked' } })).status, 403);
      assert.equal((await server.call('DELETE', `/api/memory/${id}`, { key: tokenA })).status, 403);

      const listAsB = await server.call('GET', '/api/memory', { key: tokenB });
      assert.ok(listAsB.body.some((e) => e.id === id));
      assert.equal((await server.call('PATCH', `/api/memory/${id}`, { key: tokenB, body: { tags: ['ok'] } })).status, 200);
    } finally {
      server.stop();
    }
  });

  test('a device token cannot create memory scoped to a different device', async () => {
    const server = await bootServer(35906);
    try {
      const regA = await server.call('POST', '/api/devices', { body: { name: 'device-a', platform: 'desktop' } });
      const trustA = await server.call('POST', `/api/devices/${regA.body.id}/trust`);
      const tokenA = trustA.body.deviceToken;

      const res = await server.call('POST', '/api/memory', { key: tokenA, body: { category: 'device', content: 'x', relatedDeviceId: 'some-other-device' } });
      assert.equal(res.status, 403);

      const ownScoped = await server.call('POST', '/api/memory', { key: tokenA, body: { category: 'device', content: 'x', relatedDeviceId: regA.body.id } });
      assert.equal(ownScoped.status, 201);
    } finally {
      server.stop();
    }
  });

  test('shared memory (no relatedDeviceId) is visible to every device token', async () => {
    const server = await bootServer(35907);
    try {
      const regA = await server.call('POST', '/api/devices', { body: { name: 'device-a', platform: 'desktop' } });
      const trustA = await server.call('POST', `/api/devices/${regA.body.id}/trust`);
      const tokenA = trustA.body.deviceToken;

      const created = await server.call('POST', '/api/memory', { body: { category: 'fact', content: 'shared fact' } });
      const listAsA = await server.call('GET', '/api/memory', { key: tokenA });
      assert.ok(listAsA.body.some((e) => e.id === created.body.longTermId));
    } finally {
      server.stop();
    }
  });
});
