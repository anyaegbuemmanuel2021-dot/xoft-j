import crypto from 'node:crypto';

/**
 * DeviceTokenService — spec section 10 (secure device-to-cloud comms).
 *
 * Today every device agent (phone, PC) that talks to this backend
 * authenticates with the *same* human/admin shared secret (AUTH_API_KEYS) as
 * the dashboard — meaning any paired device has full API access, not just
 * access to its own command channel. This gives each *trusted* device its
 * own bearer token, scoped to that device's id, so a compromised or revoked
 * device can be cut off individually without rotating the admin key.
 *
 * Tokens are high-entropy random values, not passwords — a fast SHA-256
 * hash for lookup is appropriate here (no offline dictionary-attack surface
 * the way a human password has). The raw token is generated and returned
 * exactly once, at issue time, and is never itself persisted or logged.
 *
 * Falls back to an in-memory store (with a startup warning) when SQLite
 * storage isn't enabled — tokens then don't survive a process restart,
 * same graceful-degradation shape as the rest of this codebase's storage
 * layer. This is not silently "fine": callers should treat that mode as
 * dev-only, same as running with AUTH_API_KEYS unset.
 */
export class DeviceTokenService {
  constructor({ store = null, activityLog } = {}) {
    this.store = store;
    this.activityLog = activityLog;
    if (!this.store) {
      console.warn(
        'WARNING: DeviceTokenService has no durable store (STORAGE_MODE != sqlite) — ' +
        'issued device tokens will NOT survive a restart. Fine for local dev only.'
      );
      this._memory = new Map(); // tokenHash -> { deviceId, revoked }
    }
  }

  static hash(rawToken) {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  /** Mints a new token for a device. Returns the RAW token — show/send it once, never store it raw. */
  issue(deviceId) {
    if (!deviceId) throw new Error('DeviceTokenService.issue: deviceId is required');
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = DeviceTokenService.hash(rawToken);
    const createdAt = new Date().toISOString();
    if (this.store) {
      this.store.saveDeviceToken({ tokenHash, deviceId, createdAt });
    } else {
      this._memory.set(tokenHash, { deviceId, revoked: false });
    }
    this.activityLog?.log({ type: 'device_token_issued', detail: { deviceId } });
    return rawToken;
  }

  /** Returns the deviceId a live (non-revoked) raw token belongs to, or null. */
  verify(rawToken) {
    if (!rawToken) return null;
    const tokenHash = DeviceTokenService.hash(rawToken);
    if (this.store) {
      const found = this.store.findDeviceToken(tokenHash);
      return found ? found.deviceId : null;
    }
    const entry = this._memory.get(tokenHash);
    if (!entry || entry.revoked) return null;
    return entry.deviceId;
  }

  /** Revokes every live token for a device — call this on device revoke/untrust. */
  revokeAllForDevice(deviceId) {
    if (this.store) {
      this.store.revokeDeviceTokens(deviceId);
    } else {
      for (const entry of this._memory.values()) {
        if (entry.deviceId === deviceId) entry.revoked = true;
      }
    }
    this.activityLog?.log({ type: 'device_tokens_revoked', detail: { deviceId } });
  }
}
