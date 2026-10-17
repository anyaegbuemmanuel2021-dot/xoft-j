import fs from 'node:fs';
import { JsonStore } from '../persistence/JsonStore.js';
import path from 'node:path';

/** The full capability matrix from spec sections 8 and 46. Not all are executable by this
 * backend (many need a native companion app) — this is the permission model either way,
 * since granting/revoking/auditing permission is a UI/data concern independent of whether
 * the underlying action is implemented yet. */
export const ALL_PERMISSIONS = [
  'contacts.read', 'contacts.write',
  'calls.initiate', 'calls.answer', 'calls.reject',
  'sms.read', 'sms.send',
  'email.read', 'email.send',
  'notifications.read', 'notifications.manage',
  'whatsapp.read', 'whatsapp.search', 'whatsapp.send', 'whatsapp.media',
  'camera.view', 'camera.capture', 'camera.video',
  'microphone.listen', 'microphone.record',
  'files.read', 'files.write', 'files.move', 'files.rename', 'files.delete',
  'screen.read', 'screen.interact', 'screen.capture',
  'apps.list', 'apps.launch', 'apps.close', 'apps.interact',
  'calendar.read', 'calendar.write',
  'location.read',
  'media.control',
  'connectors.use', 'ai.background',
  // Device Runtime (browser automation, workspaces, terminal, operation journal)
  'browser.read', 'browser.navigate', 'browser.interact',
  'terminal.safe', 'terminal.build',
  'workspace.read', 'workspace.select',
  'operations.read', 'operations.undo',
  'runtime.halt',
];

const namespaceOf = (permission) => permission.split('.')[0];
const KNOWN_NAMESPACES = new Set(ALL_PERMISSIONS.map(namespaceOf));

/**
 * PermissionSystem — spec sections 8, 30, 46. Every grant is explicit,
 * visible, revocable, and logged.
 *
 * v2 additions (hierarchical permission engine):
 *   - Granting a NAMESPACE (e.g. "whatsapp") covers every leaf under it
 *     (whatsapp.read, whatsapp.send, ...) instead of requiring each one
 *     individually — matches the PHONE/WHATSAPP/FILES tree from the spec.
 *   - Grants can carry a TTL (ttlMinutes); expired grants are treated as
 *     absent by every check — nothing is trusted indefinitely just because
 *     it was granted once. Expired rows are pruned lazily on next write.
 *   - `check()` is the real per-execution gate ToolRegistry calls before
 *     running any tool with requiredPermissions; `has()` stays as an alias
 *     so existing callers are unaffected.
 */
export class PermissionSystem {
  constructor({ activityLog, dataDir = './data', sqliteStore = null }) {
    this.activityLog = activityLog;
    this._store = new JsonStore({ dataDir, fileName: 'permissions.json', kvKey: 'permissions', defaultValue: { grants: [] }, sqliteStore });
  }

  _load() {
    return this._store.load();
  }

  _save(data) {
    this._store.save(data);
  }

  _isExpired(grant) {
    return Boolean(grant.expiresAt) && new Date(grant.expiresAt).getTime() <= Date.now();
  }

  /**
   * @param {string} deviceId
   * @param {string} permission an exact leaf ('whatsapp.send') or a whole namespace ('whatsapp')
   * @param {{ttlMinutes?: number}} [options]
   */
  grant(deviceId, permission, { ttlMinutes } = {}) {
    const isLeaf = ALL_PERMISSIONS.includes(permission);
    const isNamespace = KNOWN_NAMESPACES.has(permission);
    if (!isLeaf && !isNamespace) {
      throw new Error(`PermissionSystem: unknown permission or namespace '${permission}'`);
    }
    const data = this._load();
    // Prune expired rows on every write so the file doesn't grow unbounded with stale grants.
    data.grants = data.grants.filter((g) => !this._isExpired(g));

    const exists = data.grants.find((g) => g.deviceId === deviceId && g.permission === permission);
    const expiresAt = ttlMinutes ? new Date(Date.now() + ttlMinutes * 60_000).toISOString() : null;
    if (exists) {
      exists.expiresAt = expiresAt; // re-granting refreshes/replaces any previous TTL
    } else {
      data.grants.push({ deviceId, permission, grantedAt: new Date().toISOString(), expiresAt, lastUsedAt: null });
    }
    this._save(data);
    this.activityLog.log({ type: 'permission_granted', detail: { deviceId, permission, expiresAt } });
    return this.list(deviceId);
  }

  revoke(deviceId, permission) {
    const data = this._load();
    data.grants = data.grants.filter((g) => !(g.deviceId === deviceId && g.permission === permission));
    this._save(data);
    this.activityLog.log({ type: 'permission_revoked', detail: { deviceId, permission } });
    return this.list(deviceId);
  }

  /**
   * The real check: is `permission` currently usable by `deviceId`, right
   * now — accounting for namespace-level grants and TTL expiry. This is
   * what ToolRegistry calls before every execution; nothing is cached
   * across calls, so a revoke or expiry takes effect immediately.
   */
  check(deviceId, permission) {
    const ns = namespaceOf(permission);
    return this._load().grants.some(
      (g) => g.deviceId === deviceId && !this._isExpired(g) && (g.permission === permission || g.permission === ns)
    );
  }

  /** Alias kept for existing callers — same hierarchy+TTL-aware logic as check(). */
  has(deviceId, permission) {
    return this.check(deviceId, permission);
  }

  markUsed(deviceId, permission) {
    const data = this._load();
    const grant = data.grants.find((g) => g.deviceId === deviceId && g.permission === permission);
    if (grant) {
      grant.lastUsedAt = new Date().toISOString();
      this._save(data);
    }
  }

  /** Live grants only (expired rows omitted) — what the device can actually do right now. */
  list(deviceId) {
    return this._load().grants.filter((g) => g.deviceId === deviceId && !this._isExpired(g));
  }

  grantedSet(deviceId) {
    return new Set(this.list(deviceId).map((g) => g.permission));
  }
}
