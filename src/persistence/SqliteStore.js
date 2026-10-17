import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// node:sqlite is loaded lazily (not as a static import) so that simply
// importing this file never crashes a runtime that lacks it (some
// serverless/edge Node builds ship without experimental built-ins even on
// Node 22+). The constructor still requires it — SqliteStore genuinely
// needs SQLite — but callers that never instantiate it (STORAGE_MODE !=
// 'sqlite') are unaffected, and the failure mode here is a clear thrown
// error instead of the whole process failing to boot.
function loadDatabaseSync() {
  try {
    return createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch (err) {
    throw new Error(
      'SqliteStore requires the node:sqlite built-in (Node 22.5+, and not available on all ' +
      'serverless/edge runtimes). Set STORAGE_MODE=json to fall back to file-based storage on ' +
      `this host instead. Original error: ${err.message}`
    );
  }
}

export class SqliteStore {
  constructor(filePath = './data/xoft.sqlite') {
    const DatabaseSync = loadDatabaseSync();
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_commands_device_status ON commands(device_id, status);

      -- Per-device bearer credentials (spec section 10 — device-to-cloud auth
      -- distinct from the human/admin shared API key). Only a salted hash is
      -- ever stored; the raw token is returned once, at issue time, and never
      -- persisted or logged anywhere.
      CREATE TABLE IF NOT EXISTS device_tokens (
        token_hash TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_device_tokens_device ON device_tokens(device_id);
    `);
  }
  get(key) { const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
  set(key, value) { this.db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  loadDevices() { return this.db.prepare('SELECT value FROM devices').all().map(r => JSON.parse(r.value)); }
  saveDevice(device) { this.db.prepare('INSERT INTO devices(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(device.id, JSON.stringify(device)); }
  loadCommands() { return this.db.prepare('SELECT value FROM commands').all().map(r => JSON.parse(r.value)); }
  saveCommand(command) { this.db.prepare('INSERT INTO commands(id,device_id,status,value) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET device_id=excluded.device_id,status=excluded.status,value=excluded.value').run(command.id, command.deviceId, command.status, JSON.stringify(command)); }

  // --- Device tokens ---
  saveDeviceToken({ tokenHash, deviceId, createdAt }) {
    this.db.prepare('INSERT INTO device_tokens(token_hash, device_id, created_at) VALUES(?,?,?)').run(tokenHash, deviceId, createdAt);
  }
  /** Returns { deviceId } for a live (non-revoked) token hash, or null. */
  findDeviceToken(tokenHash) {
    const row = this.db.prepare('SELECT device_id, revoked_at FROM device_tokens WHERE token_hash=?').get(tokenHash);
    if (!row || row.revoked_at) return null;
    return { deviceId: row.device_id };
  }
  revokeDeviceTokens(deviceId) {
    this.db.prepare("UPDATE device_tokens SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL").run(new Date().toISOString(), deviceId);
  }

  close() { this.db.close(); }
}
