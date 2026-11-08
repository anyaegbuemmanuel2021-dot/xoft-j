import fs from 'node:fs';
import path from 'node:path';

/**
 * JsonStore — the same "read whole JSON blob / write whole JSON blob"
 * pattern every planner store (TaskPlanner, ExecutionRecordStore,
 * ExperienceStore, ...) already used directly against a flat file, now
 * factored out so those stores can transparently use SqliteStore's generic
 * `kv` table instead, when available — without changing their own public
 * API or any test that constructs them.
 *
 * This is Phase 3G's "gradual migration": nothing is deleted, no one-shot
 * rewrite. Behavior with sqliteStore=null (the default, and every existing
 * caller/test) is byte-for-byte the same flat-file behavior as before.
 *
 * When a SqliteStore IS supplied and this is the first read for a given
 * key, any existing on-disk JSON file for it is loaded once and copied into
 * SQLite as that key's row (data survives a STORAGE_MODE switch instead of
 * silently starting empty) — after that, SQLite is authoritative and the
 * flat file is simply left alone on disk, untouched.
 */
export class JsonStore {
  constructor({ dataDir = './data', fileName, kvKey, defaultValue, sqliteStore = null }) {
    this.filePath = path.join(dataDir, fileName);
    this.kvKey = kvKey ?? fileName.replace(/\.json$/, '');
    this.defaultValue = defaultValue;
    this.sqliteStore = sqliteStore;

    if (!this.sqliteStore) {
      fs.mkdirSync(dataDir, { recursive: true });
      if (!fs.existsSync(this.filePath)) {
        fs.writeFileSync(this.filePath, JSON.stringify(defaultValue, null, 2));
      }
    }
  }

  load() {
    if (this.sqliteStore) {
      let value = this.sqliteStore.get(this.kvKey);
      if (value === null) {
        // First time this key has ever been read from SQLite — migrate in a
        // legacy on-disk file if one exists, so switching STORAGE_MODE to
        // 'sqlite' never silently loses prior JSON-mode data.
        value = fs.existsSync(this.filePath) ? JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) : this.defaultValue;
        this.sqliteStore.set(this.kvKey, value);
      }
      return value;
    }
    return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
  }

  save(value) {
    if (this.sqliteStore) {
      this.sqliteStore.set(this.kvKey, value);
      return;
    }
    fs.writeFileSync(this.filePath, JSON.stringify(value, null, 2));
  }
}
