/**
 * providerState — one place that turns "config state + passive health + last active probe" into the single
 * lowercase state the UI/diagnostics show for an optional provider:
 *
 *   disabled | unconfigured | invalid_configuration | starting | available | unavailable | unhealthy
 *   | rate_limited | authentication_error | timeout | server_error | cooldown
 *
 * It is derived from the SAME ModelHealthManager data the router uses (no second, drifting state machine).
 * Pure function: no I/O, never throws.
 */
export const PROVIDER_STATES = ['disabled', 'unconfigured', 'invalid_configuration', 'starting', 'available', 'unavailable', 'unhealthy', 'rate_limited', 'authentication_error', 'timeout', 'server_error', 'cooldown'];

const REASON_TO_STATE = { rate_limit: 'rate_limited', auth: 'authentication_error', timeout: 'timeout', server_error: 'server_error', unavailable: 'unavailable' };
const PROBE_TO_STATE = { CONNECTED: 'available', AUTHENTICATION_ERROR: 'authentication_error', TIMEOUT: 'timeout', SERVER_ERROR: 'server_error', UNAVAILABLE: 'unavailable', INVALID_CONFIGURATION: 'invalid_configuration', NOT_CONFIGURED: 'unconfigured' };
const PROBE_FRESH_MS = 5 * 60 * 1000;

/**
 * @param {object} i
 * @param {{state:string, configured:boolean, issue?:string|null}} i.config   from gatewayConfigState()
 * @param {object} [i.health]      { calls, status, healthy, ... } from ModelHealthManager.getStats()
 * @param {{until:number, reason:string, hard:boolean}|null} [i.cooldown]    from ModelHealthManager.getCooldown()
 * @param {{result:string, at:number}|null} [i.probe]  last active connection test (from provider.lastProbe)
 * @param {number} [i.now]
 */
export function deriveProviderState({ config, health = null, cooldown = null, probe = null, now = Date.now() }) {
  const base = { state: 'starting', configured: Boolean(config?.configured), issue: config?.issue ?? null, degraded: false, cooldownUntil: null, lastProbe: probe ? { result: probe.result, at: new Date(probe.at).toISOString() } : null };
  if (!config || config.state === 'disabled') return { ...base, state: 'disabled', configured: false };
  if (config.state === 'invalid_configuration') return { ...base, state: 'invalid_configuration' };
  if (config.state === 'unconfigured') return { ...base, state: 'unconfigured' };

  if (cooldown && cooldown.until > now) {
    return { ...base, state: REASON_TO_STATE[cooldown.reason] ?? 'cooldown', cooldownUntil: new Date(cooldown.until).toISOString() };
  }
  const freshProbe = probe && now - probe.at < PROBE_FRESH_MS ? probe : null;
  const calls = health?.calls ?? 0;
  if (calls > 0) {
    // Real traffic beats an older probe. A DEGRADED window with >=2 recent failures is "unhealthy"; one blip is still available.
    if (health.status === 'DEGRADED') return { ...base, state: (health.failureCount ?? 0) >= 2 && calls <= 5 ? 'unhealthy' : 'available', degraded: true };
    if (health.status === 'AVAILABLE') return { ...base, state: 'available' };
    if (health.status && health.status !== 'UNKNOWN') return { ...base, state: 'cooldown' };
  }
  if (freshProbe) return { ...base, state: PROBE_TO_STATE[freshProbe.result] ?? 'unavailable' };
  return base; // configured but nothing observed yet
}
