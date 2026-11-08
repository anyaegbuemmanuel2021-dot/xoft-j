import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/persistence/SqliteStore.js';
import { EngineTaskStore } from '../src/engines/EngineTaskStore.js';

test('EngineTaskStore keeps its append-only event journal in SQLite and recovers sequence numbers after restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-engine-events-'));
  const dbPath = path.join(dir, 'xoft.sqlite');
  try {
    const sqlite = new SqliteStore(dbPath);
    const tasks = new EngineTaskStore({ dataDir: dir, sqliteStore: sqlite });
    const task = tasks.create({ goal: 'test durable events', state: 'queued' });
    tasks.appendEvent(task.id, { type: 'created', detail: 'first' });
    tasks.appendEvent(task.id, { type: 'progress', detail: 'second' });
    assert.equal(fs.existsSync(path.join(dir, 'engines', 'events')), false, 'SQLite mode must not depend on an ephemeral JSONL sidecar');
    sqlite.close();

    const reopened = new SqliteStore(dbPath);
    const recovered = new EngineTaskStore({ dataDir: dir, sqliteStore: reopened });
    const events = recovered.events(task.id, { limit: 0 });
    assert.deepEqual(events.map((e) => [e.seq, e.type]), [[1, 'created'], [2, 'progress']]);
    assert.equal(recovered.events(task.id, { after: 1, limit: 0 })[0].detail, 'second');

    recovered.appendEvent(task.id, { type: 'completed', detail: 'third' });
    assert.deepEqual(recovered.events(task.id, { limit: 0 }).map((e) => e.seq), [1, 2, 3]);
    reopened.deleteEngineEvents(task.id);
    assert.deepEqual(recovered.events(task.id, { limit: 0 }), []);
    reopened.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('EngineTaskStore migrates existing JSONL event files when an installation switches to SQLite mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-engine-events-migrate-'));
  const eventDir = path.join(dir, 'engines', 'events');
  fs.mkdirSync(eventDir, { recursive: true });
  const legacy = { seq: 7, ts: '2026-11-08T00:00:00.000Z', type: 'legacy', detail: 'preserve me' };
  fs.writeFileSync(path.join(eventDir, 'task-legacy.jsonl'), JSON.stringify(legacy) + '\n');
  const dbPath = path.join(dir, 'xoft.sqlite');
  try {
    const sqlite = new SqliteStore(dbPath);
    const tasks = new EngineTaskStore({ dataDir: dir, sqliteStore: sqlite });
    assert.deepEqual(tasks.events('task-legacy', { limit: 0 }), [legacy]);
    tasks.appendEvent('task-legacy', { type: 'after-migration' });
    assert.deepEqual(tasks.events('task-legacy', { limit: 0 }).map((event) => event.seq), [7, 8]);
    sqlite.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
