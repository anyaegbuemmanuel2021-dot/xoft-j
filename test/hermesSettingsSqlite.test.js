import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/persistence/SqliteStore.js';
import { HermesSettingsStore } from '../src/engines/hermes/HermesSettingsStore.js';

describe('HermesSettingsStore SQLite persistence', () => {
  test('persists validated settings across restarts and supports reset', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-hermes-settings-'));
    const db = new SqliteStore(path.join(dir, 'xoft.sqlite'));
    try {
      const store = new HermesSettingsStore({ dataDir: dir, sqliteStore: db });
      store.update({ model: 'test-model', maxConcurrentTasks: 4, autoStart: false });
      assert.equal(store.load().model, 'test-model');
      const restarted = new HermesSettingsStore({ dataDir: dir, sqliteStore: db });
      assert.equal(restarted.load().maxConcurrentTasks, 4);
      restarted.reset();
      assert.deepEqual(restarted.load(), {});
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('imports existing JSON settings once and retains the original file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-hermes-legacy-'));
    const settingsDir = path.join(dir, 'engines');
    fs.mkdirSync(settingsDir, { recursive: true });
    const file = path.join(settingsDir, 'hermes-settings.json');
    const legacy = { model: 'legacy-model', maxRetries: 3 };
    fs.writeFileSync(file, JSON.stringify(legacy));
    const db = new SqliteStore(path.join(dir, 'xoft.sqlite'));
    try {
      const store = new HermesSettingsStore({ dataDir: dir, sqliteStore: db });
      assert.deepEqual(store.load(), legacy);
      store.update({ model: 'updated-model' });
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), legacy);
      assert.equal(new HermesSettingsStore({ dataDir: dir, sqliteStore: db }).load().model, 'updated-model');
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
