import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActivityLog } from '../src/activity/ActivityLog.js';
import { SqliteStore } from '../src/persistence/SqliteStore.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-activity-log-'));
}

describe('ActivityLog SQLite durability', () => {
  test('appends and filters events through SQLite across instances', () => {
    const dataDir = tmpDir();
    const sqlite = new SqliteStore(path.join(dataDir, 'xoft.sqlite'));
    try {
      const first = new ActivityLog({ dataDir, sqliteStore: sqlite });
      const taskA = first.log({ type: 'task_created', taskId: 'a' });
      first.log({ type: 'task_completed', taskId: 'a' });
      first.log({ type: 'task_created', taskId: 'b' });

      const restarted = new ActivityLog({ dataDir, sqliteStore: sqlite });
      assert.equal(restarted.all().length, 3);
      assert.deepEqual(restarted.query({ taskId: 'a' }).map((entry) => entry.type), ['task_created', 'task_completed']);
      assert.equal(restarted.all()[0].id, taskA);
      assert.equal(fs.existsSync(path.join(dataDir, 'activity_log.json')), false);
    } finally {
      sqlite.close();
    }
  });

  test('imports existing JSON history once without deleting the legacy file', () => {
    const dataDir = tmpDir();
    const legacyEntries = [
      { id: 'legacy-1', ts: '2026-01-01T00:00:00.000Z', type: 'task_created', taskId: 'old' },
      { id: 'legacy-2', ts: '2026-01-02T00:00:00.000Z', type: 'task_completed', taskId: 'old' },
    ];
    const legacyPath = path.join(dataDir, 'activity_log.json');
    fs.writeFileSync(legacyPath, JSON.stringify({ entries: legacyEntries }));
    const sqlite = new SqliteStore(path.join(dataDir, 'xoft.sqlite'));
    try {
      const log = new ActivityLog({ dataDir, sqliteStore: sqlite });
      assert.deepEqual(log.all(), legacyEntries);
      log.log({ type: 'new_event', taskId: 'new' });
      const restarted = new ActivityLog({ dataDir, sqliteStore: sqlite });
      assert.equal(restarted.all().length, 3);
      assert.deepEqual(JSON.parse(fs.readFileSync(legacyPath, 'utf8')).entries, legacyEntries);
    } finally {
      sqlite.close();
    }
  });

  test('retains file-backed behavior when SQLite is not configured', () => {
    const dataDir = tmpDir();
    const log = new ActivityLog({ dataDir });
    log.log({ type: 'legacy_mode' });
    assert.equal(log.all()[0].type, 'legacy_mode');
  });
});
