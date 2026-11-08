import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * ActivityLog — append-only audit history. SQLite is authoritative when
 * supplied; legacy JSON history is imported once and retained as a backup.
 * File mode remains supported for existing tests and JSON deployments.
 */
export class ActivityLog {
  constructor({ dataDir = './data', sqliteStore = null } = {}) {
    this.filePath = path.join(dataDir, 'activity_log.json');
    this.sqliteStore = sqliteStore;

    if (this.sqliteStore) {
      // One-time, lossless migration from the previous file-backed format.
      if (this.sqliteStore.countActivityLogs() === 0 && fs.existsSync(this.filePath)) {
        const legacy = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        for (const entry of legacy.entries ?? []) this.sqliteStore.appendActivityLog(entry);
      }
      return;
    }

    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({ entries: [] }, null, 2));
    }
  }

  _load() {
    return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
  }

  _save(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  log(event) {
    const entry = { id: crypto.randomUUID(), ts: new Date().toISOString(), ...event };
    if (this.sqliteStore) {
      this.sqliteStore.appendActivityLog(entry);
      return entry.id;
    }
    const data = this._load();
    data.entries.push(entry);
    this._save(data);
    return entry.id;
  }

  query({ taskId } = {}) {
    if (this.sqliteStore) return this.sqliteStore.loadActivityLogs({ taskId });
    const data = this._load();
    return taskId ? data.entries.filter((e) => e.taskId === taskId) : data.entries;
  }

  all() {
    if (this.sqliteStore) return this.sqliteStore.loadActivityLogs();
    return this._load().entries;
  }
}
