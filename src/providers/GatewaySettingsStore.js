import fs from 'node:fs';
import path from 'node:path';
import { GATEWAY_IDS, GATEWAY_DEFAULTS, normalizeBaseUrl } from './gatewayConfig.js';

/**
 * GatewaySettingsStore — owner-configurable FreeLLMAPI / LiteLLM settings.
 * SQLite is authoritative when supplied; existing JSON settings are imported
 * once and retained as a migration backup. API keys are never returned by
 * publicView. SqliteStore protects its database and WAL files with owner-only
 * permissions; JSON mode retains atomic 0600 writes.
 */
const FIELDS = ['enabled', 'baseUrl', 'apiKey', 'model', 'embeddingModel', 'vision', 'tools', 'timeoutMs'];
const SQLITE_KEY = 'settings:provider-gateways';

export class GatewaySettingsStore {
  /** @param {{ dataDir:string, config:object, logger?:object, sqliteStore?:object }} o */
  constructor({ dataDir, config, logger = console, sqliteStore = null }) {
    this.file = path.join(dataDir, 'provider-settings.json');
    this.config = config;
    this.logger = logger;
    this.sqliteStore = sqliteStore;
    this.envDefaults = Object.fromEntries(GATEWAY_IDS.map((id) => [id, { ...config.providers[id] }]));
    this.saved = {};
    this.loadError = null;
  }

  /** Reads settings and imports legacy JSON once. Never throws during startup. */
  load() {
    try {
      let raw = this.sqliteStore ? this.sqliteStore.get(SQLITE_KEY) : null;
      if (this.sqliteStore && raw === null && fs.existsSync(this.file)) {
        raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.sqliteStore.set(SQLITE_KEY, raw);
      }
      if (!this.sqliteStore && fs.existsSync(this.file)) raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return this;
      for (const id of GATEWAY_IDS) {
        if (raw[id] && typeof raw[id] === 'object') {
          try {
            const patch = this._validate(id, raw[id], { partial: true });
            this._apply(id, patch);
            this.saved[id] = { ...patch };
          } catch (err) {
            this.logger.warn?.(`[providers] ignoring invalid saved settings for ${id}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      this.loadError = err.message;
      this.logger.warn?.(`[providers] could not read saved settings (${err.message}) — using environment settings only`);
    }
    return this;
  }

  _validate(id, input) {
    const out = {};
    if (input.enabled !== undefined) out.enabled = input.enabled === true || input.enabled === 'true';
    if (input.baseUrl !== undefined) {
      const r = normalizeBaseUrl(input.baseUrl);
      if (!r.ok) throw new Error(`baseUrl: ${r.reason}`);
      out.baseUrl = r.url;
    }
    if (input.apiKey !== undefined) {
      if (input.apiKey !== null && typeof input.apiKey !== 'string') throw new Error('apiKey must be a string');
      const k = (input.apiKey ?? '').trim();
      if (k.length > 500 || /\s/.test(k)) throw new Error('apiKey looks invalid (whitespace or too long)');
      out.apiKey = k || null;
    }
    for (const f of ['model', 'embeddingModel']) {
      if (input[f] !== undefined) {
        const v = String(input[f] ?? '').trim();
        if (v.length > 200) throw new Error(`${f} is too long`);
        out[f] = v || (f === 'model' ? (GATEWAY_DEFAULTS[id].model ?? '') : null);
      }
    }
    for (const f of ['vision', 'tools']) if (input[f] !== undefined) out[f] = input[f] === true || input[f] === 'true';
    if (input.timeoutMs !== undefined) {
      const n = Number(input.timeoutMs);
      if (!Number.isFinite(n) || n < 1000 || n > 600000) throw new Error('timeoutMs must be between 1000 and 600000');
      out.timeoutMs = n;
    }
    for (const k of Object.keys(input)) if (!FIELDS.includes(k)) throw new Error(`unknown setting '${k}'`);
    return out;
  }

  _apply(id, patch) { Object.assign(this.config.providers[id], patch); }

  update(id, input) {
    if (!GATEWAY_IDS.includes(id)) throw new Error(`unknown gateway '${id}'`);
    if (!input || typeof input !== 'object') throw new Error('settings object required');
    const patch = this._validate(id, input);
    this._apply(id, patch);
    this.saved[id] = { ...(this.saved[id] ?? {}), ...patch };
    this._persist();
    return this.publicView(id);
  }

  reset(id) {
    if (!GATEWAY_IDS.includes(id)) throw new Error(`unknown gateway '${id}'`);
    delete this.saved[id];
    Object.assign(this.config.providers[id], this.envDefaults[id]);
    this._persist();
    return this.publicView(id);
  }

  _persist() {
    if (this.sqliteStore) {
      this.sqliteStore.set(SQLITE_KEY, this.saved);
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* Windows */ }
  }

  /** Client-safe view: never returns the API key, only whether one is set. */
  publicView(id) {
    const c = this.config.providers[id];
    return { id, enabled: Boolean(c.enabled), baseUrl: c.baseUrl, model: c.model, embeddingModel: c.embeddingModel, vision: Boolean(c.vision), tools: c.tools !== false, timeoutMs: c.timeoutMs, apiKeySet: Boolean(c.apiKey), source: this.saved[id] && Object.keys(this.saved[id]).length ? 'settings' : 'environment' };
  }
}
