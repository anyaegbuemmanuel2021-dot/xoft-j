const UNHEALTHY_COOLDOWN_MS = 60_000;
const WINDOW_SIZE = 5; // recent-call window used to judge health

// Rough, approximate USD-per-1K-token pricing for cost ESTIMATION only — not
// authoritative billing data. Update if a provider's pricing changes;
// getStats() clearly labels this as an estimate.
const PRICING = {
  openai: { input: 0.005, output: 0.015 },
  openaiFast: { input: 0.00015, output: 0.0006 },
  claude: { input: 0.003, output: 0.015 },
  gemini: { input: 0.000075, output: 0.0003 },
  grok: { input: 0.003, output: 0.015 },
  // freellmapi / litellm are intentionally absent: the cost is whatever the operator's gateway config makes it (often $0), so it is not estimated here.
};

/**
 * ModelHealthManager — spec section 9. In-memory (resets on restart, same
 * tradeoff as ActivityLog would make if it buffered — health is inherently
 * about "right now," not history) tracking of provider latency/errors/
 * tokens, used by ProviderRouter to order fallback: healthy configured
 * providers first, unhealthy ones only as a last resort, never skipped
 * entirely (degraded beats dead).
 */
export class ModelHealthManager {
  constructor() {
    /** @type {Map<string, object>} */
    this._stats = new Map();
  }

  _get(providerName) {
    if (!this._stats.has(providerName)) {
      this._stats.set(providerName, {
        recent: [], // last WINDOW_SIZE {ok, ts, errorType?}
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalLatencyMs: 0,
        successCount: 0,
        failureCount: 0,
        unhealthyUntil: 0,
      });
    }
    return this._stats.get(providerName);
  }

  recordSuccess(providerName, { latencyMs, inputTokens = 0, outputTokens = 0 } = {}) {
    const s = this._get(providerName);
    s.recent.push({ ok: true, ts: Date.now() });
    if (s.recent.length > WINDOW_SIZE) s.recent.shift();
    s.totalLatencyMs += latencyMs ?? 0;
    s.totalInputTokens += inputTokens;
    s.totalOutputTokens += outputTokens;
    s.successCount += 1;
  }

  /**
   * @param {object} [o]
   * @param {string} [o.errorType]
   * @param {number} [o.hardCooldownMs] OPT-IN: park this provider for this long immediately (no need for 3 strikes) and mark it
   *   "hard cooling" so ProviderRouter will not retry it while any other candidate can answer. Used for optional gateways, where
   *   retrying an offline server or a rejected API key on every request would just add latency. Older providers never pass it, so
   *   their behaviour is unchanged.
   */
  recordFailure(providerName, { errorType = 'unknown', hardCooldownMs = 0 } = {}) {
    const s = this._get(providerName);
    s.recent.push({ ok: false, ts: Date.now(), errorType });
    if (s.recent.length > WINDOW_SIZE) s.recent.shift();
    s.failureCount += 1;
    s.lastErrorType = errorType;
    const recentFailures = s.recent.filter((r) => !r.ok).length;
    if (recentFailures >= 3) {
      s.unhealthyUntil = Math.max(s.unhealthyUntil, Date.now() + UNHEALTHY_COOLDOWN_MS);
    }
    if (hardCooldownMs > 0) {
      const until = Date.now() + hardCooldownMs;
      s.unhealthyUntil = Math.max(s.unhealthyUntil, until);
      s.hardUntil = Math.max(s.hardUntil ?? 0, until);
      s.cooldownReason = errorType;
    }
  }

  /** True while a provider is parked by an explicit hard cooldown (see recordFailure). */
  isHardCooling(providerName) {
    const s = this._stats.get(providerName);
    return Boolean(s?.hardUntil && Date.now() < s.hardUntil);
  }

  /** { until:number, reason:string } while cooling down (soft or hard), else null. Timestamps only — no secrets. */
  getCooldown(providerName) {
    const s = this._stats.get(providerName);
    if (!s || Date.now() >= s.unhealthyUntil) return null;
    return { until: s.unhealthyUntil, reason: s.hardUntil && Date.now() < s.hardUntil ? (s.cooldownReason ?? s.lastErrorType ?? 'unknown') : (s.lastErrorType ?? 'unknown'), hard: this.isHardCooling(providerName) };
  }

  /** Forget a provider's history (used when its configuration changes: a new key/URL deserves a fresh start). */
  reset(providerName) { this._stats.delete(providerName); }

  isHealthy(providerName) {
    const s = this._stats.get(providerName);
    if (!s) return true; // no data yet — assume healthy until it proves otherwise
    return Date.now() >= s.unhealthyUntil;
  }

  /**
   * A single named status per provider (spec: AVAILABLE/DEGRADED/
   * UNAVAILABLE/RATE_LIMITED/AUTH_ERROR/TIMEOUT/UNKNOWN), derived from the
   * same tracked data isHealthy()/getStats() already use — not a separate,
   * independently-drifting state machine.
   */
  getStatus(providerName) {
    const s = this._stats.get(providerName);
    if (!s || s.recent.length === 0) return 'UNKNOWN';
    if (!this.isHealthy(providerName)) {
      switch (s.lastErrorType) {
        case 'rate_limit': return 'RATE_LIMITED';
        case 'auth': return 'AUTH_ERROR';
        case 'timeout': return 'TIMEOUT';
        default: return 'UNAVAILABLE';
      }
    }
    const recentFailures = s.recent.filter((r) => !r.ok).length;
    return recentFailures > 0 ? 'DEGRADED' : 'AVAILABLE';
  }

  getStats(providerName) {
    const s = this._stats.get(providerName);
    if (!s) return { calls: 0, successCount: 0, failureCount: 0, avgLatencyMs: null, estimatedCostUSD: 0, healthy: true, status: 'UNKNOWN' };
    const pricing = PRICING[providerName] ?? { input: 0, output: 0 };
    const estimatedCostUSD = (s.totalInputTokens / 1000) * pricing.input + (s.totalOutputTokens / 1000) * pricing.output;
    return {
      calls: s.successCount + s.failureCount,
      successCount: s.successCount,
      failureCount: s.failureCount,
      avgLatencyMs: s.successCount ? Math.round(s.totalLatencyMs / s.successCount) : null,
      totalInputTokens: s.totalInputTokens,
      totalOutputTokens: s.totalOutputTokens,
      estimatedCostUSD: Number(estimatedCostUSD.toFixed(4)),
      healthy: this.isHealthy(providerName),
      status: this.getStatus(providerName),
    };
  }

  snapshot() {
    const out = {};
    for (const name of this._stats.keys()) out[name] = this.getStats(name);
    return out;
  }
}
