import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/persistence/SqliteStore.js';
import { VectorMemory } from '../src/memory/VectorMemory.js';

test('VectorMemory persists in SQLite mode', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xoft-vector-'));
  const dbPath = path.join(dir, 'xoft.sqlite');
  try {
    const store = new SqliteStore(dbPath);
    const vector = new VectorMemory({
      dataDir: dir,
      sqliteStore: store,
      embedFn: async (text) => text.toLowerCase().includes('hello') ? [1, 0] : [0, 1],
    });
    const id = await vector.add('hello world', { source: 'test' });
    assert.ok(id);
    assert.equal((await vector.search('hello', 1))[0].id, id);

    const reopened = new SqliteStore(dbPath);
    const vector2 = new VectorMemory({
      dataDir: dir,
      sqliteStore: reopened,
      embedFn: async () => [1, 0],
    });
    const results = await vector2.search('hello', 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].content, 'hello world');
    assert.equal(results[0].metadata.source, 'test');
    reopened.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
