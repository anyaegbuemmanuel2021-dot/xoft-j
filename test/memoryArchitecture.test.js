import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LongTermMemory, MemorySource } from '../src/memory/LongTermMemory.js';
import { MemoryManager } from '../src/memory/MemoryManager.js';
import { SqliteStore } from '../src/persistence/SqliteStore.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-memory-test-'));
}

describe('LongTermMemory — provenance & confidence', () => {
  test('an entry with no source specified is stored as unspecified (null), never defaulted to something reassuring', () => {
    const long = new LongTermMemory({ dataDir: tmpDir() });
    const id = long.remember('fact', 'the sky is blue');
    const entry = long.getById(id);
    assert.equal(entry.source, null);
    assert.equal(entry.confidence, null);
  });

  test('USER_STATED and AI_INFERRED remain distinguishable on the same category', () => {
    const long = new LongTermMemory({ dataDir: tmpDir() });
    const statedId = long.remember('preference', 'I prefer short messages', {}, { source: MemorySource.USER_STATED, confidence: 1 });
    const inferredId = long.remember('preference', 'user probably prefers short emails', {}, { source: MemorySource.AI_INFERRED, confidence: 0.45 });

    const stated = long.getById(statedId);
    const inferred = long.getById(inferredId);
    assert.equal(stated.source, 'USER_STATED');
    assert.equal(stated.confidence, 1);
    assert.equal(inferred.source, 'AI_INFERRED');
    assert.equal(inferred.confidence, 0.45);
  });
});

describe('LongTermMemory — update vs correct', () => {
  test('update() edits fields without touching provenance or history', () => {
    const long = new LongTermMemory({ dataDir: tmpDir() });
    const id = long.remember('fact', 'original content', {}, { source: MemorySource.USER_STATED, confidence: 1 });
    const updated = long.update(id, { tags: ['important'], importance: 80 });
    assert.deepEqual(updated.tags, ['important']);
    assert.equal(updated.importance, 80);
    assert.equal(updated.content, 'original content', 'update() must not silently change content');
    assert.equal(updated.source, 'USER_STATED', 'update() must not touch provenance');
    assert.deepEqual(updated.history, []);
  });

  test('update() cannot overwrite structural fields like id or createdAt', () => {
    const long = new LongTermMemory({ dataDir: tmpDir() });
    const id = long.remember('fact', 'x');
    const before = long.getById(id);
    const updated = long.update(id, { id: 'hacked-id', createdAt: '2000-01-01T00:00:00Z' });
    assert.equal(updated.id, id);
    assert.equal(updated.createdAt, before.createdAt);
  });

  test('correct() replaces content, sets USER_CORRECTED, and preserves the prior content in history', () => {
    const long = new LongTermMemory({ dataDir: tmpDir() });
    const id = long.remember('preference', 'user likes X', {}, { source: MemorySource.AI_INFERRED, confidence: 0.45 });

    const corrected = long.correct(id, "user does NOT like X", { reason: 'user explicitly corrected this' });
    assert.equal(corrected.content, 'user does NOT like X');
    assert.equal(corrected.source, MemorySource.USER_CORRECTED);
    assert.equal(corrected.history.length, 1);
    assert.equal(corrected.history[0].content, 'user likes X');
    assert.equal(corrected.history[0].source, MemorySource.AI_INFERRED);
    assert.equal(corrected.history[0].reason, 'user explicitly corrected this');
  });

  test('correcting the same entry twice preserves BOTH prior versions in order', () => {
    const long = new LongTermMemory({ dataDir: tmpDir() });
    const id = long.remember('fact', 'v1');
    long.correct(id, 'v2', { reason: 'first correction' });
    const final = long.correct(id, 'v3', { reason: 'second correction' });
    assert.equal(final.content, 'v3');
    assert.equal(final.history.length, 2);
    assert.equal(final.history[0].content, 'v1');
    assert.equal(final.history[1].content, 'v2');
  });

  test('correcting a non-existent id returns null rather than throwing or creating a phantom entry', () => {
    const long = new LongTermMemory({ dataDir: tmpDir() });
    assert.equal(long.correct('does-not-exist', 'x'), null);
    assert.equal(long.update('does-not-exist', { tags: [] }), null);
  });
});

describe('LongTermMemory — deletion and expiry never resurface', () => {
  test('a deleted entry is gone from query() and getById()', () => {
    const long = new LongTermMemory({ dataDir: tmpDir() });
    const id = long.remember('fact', 'temp');
    assert.ok(long.forget(id));
    assert.equal(long.getById(id), null);
    assert.equal(long.query({ category: 'fact' }).length, 0);
  });

  test('an expired entry is excluded from query() by default but recoverable with includeExpired', () => {
    const long = new LongTermMemory({ dataDir: tmpDir() });
    const past = new Date(Date.now() - 1000).toISOString();
    long.remember('fact', 'stale', {}, { expiresAt: past });
    assert.equal(long.query({ category: 'fact' }).length, 0);
    assert.equal(long.query({ category: 'fact', includeExpired: true }).length, 1);
  });

  test('an entry with a future expiresAt is still returned normally', () => {
    const long = new LongTermMemory({ dataDir: tmpDir() });
    const future = new Date(Date.now() + 100000).toISOString();
    long.remember('fact', 'fresh', {}, { expiresAt: future });
    assert.equal(long.query({ category: 'fact' }).length, 1);
  });
});

