'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ActionPolicy } = require('./ActionPolicy');

/**
 * RuntimeGuard — the single object executors receive. assertAllowed(action) checks, in order:
 * halt → policy → mutation rate limit, and writes an audit record for every denial and every
 * mutating allow. No executor performs a guarded action without calling this first.
 */
class RuntimeGuard {
  constructor({ halt, policy = new ActionPolicy(), stateDir, maxMutationsPerMinute = 120, now = Date.now } = {}) {
    if (!halt) throw new Error('RuntimeGuard: halt (HaltGuard) is required');
    this.halt = halt; this.policy = policy; this.now = now;
    this.maxMutationsPerMinute = maxMutationsPerMinute;
    this.auditPath = stateDir ? path.join(stateDir, 'audit.log') : null;
    this._stamps = [];
    if (stateDir) fs.mkdirSync(stateDir, { recursive: true });
  }

  audit(event, detail = {}) {
    if (!this.auditPath) return;
    try { fs.appendFileSync(this.auditPath, JSON.stringify({ ts: new Date(this.now()).toISOString(), event, ...detail }) + '\n'); } catch { /* audit failure must not mask the action result */ }
  }

  assertAllowed(capabilityAction, detail = {}) {
    try { this.halt.assertNotHalted(); } catch (err) { this.audit('denied.halted', { action: capabilityAction }); throw err; }
    const d = this.policy.decide(capabilityAction);
    if (d.level !== 'allow') { this.audit('denied.policy', { action: capabilityAction, cls: d.cls, level: d.level }); throw new Error(d.reason); }
    if (d.mutating) {
      const t = this.now();
      this._stamps = this._stamps.filter((s) => t - s < 60000);
      if (this._stamps.length >= this.maxMutationsPerMinute) { this.audit('denied.rate_limit', { action: capabilityAction }); throw new Error(`Rate limit: more than ${this.maxMutationsPerMinute} mutating actions in the last minute`); }
      this._stamps.push(t);
      this.audit('allowed', { action: capabilityAction, ...detail });
    }
    return d;
  }
}

module.exports = { RuntimeGuard };
