import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Spawns the real src/index.js as a child process on a scratch data dir/port, waits until it answers, and returns a cleanup fn. */
async function bootServer(env, port) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-auth-test-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), MEMORY_DATA_DIR: dataDir, ...env },
    stdio: 'pipe',
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/api/status`, { headers: env.AUTH_API_KEYS ? { 'X-API-Key': env.AUTH_API_KEYS.split(',')[0] } : {} });
      if (res.status === 200 || res.status === 401) break; // either means the server is actually up
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode !== null) throw new Error(`Server exited early (code ${child.exitCode}): ${stderr}`);
  }

  return {
    stop: () => child.kill(),
  };
}

describe('API authentication (real server, integration)', { concurrency: false }, () => {
  test('with no AUTH_API_KEYS set, the API stays open (backward compatible)', async () => {
    const server = await bootServer({}, 3101);
    try {
      const res = await fetch('http://localhost:3101/api/status');
      assert.equal(res.status, 200);
    } finally {
      server.stop();
    }
  });

  test('with AUTH_API_KEYS set, requests without a key are rejected', async () => {
    const server = await bootServer({ AUTH_API_KEYS: 'secretA,secretB' }, 3102);
    try {
      const res = await fetch('http://localhost:3102/api/status');
      assert.equal(res.status, 401);
    } finally {
      server.stop();
    }
  });

  test('with AUTH_API_KEYS set, a wrong key is rejected and either configured key is accepted', async () => {
    const server = await bootServer({ AUTH_API_KEYS: 'secretA,secretB' }, 3103);
    try {
      const wrong = await fetch('http://localhost:3103/api/status', { headers: { 'X-API-Key': 'nope' } });
      assert.equal(wrong.status, 401);

      const first = await fetch('http://localhost:3103/api/status', { headers: { 'X-API-Key': 'secretA' } });
      assert.equal(first.status, 200);

      const second = await fetch('http://localhost:3103/api/status', { headers: { Authorization: 'Bearer secretB' } });
      assert.equal(second.status, 200);
    } finally {
      server.stop();
    }
  });

  test('device pairing routes are covered by auth too, not just /api/status', async () => {
    const server = await bootServer({ AUTH_API_KEYS: 'secretA' }, 3104);
    try {
      const res = await fetch('http://localhost:3104/api/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', platform: 'desktop' }) });
      assert.equal(res.status, 401);

      const authed = await fetch('http://localhost:3104/api/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'secretA' },
        body: JSON.stringify({ name: 'x', platform: 'desktop' }),
      });
      assert.equal(authed.status, 200);
    } finally {
      server.stop();
    }
  });
});
