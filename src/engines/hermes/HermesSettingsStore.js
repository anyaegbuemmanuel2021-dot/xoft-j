import fs from 'node:fs';
import path from 'node:path';
import { validateHermesSettings } from './hermesConfig.js';

const SQLITE_KEY = 'settings:hermes';

/**
 * Persists validated, non-secret Hermes settings. API credentials are deliberately
 * excluded and remain in EngineSecretStore / environment configuration.
 * SQLite mode imports the old JSON file once and leaves it untouched as backup.
 */
export class HermesSettingsStore {
  constructor({ dataDir = './data', sqliteStore = null } = {}) {
    this.file = path.join(dataDir, 'engines', 'hermes-settings.json');
    this.sqliteStore = sqliteStore;
  }

  load() {
    try {
      let raw = this.sqliteStore ? this.sqliteStore.get(SQLITE_KEY) : null;
      if (this.sqliteStore && raw === null && fs.existsSync(this.file)) {
        raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.sqliteStore.set(SQLITE_KEY, validateHermesSettings(raw, { strictKeys: false }));
      }
      if (!this.sqliteStore) raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return validateHermesSettings(raw ?? {}, { strictKeys: false });
    } catch { return {}; }
  }

  save(settings) {
    const safe = validateHermesSettings(settings);
    if (this.sqliteStore) {
      this.sqliteStore.set(SQLITE_KEY, safe);
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(safe, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* Windows */ }
  }

  update(partial) {
    const next = { ...this.load(), ...validateHermesSettings(partial) };
    this.save(next);
    return next;
  }

  reset() {
    if (this.sqliteStore) this.sqliteStore.delete(SQLITE_KEY);
    else { try { fs.unlinkSync(this.file); } catch { /* nothing saved */ } }
  }
}
