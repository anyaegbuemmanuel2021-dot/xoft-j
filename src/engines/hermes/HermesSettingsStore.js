import fs from 'node:fs';
import path from 'node:path';
import { validateHermesSettings } from './hermesConfig.js';

/**
 * Persists the Hermes settings saved from the UI/API (data/engines/hermes-settings.json, owner-only).
 * Holds NO secrets by construction (validateHermesSettings rejects unknown keys; the API key is not a setting).
 * load() never throws: a missing or corrupt file simply means "use the environment/defaults".
 */
export class HermesSettingsStore {
  constructor({ dataDir = './data' } = {}) {
    this.file = path.join(dataDir, 'engines', 'hermes-settings.json');
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return validateHermesSettings(raw, { strictKeys: false });
    } catch { return {}; }
  }

  save(settings) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* Windows */ }
  }

  /** Merges a validated partial update into what is saved. Returns the new saved object. */
  update(partial) {
    const next = { ...this.load(), ...validateHermesSettings(partial) };
    this.save(next);
    return next;
  }

  reset() { try { fs.unlinkSync(this.file); } catch { /* nothing saved */ } }
}
