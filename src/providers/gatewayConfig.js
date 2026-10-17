/**
 * Pure helpers for the optional OpenAI-compatible gateways (FreeLLMAPI, LiteLLM).
 * No imports from config/ (config imports THIS module), and nothing here ever throws on bad input:
 * a missing or malformed setting is a provider-level *state*, never an application-level fatal error.
 */

export const GATEWAY_IDS = ['freellmapi', 'litellm'];

export const GATEWAY_DEFAULTS = {
  freellmapi: { baseUrl: 'http://localhost:3001/v1', model: 'auto', requiresKey: true, label: 'FreeLLMAPI' },
  litellm: { baseUrl: 'http://localhost:4000/v1', model: '', requiresKey: false, label: 'LiteLLM' },
};

export const envBool = (v, dflt = false) => (v === undefined || v === null || v === '' ? dflt : ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase()));
export const envNum = (v, dflt, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : dflt; };

/** Builds a gateway config block from an env-like object. Never throws. */
export function gatewayConfigFromEnv(id, env = process.env) {
  const P = id.toUpperCase();
  const d = GATEWAY_DEFAULTS[id];
  return {
    enabled: envBool(env[`${P}_ENABLED`], false),
    baseUrl: (env[`${P}_BASE_URL`] || d.baseUrl).trim(),
    apiKey: (env[`${P}_API_KEY`] || '').trim() || null,
    model: (env[`${P}_MODEL`] ?? d.model).trim(),
    embeddingModel: (env[`${P}_EMBEDDING_MODEL`] || '').trim() || null,
    timeoutMs: envNum(env[`${P}_TIMEOUT_MS`], 60000, { min: 1000, max: 600000 }),
    vision: envBool(env[`${P}_VISION`], false), // opt-in: the operator asserts the configured model accepts images
    tools: envBool(env[`${P}_TOOLS`], true),
  };
}

/** Validates + normalizes a base URL. Returns { ok, url } or { ok:false, reason }. http/https only, no embedded credentials. */
export function normalizeBaseUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { return { ok: false, reason: 'not a valid URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'only http and https URLs are allowed' };
  if (u.username || u.password) return { ok: false, reason: 'credentials must not be embedded in the URL (use the API key field)' };
  u.hash = ''; u.search = '';
  return { ok: true, url: u.toString().replace(/\/+$/, '') };
}

/**
 * The configuration-level state of a gateway (independent of runtime health):
 *  disabled | unconfigured (enabled but missing something required) | invalid_configuration | configured
 */
export function gatewayConfigState(id, cfg) {
  if (!cfg?.enabled) return { state: 'disabled', configured: false, issue: null };
  const url = normalizeBaseUrl(cfg.baseUrl);
  if (!url.ok) return { state: 'invalid_configuration', configured: false, issue: `Base URL ${url.reason}` };
  if (GATEWAY_DEFAULTS[id].requiresKey && !cfg.apiKey) return { state: 'unconfigured', configured: false, issue: `${GATEWAY_DEFAULTS[id].label} needs an API key (${id.toUpperCase()}_API_KEY)` };
  return { state: 'configured', configured: true, issue: null, baseUrl: url.url };
}

/** sk-************abcd — never reveals more than 3 leading and 4 trailing characters, and nothing at all for short keys. */
export function maskKey(key) {
  if (!key) return null;
  const k = String(key);
  if (k.length < 12) return '*'.repeat(Math.max(k.length, 8));
  return `${k.slice(0, 3)}${'*'.repeat(Math.min(12, k.length - 7))}${k.slice(-4)}`;
}

/** Removes any occurrence of the given secrets from text (error messages, logs, diagnostics). */
export function redactSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) if (s && String(s).length >= 6) out = out.split(String(s)).join('[REDACTED]');
  return out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]');
}
