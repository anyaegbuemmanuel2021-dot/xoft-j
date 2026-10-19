import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../src/memory/MemoryManager.js';

test('memory writes and local recall survive embedding quota failures', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'xoft-memory-fallback-'));
  try {
    const manager = new MemoryManager({
      dataDir,
      router: {
        selectEmbedding() {
          return {
            async embed() {
              throw new Error('429 insufficient_quota: credit_balance_exhausted');
            },
          };
        },
      },
    });

    const saved = await manager.remember('preference', 'Address me as Sir by default', {}, {
      source: 'USER_STATED',
      confidence: 1,
    });

    assert.ok(saved.longTermId, 'structured memory should be saved');
    assert.equal(saved.vectorId, null, 'vector id should be null when embedding fails');
    assert.equal(manager.vectorEnabled, false, 'failing embeddings should be disabled for this process');

    const structured = manager.recallStructured({ category: 'preference' });
    assert.equal(structured.length, 1);
    assert.match(structured[0].content, /Address me as Sir/);

    const recalled = await manager.recallSemantic('how should you address me', 5);
    assert.equal(recalled.length, 1);
    assert.match(recalled[0].content, /Address me as Sir/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
