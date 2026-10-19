import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function boot(port, dataDir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      HOST: '127.0.0.1',
      AUTH_API_KEYS: 'chat-history-test-key',
      REQUIRE_AUTH_IN_PRODUCTION: 'false',
      STORAGE_MODE: 'sqlite',
      SQLITE_PATH: path.join(dataDir, 'chat-history.sqlite'),
      MEMORY_DATA_DIR: dataDir,
    },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { 'X-API-Key': 'chat-history-test-key' },
      });
      if (res.status === 200) return () => child.kill();
    } catch { /* server is starting */ }
    if (child.exitCode !== null) throw new Error(`XOFT test server exited with ${child.exitCode}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  child.kill();
  throw new Error('XOFT test server did not start in time');
}

test('durable chat API saves messages and lists a reopenable recent session', async () => {
  const port = 3198;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-chat-history-'));
  const stop = await boot(port, dataDir);
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-API-Key': 'chat-history-test-key',
  };
  try {
    const messages = [
      { role: 'user', content: 'Remember this test conversation', at: '2026-10-19T10:00:00.000Z' },
      { role: 'assistant', content: 'Saved for this test.', at: '2026-10-19T10:00:01.000Z' },
    ];
    const put = await fetch(`${base}/api/chats/test-session`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ messages }),
    });
    assert.equal(put.status, 200);
    const putBody = await put.json();
    assert.equal(putBody.ok, true);
    assert.equal(putBody.durable, true);
    assert.equal(putBody.count, 2);

    const get = await fetch(`${base}/api/chats/test-session`, { headers });
    assert.equal(get.status, 200);
    const saved = await get.json();
    assert.equal(saved.messages.length, 2);
    assert.equal(saved.messages[1].content, 'Saved for this test.');

    const recent = await fetch(`${base}/api/chats`, { headers });
    assert.equal(recent.status, 200);
    const index = await recent.json();
    assert.equal(index.sessions[0].sessionId, 'test-session');
    assert.equal(index.sessions[0].title, 'Remember this test conversation');
  } finally {
    stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
