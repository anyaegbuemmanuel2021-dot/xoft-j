import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

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
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS whatsapp_messages (
        id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, sender TEXT, recipient TEXT, value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_whatsapp_timestamp ON whatsapp_messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_whatsapp_sender ON whatsapp_messages(sender);
      CREATE INDEX IF NOT EXISTS idx_whatsapp_recipient ON whatsapp_messages(recipient);
      CREATE TABLE IF NOT EXISTS activity_logs (
        id TEXT PRIMARY KEY, ts TEXT NOT NULL, task_id TEXT, value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_activity_logs_task_ts ON activity_logs(task_id, ts);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_commands_device_status ON commands(device_id, status);
      CREATE TABLE IF NOT EXISTS device_tokens (
        token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_device_tokens_device ON device_tokens(device_id);

      -- Append-only task event journal for autonomous engine runs.
      CREATE TABLE IF NOT EXISTS engine_events (
        task_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY(task_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_engine_events_task_seq ON engine_events(task_id, seq);
    `);
    this._secureFiles();
  }

  // Settings can contain provider credentials. Protect the database and WAL
  // sidecars as well as the legacy JSON files that preceded SQLite storage.
  _secureFiles() {
    for (const file of [this.filePath, `${this.filePath}-wal`, `${this.filePath}-shm`]) {
      try { if (fs.existsSync(file)) fs.chmodSync(file, 0o600); } catch { /* platform/filesystem may not support chmod */ }
    }
  }

  get(key) { const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
  delete(key) { this.db.prepare('DELETE FROM kv WHERE key=?').run(key); }
  set(key, value) {
    this.db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    this._secureFiles();
  }
  countWhatsAppMessages() { return this.db.prepare('SELECT COUNT(*) AS count FROM whatsapp_messages').get().count; }
  loadWhatsAppMessages() { return this.db.prepare('SELECT value FROM whatsapp_messages ORDER BY timestamp ASC, rowid ASC').all().map((row) => JSON.parse(row.value)); }
  saveWhatsAppMessage(message) {
    this.db.prepare('INSERT INTO whatsapp_messages(id,timestamp,sender,recipient,value) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET timestamp=excluded.timestamp,sender=excluded.sender,recipient=excluded.recipient,value=excluded.value')
      .run(message.id, String(message.timestamp ?? ''), message.from ?? null, message.to ?? null, JSON.stringify(message));
    this._secureFiles();
  }
  pruneWhatsAppMessages(maxMessages) {
    const max = Math.max(1, Math.trunc(Number(maxMessages) || 5000));
    this.db.prepare('DELETE FROM whatsapp_messages WHERE id IN (SELECT id FROM whatsapp_messages ORDER BY timestamp DESC, rowid DESC LIMIT -1 OFFSET ?)').run(max);
  }
  countActivityLogs() { return this.db.prepare('SELECT COUNT(*) AS count FROM activity_logs').get().count; }
  appendActivityLog(entry) {
    this.db.prepare('INSERT INTO activity_logs(id, ts, task_id, value) VALUES(?,?,?,?)').run(entry.id, entry.ts, entry.taskId ?? null, JSON.stringify(entry));
    this._secureFiles();
  }
  loadActivityLogs({ taskId } = {}) {
    const rows = taskId
      ? this.db.prepare('SELECT value FROM activity_logs WHERE task_id=? ORDER BY rowid ASC').all(taskId)
      : this.db.prepare('SELECT value FROM activity_logs ORDER BY rowid ASC').all();
    return rows.map((row) => JSON.parse(row.value));
  }
  loadDevices() { return this.db.prepare('SELECT value FROM devices').all().map(r => JSON.parse(r.value)); }
  saveDevice(device) {
    this.db.prepare('INSERT INTO devices(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(device.id, JSON.stringify(device));
    this._secureFiles();
  }
  loadCommands() { return this.db.prepare('SELECT value FROM commands').all().map(r => JSON.parse(r.value)); }
  saveCommand(command) {
    this.db.prepare('INSERT INTO commands(id,device_id,status,value) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET device_id=excluded.device_id,status=excluded.status,value=excluded.value').run(command.id, command.deviceId, command.status, JSON.stringify(command));
    this._secureFiles();
  }
  saveDeviceToken({ tokenHash, deviceId, createdAt }) {
    this.db.prepare('INSERT INTO device_tokens(token_hash, device_id, created_at) VALUES(?,?,?)').run(tokenHash, deviceId, createdAt);
    this._secureFiles();
  }
  findDeviceToken(tokenHash) {
    const row = this.db.prepare('SELECT device_id, revoked_at FROM device_tokens WHERE token_hash=?').get(tokenHash);
    if (!row || row.revoked_at) return null;
    return { deviceId: row.device_id };
  }
  revokeDeviceTokens(deviceId) {
    this.db.prepare("UPDATE device_tokens SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL").run(new Date().toISOString(), deviceId);
    this._secureFiles();
  }
  // --- Engine task event journal ---
  saveEngineEvent(taskId, event) {
    this.db.prepare('INSERT OR IGNORE INTO engine_events(task_id, seq, ts, value) VALUES(?,?,?,?)')
      .run(taskId, event.seq, event.ts, JSON.stringify(event));
    this._secureFiles();
  }
  loadEngineEvents(taskId) {
    return this.db.prepare('SELECT value FROM engine_events WHERE task_id=? ORDER BY seq ASC').all(taskId).map((row) => JSON.parse(row.value));
  }
  engineEventBytes(taskId) {
    return this.db.prepare('SELECT COALESCE(SUM(length(CAST(value AS BLOB))), 0) AS bytes FROM engine_events WHERE task_id=?').get(taskId).bytes;
  }
  deleteEngineEvents(taskId) {
    this.db.prepare('DELETE FROM engine_events WHERE task_id=?').run(taskId);
    this._secureFiles();
  }

  close() { this.db.close(); }
}
