import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/persistence/SqliteStore.js';
import { EngineSecretStore } from '../src/engines/hermes/HermesRuntime.js';

describe('EngineSecretStore SQLite persistence', () => {
  test('persists secrets across store instances and supports rotation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-engine-secrets-'));
    const dbPath = path.join(dir, 'xoft.sqlite');
    let db = new SqliteStore(dbPath);
    const store = new EngineSecretStore({ dataDir: dir, sqliteStore: db });
    try {
      assert.equal(store.ensure('bridge-token', () => 'first-secret'), 'first-secret');
      assert.equal(store.ensure('bridge-token', () => 'unused-secret'), 'first-secret');
      db.close();
      db = new SqliteStore(dbPath);
      const restarted = new EngineSecretStore({ dataDir: dir, sqliteStore: db });
      assert.equal(restarted.get('bridge-token'), 'first-secret');
      assert.equal(restarted.has('bridge-token'), true);
      assert.equal(restarted.rotate('bridge-token', () => 'rotated-secret'), 'rotated-secret');
      assert.equal(restarted.get('bridge-token'), 'rotated-secret');
      assert.equal(restarted.info('bridge-token').exists, true);
      if (process.platform !== 'win32') assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('imports legacy owner-only JSON secrets once and retains the source file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-engine-secrets-legacy-'));
    const engineDir = path.join(dir, 'engines');
    fs.mkdirSync(engineDir, { recursive: true });
    const file = path.join(engineDir, 'engine-secrets.json');
    const legacy = { 'bridge-token': { value: 'legacy-secret', createdAt: '2026-01-01T00:00:00.000Z' } };
    fs.writeFileSync(file, JSON.stringify(legacy), { mode: 0o600 });
    const db = new SqliteStore(path.join(dir, 'xoft.sqlite'));
    try {
      const store = new EngineSecretStore({ dataDir: dir, sqliteStore: db });
      assert.equal(store.get('bridge-token'), 'legacy-secret');
      store.rotate('bridge-token', () => 'new-secret');
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), legacy);
      assert.equal(new EngineSecretStore({ dataDir: dir, sqliteStore: db }).get('bridge-token'), 'new-secret');
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