describe('LongTermMemory — retrieval filters and access tracking', () => {
  test('query() filters by tag and relatedDeviceId', () => {
    const long = new LongTermMemory({ dataDir: tmpDir() });
    long.remember('device', 'device A has Chrome installed', {}, { tags: ['apps'], relatedDeviceId: 'device-a' });
    long.remember('device', 'device B has Firefox installed', {}, { tags: ['apps'], relatedDeviceId: 'device-b' });

    assert.equal(long.query({ tag: 'apps' }).length, 2);
    assert.equal(long.query({ relatedDeviceId: 'device-a' }).length, 1);
    assert.equal(long.query({ relatedDeviceId: 'device-a' })[0].content, 'device A has Chrome installed');
  });

  test('getById with markAccessed:true sets lastAccessedAt; without it, does not', () => {
    const long = new LongTermMemory({ dataDir: tmpDir() });
    const id = long.remember('fact', 'x');
    assert.equal(long.getById(id).lastAccessedAt, null);
    long.getById(id, { markAccessed: true });
    assert.ok(long.getById(id).lastAccessedAt);
  });

  test('markAccessed also mirrors into metadata.lastRecalledAt for MemoryRetentionManager compatibility', () => {
    const long = new LongTermMemory({ dataDir: tmpDir() });
    const id = long.remember('fact', 'x');
    long.getById(id, { markAccessed: true });
    const entry = long.getById(id);
    assert.equal(entry.metadata.lastRecalledAt, entry.lastAccessedAt);
  });
});

describe('MemoryManager pass-through', () => {
  test('remember() forwards provenance options to LongTermMemory', async () => {
    const dataDir = tmpDir();
    const manager = new MemoryManager({ router: { selectEmbedding: () => { throw new Error('no embedding provider'); } }, dataDir });
    const { longTermId } = await manager.remember('fact', 'test', {}, { source: MemorySource.SYSTEM_OBSERVED, confidence: 1 });
    const entry = manager.long.getById(longTermId);
    assert.equal(entry.source, 'SYSTEM_OBSERVED');
  });

  test('recallStructured with markAccessed:true actually bumps lastAccessedAt on returned entries', async () => {
    const dataDir = tmpDir();
    const manager = new MemoryManager({ router: { selectEmbedding: () => { throw new Error('no embedding'); } }, dataDir });
    await manager.remember('fact', 'recall me');
    const results = manager.recallStructured({ category: 'fact', markAccessed: true });
    assert.equal(results.length, 1);
    const after = manager.long.getById(results[0].id);
    assert.ok(after.lastAccessedAt);
  });

  test('update() and correct() are exposed and functional on MemoryManager', async () => {
    const dataDir = tmpDir();
    const manager = new MemoryManager({ router: { selectEmbedding: () => { throw new Error('no embedding'); } }, dataDir });
    const { longTermId } = await manager.remember('fact', 'v1');
    manager.update(longTermId, { tags: ['x'] });
    assert.deepEqual(manager.long.getById(longTermId).tags, ['x']);
    manager.correct(longTermId, 'v2', { reason: 'fix' });
    assert.equal(manager.long.getById(longTermId).content, 'v2');
  });
});

describe('LongTermMemory over real SQLite (Phase 3G reuse)', () => {
  test('remember/correct/update persist through a real SqliteStore across instances', () => {
    const dataDir = tmpDir();
    const sqliteStore = new SqliteStore(path.join(dataDir, 'test.sqlite'));
    try {
      const long1 = new LongTermMemory({ dataDir, sqliteStore });
      const id = long1.remember('fact', 'v1', {}, { source: MemorySource.USER_STATED, confidence: 1 });
      long1.correct(id, 'v2', { reason: 'test' });

      const long2 = new LongTermMemory({ dataDir, sqliteStore });
      const entry = long2.getById(id);
      assert.equal(entry.content, 'v2');
      assert.equal(entry.source, MemorySource.USER_CORRECTED);
      assert.equal(entry.history.length, 1);
    } finally {
      sqliteStore.close();
    }
  });

  test('migrates a legacy long_term_memory.json into SQLite without deleting the original file', () => {
    const dataDir = tmpDir();
    fs.writeFileSync(path.join(dataDir, 'long_term_memory.json'), JSON.stringify({
      entries: [{ id: 'legacy-1', category: 'fact', content: 'legacy fact', metadata: {}, createdAt: '2025-01-01T00:00:00Z' }],
    }));
    const sqliteStore = new SqliteStore(path.join(dataDir, 'test.sqlite'));
    try {
      const long = new LongTermMemory({ dataDir, sqliteStore });
      const entries = long.all();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].content, 'legacy fact');
      assert.ok(fs.existsSync(path.join(dataDir, 'long_term_memory.json')), 'the original file must not be deleted');
    } finally {
      sqliteStore.close();
    }
  });
});
