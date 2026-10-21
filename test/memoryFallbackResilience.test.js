import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../src/memory/MemoryManager.js';

function withDataDir(run) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'xoft-memory-resilience-'));
  return Promise.resolve()
    .then(() => run(dataDir))
    .finally(() => rmSync(dataDir, { recursive: true, force: true }));
}

test('quota failure preserves structured memory, disables repeated embeddings, and falls back to lexical recall', async () => {
  await withDataDir(async (dataDir) => {
    let embedCalls = 0;
    const manager = new MemoryManager({
      dataDir,
      router: {
        selectEmbedding() {
          return {
            async embed() {
              embedCalls += 1;
              throw new Error('429 insufficient_quota: credit_balance_exhausted');
            },
          };
        },
      },
    });

    const saved = await manager.remember('preference', 'The green interface is preferred', {}, {
      source: 'USER_STATED',
      confidence: 1,
    });

    assert.ok(saved.longTermId);
    assert.equal(saved.vectorId, null);
    assert.equal(manager.vectorEnabled, false);
    assert.equal(embedCalls, 1, 'a failed provider must be disabled for this process');

    const recalled = await manager.recallSemantic('which interface is preferred');
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0].id, saved.longTermId);
    assert.match(recalled[0].content, /green interface/i);
    assert.ok(recalled[0].score > 0);
    assert.equal(embedCalls, 1, 'local recall must not retry the paid embedding provider');
  });
});

test('local lexical recall works when no embedding provider is configured', async () => {
  await withDataDir(async (dataDir) => {
    const manager = new MemoryManager({
      dataDir,
      router: { selectEmbedding() { throw new Error('no embedding provider'); } },
    });
    const saved = await manager.remember('project', 'XOFT should keep durable conversation history');
    const recalled = await manager.recallSemantic('durable conversation history');
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0].id, saved.longTermId);
    assert.ok(recalled[0].score > 0);
  });
});

test('a query-time embedding failure falls back locally and is not retried on the next search', async () => {
  await withDataDir(async (dataDir) => {
    let embedCalls = 0;
    const manager = new MemoryManager({
      dataDir,
      router: {
        selectEmbedding() {
          return {
            async embed(text) {
              embedCalls += 1;
              if (text === 'green interface preference') {
                throw new Error('429 insufficient_quota');
              }
              return [1, 0];
            },
          };
        },
      },
    });
    const saved = await manager.remember('preference', 'The green interface is preferred');
    assert.equal(embedCalls, 1);

    const first = await manager.recallSemantic('green interface preference');
    assert.equal(first[0].id, saved.longTermId);
    assert.equal(manager.vectorEnabled, false);
    assert.equal(embedCalls, 2);

    const second = await manager.recallSemantic('green interface preference');
    assert.equal(second[0].id, saved.longTermId);
    assert.equal(embedCalls, 2, 'disabled semantic search must stay local until process restart');
  });
});

test('structured memory deletion succeeds even if vector cleanup fails', async () => {
  await withDataDir(async (dataDir) => {
    const manager = new MemoryManager({
      dataDir,
      router: { selectEmbedding: () => ({ async embed() { return [1, 0]; } }) },
    });
    const saved = await manager.remember('fact', 'temporary test memory');
    manager.vector.search = async () => { throw new Error('embedding provider unavailable'); };

    assert.equal(await manager.forgetById(saved.longTermId), true);
    assert.equal(manager.long.getById(saved.longTermId), null);
    assert.equal(manager.vectorEnabled, false);
  });
});
