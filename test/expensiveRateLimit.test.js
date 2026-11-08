import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function bootServer(port) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-ratelimit-test-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), MEMORY_DATA_DIR: dataDir },
    stdio: 'pipe',
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/status`);
      if (res.status === 200) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
    if (child.exitCode !== null) throw new Error(`Server exited early: ${stderr}`);
  }
  return { base, stop: () => child.kill('SIGKILL') };
}

describe('Expensive-endpoint rate limiting (Phase 3M)', { concurrency: false }, () => {
  test('the 6th call to /api/security/audit within the window is rejected with 429, the general limiter alone would not do this', async () => {
    const { base, stop } = await bootServer(35950);
    try {
      const statuses = [];
      for (let i = 0; i < 6; i++) {
        const res = await fetch(`${base}/api/security/audit`, { method: 'POST' });
        statuses.push(res.status);
      }
      assert.equal(statuses.slice(0, 5).every((s) => s === 200), true, `expected the first 5 calls to succeed, got ${statuses}`);
      assert.equal(statuses[5], 429, `expected the 6th call to be rate-limited, got ${statuses}`);
    } finally {
      stop();
    }
  });

  test('a normal, cheap endpoint is unaffected by the expensive-endpoint limiter after 6 calls', async () => {
    const { base, stop } = await bootServer(35951);
    try {
      for (let i = 0; i < 6; i++) {
        const res = await fetch(`${base}/api/status`);
        assert.equal(res.status, 200, `cheap endpoint call ${i + 1} should not be rate-limited by the expensive-endpoint limiter`);
      }
    } finally {
      stop();
    }
  });
});
