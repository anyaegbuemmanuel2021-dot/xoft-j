import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/persistence/JsonStore.js';
import { SqliteStore } from '../src/persistence/SqliteStore.js';
import { ExecutionRecordStore } from '../src/planner/ExecutionRecordStore.js';
import { ExperienceStore } from '../src/planner/ExperienceStore.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-jsonstore-test-'));
}

describe('JsonStore', () => {
  test('with no sqliteStore, behaves exactly like the old direct flat-file read/write (default, unchanged path)', () => {
    const dataDir = tmpDir();
    const store = new JsonStore({ dataDir, fileName: 'things.json', defaultValue: { items: [] } });
    assert.deepEqual(store.load(), { items: [] });
    store.save({ items: [1, 2, 3] });
    assert.deepEqual(store.load(), { items: [1, 2, 3] });
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'things.json'), 'utf-8'));
    assert.deepEqual(onDisk, { items: [1, 2, 3] });
  });

  test('with a real SqliteStore, reads and writes actually go through SQLite, not the flat file', () => {
    const dataDir = tmpDir();
    const sqliteStore = new SqliteStore(path.join(dataDir, 'test.sqlite'));
    try {
      const store = new JsonStore({ dataDir, fileName: 'things.json', kvKey: 'things', defaultValue: { items: [] }, sqliteStore });
      assert.deepEqual(store.load(), { items: [] });
      store.save({ items: ['a', 'b'] });

      const store2 = new JsonStore({ dataDir, fileName: 'things.json', kvKey: 'things', defaultValue: { items: [] }, sqliteStore });
      assert.deepEqual(store2.load(), { items: ['a', 'b'] });

      assert.equal(fs.existsSync(path.join(dataDir, 'things.json')), false);
    } finally {
      sqliteStore.close();
    }
  });

  test('switching an existing JSON-mode dataDir to sqliteStore migrates the legacy file in once, losing nothing', () => {
    const dataDir = tmpDir();
    fs.writeFileSync(path.join(dataDir, 'things.json'), JSON.stringify({ items: ['legacy-1', 'legacy-2'] }));

    const sqliteStore = new SqliteStore(path.join(dataDir, 'test.sqlite'));
    try {
      const store = new JsonStore({ dataDir, fileName: 'things.json', kvKey: 'things', defaultValue: { items: [] }, sqliteStore });
      assert.deepEqual(store.load(), { items: ['legacy-1', 'legacy-2'] });

      const store2 = new JsonStore({ dataDir, fileName: 'things.json', kvKey: 'things', defaultValue: { items: [] }, sqliteStore });
      assert.deepEqual(store2.load(), { items: ['legacy-1', 'legacy-2'] });

      const originalStillOnDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'things.json'), 'utf-8'));
      assert.deepEqual(originalStillOnDisk, { items: ['legacy-1', 'legacy-2'] });
    } finally {
      sqliteStore.close();
    }
  });
});

describe('ExecutionRecordStore + ExperienceStore over real SQLite', () => {
  test('ExecutionRecordStore works end-to-end against a real SqliteStore, including cross-instance idempotency lookups', () => {
    const dataDir = tmpDir();
    const sqliteStore = new SqliteStore(path.join(dataDir, 'test.sqlite'));
    try {
      const store1 = new ExecutionRecordStore({ dataDir, sqliteStore });
      const key = ExecutionRecordStore.keyFor('task-1', 'step-1');
      const rec = store1.begin({ taskId: 'task-1', stepId: 'step-1', toolName: 'test.tool', idempotencyKey: key, attemptNumber: 1, input: {} });
      store1.complete(rec.executionId, { status: 'succeeded', result: { ok: true } });

      const store2 = new ExecutionRecordStore({ dataDir, sqliteStore });
      const found = store2.findLatestSucceeded(key);
      assert.ok(found);
      assert.deepEqual(found.result, { ok: true });
    } finally {
      sqliteStore.close();
    }
  });

  test('ExperienceStore works end-to-end against a real SqliteStore', () => {
    const dataDir = tmpDir();
    const sqliteStore = new SqliteStore(path.join(dataDir, 'test.sqlite'));
    try {
      const store1 = new ExperienceStore({ dataDir, sqliteStore });
      store1.record({ toolName: 'test.tool', failureCategory: 'transient', errorMessage: 'x', recoveryStrategy: 'retry_same', recoveryOutcome: 'recovered', inputSignature: 'a,b' });

      const store2 = new ExperienceStore({ dataDir, sqliteStore });
      const conf = store2.confidenceFor({ toolName: 'test.tool', failureCategory: 'transient', recoveryStrategy: 'retry_same' });
      assert.deepEqual(conf, { confidence: 1, sampleSize: 1 });
    } finally {
      sqliteStore.close();
    }
  });
});
