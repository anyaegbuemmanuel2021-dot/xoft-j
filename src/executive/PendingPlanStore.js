/**
 * Bounded, expiring storage for high-risk plans awaiting explicit confirmation.
 *
 * This is intentionally process-local: it prevents stale confirmations and
 * unbounded session growth without pretending a pending approval survives a
 * server restart. The associated task remains governed by TaskPlanner.
 */
export class PendingPlanStore {
  constructor({ ttlMs = 15 * 60_000, maxEntries = 500, now = Date.now } = {}) {
    this.ttlMs = Number.isFinite(Number(ttlMs)) ? Math.max(1_000, Number(ttlMs)) : 15 * 60_000;
    this.maxEntries = Number.isFinite(Number(maxEntries)) ? Math.max(1, Math.floor(maxEntries)) : 500;
    this.now = now;
    this.entries = new Map();
  }

  _prune() {
    const now = this.now();
    for (const [sessionId, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(sessionId);
    }
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  set(sessionId, plan) {
    this._prune();
    const previous = this.entries.get(sessionId)?.plan ?? null;
    this.entries.delete(sessionId);
    this.entries.set(sessionId, { plan, expiresAt: this.now() + this.ttlMs });
    this._prune();
    return previous;
  }

  get(sessionId) {
    this._prune();
    return this.entries.get(sessionId)?.plan ?? null;
  }

  take(sessionId) {
    this._prune();
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    this.entries.delete(sessionId);
    return entry.plan;
  }

  delete(sessionId) {
    this._prune();
    const plan = this.entries.get(sessionId)?.plan ?? null;
    this.entries.delete(sessionId);
    return plan;
  }
}
