/**
 * Hermes engine settings: defaults, env parsing, validation, merging, and a secret-free public view.
 * Precedence (lowest → highest): built-in defaults < environment (HERMES_*) < settings saved from the UI/API.
 * The API key is NEVER part of saved settings — it comes from HERMES_API_KEY or the managed-runtime key file.
 */
import { normalizeProfile, PROFILES } from '../EnginePermissions.js';

export const NATIVE_TOOL_POLICIES = Object.freeze(['enforce', 'monitor', 'off']);
export const WORKSPACE_MODES = Object.freeze(['in-place', 'worktree', 'branch']);
export const LOG_LEVELS = Object.freeze(['error', 'warn', 'info', 'debug']);

export const HERMES_DEFAULTS = Object.freeze({
  enabled: true,
  autoStart: false, // never spawns a process unless asked to
  baseUrl: 'http://127.0.0.1:8642',
  runtimePath: '', // blank = look up `hermes` on PATH / known install locations
  hermesHome: '',
  workingDirectory: '',
  allowedRoots: [],
  defaultAutonomy: 2,
  permissionProfile: 'standard',
  maxConcurrentTasks: 2,
  timeoutMs: 60 * 60 * 1000,
  maxToolCalls: 500,
  maxRetries: 2,
  maxMemoryMb: 0, // 0 = no limit (enforced on a Xoft-managed process where RSS is readable: Linux/macOS)
  lowPriority: true, // run a Xoft-managed Hermes at reduced OS scheduling priority
  bridgeApprovalWaitMs: 100000, // how long a Tool Gateway call waits for a human approval before telling the model to retry
  nativeToolPolicy: 'monitor',
  workspaceMode: 'in-place',
  bridgeEnabled: true,
  bridgeDeviceId: '',
  logLevel: 'info',
  model: '',
  provider: '',
  environment: {}, // extra env vars passed to a Xoft-managed Hermes process (allowlisted names only)
});

const bool = (v, d) => (v === undefined || v === null || v === '' ? d : String(v).toLowerCase() === 'true');
const int = (v, d, min, max) => {
  if (v === undefined || v === null || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,;]/)).map((s) => String(s).trim()).filter(Boolean);

/** Reads HERMES_* variables. Unset variables are simply absent from the result. */
export function hermesSettingsFromEnv(env = process.env) {
  const out = {};
  const set = (k, v) => { if (v !== undefined) out[k] = v; };
  const has = (n) => env[n] !== undefined && env[n] !== '';
  if (has('HERMES_ENABLED')) set('enabled', bool(env.HERMES_ENABLED, true));
  if (has('HERMES_AUTO_START')) set('autoStart', bool(env.HERMES_AUTO_START, false));
  if (has('HERMES_API_URL')) set('baseUrl', env.HERMES_API_URL);
  if (has('HERMES_COMMAND')) set('runtimePath', env.HERMES_COMMAND);
  if (has('HERMES_HOME')) set('hermesHome', env.HERMES_HOME);
  if (has('HERMES_WORKING_DIRECTORY')) set('workingDirectory', env.HERMES_WORKING_DIRECTORY);
  if (has('HERMES_ALLOWED_ROOTS')) set('allowedRoots', list(env.HERMES_ALLOWED_ROOTS));
  if (has('HERMES_DEFAULT_AUTONOMY')) set('defaultAutonomy', int(env.HERMES_DEFAULT_AUTONOMY, 2, 0, 5));
  if (has('HERMES_PERMISSION_PROFILE')) set('permissionProfile', env.HERMES_PERMISSION_PROFILE);
  if (has('HERMES_MAX_CONCURRENT_TASKS')) set('maxConcurrentTasks', int(env.HERMES_MAX_CONCURRENT_TASKS, 2, 1, 32));
  if (has('HERMES_TASK_TIMEOUT_MS')) set('timeoutMs', int(env.HERMES_TASK_TIMEOUT_MS, HERMES_DEFAULTS.timeoutMs, 10_000, 7 * 24 * 3600 * 1000));
  if (has('HERMES_MAX_TOOL_CALLS')) set('maxToolCalls', int(env.HERMES_MAX_TOOL_CALLS, 500, 0, 100_000));
  if (has('HERMES_MAX_RETRIES')) set('maxRetries', int(env.HERMES_MAX_RETRIES, 2, 0, 10));
  if (has('HERMES_MAX_MEMORY_MB')) set('maxMemoryMb', int(env.HERMES_MAX_MEMORY_MB, 0, 0, 1_048_576));
  if (has('HERMES_NATIVE_TOOL_POLICY')) set('nativeToolPolicy', env.HERMES_NATIVE_TOOL_POLICY);
  if (has('HERMES_WORKSPACE_MODE')) set('workspaceMode', env.HERMES_WORKSPACE_MODE);
  if (has('HERMES_LOW_PRIORITY')) set('lowPriority', bool(env.HERMES_LOW_PRIORITY, true));
  if (has('HERMES_BRIDGE_APPROVAL_WAIT_MS')) set('bridgeApprovalWaitMs', int(env.HERMES_BRIDGE_APPROVAL_WAIT_MS, 100000, 1000, 600000));
  if (has('HERMES_BRIDGE_ENABLED')) set('bridgeEnabled', bool(env.HERMES_BRIDGE_ENABLED, true));
  if (has('HERMES_BRIDGE_DEVICE_ID')) set('bridgeDeviceId', env.HERMES_BRIDGE_DEVICE_ID);
  if (has('HERMES_LOG_LEVEL')) set('logLevel', env.HERMES_LOG_LEVEL);
  if (has('HERMES_MODEL')) set('model', env.HERMES_MODEL);
  if (has('HERMES_PROVIDER')) set('provider', env.HERMES_PROVIDER);
  return out;
}

/** Variable names a Xoft-managed Hermes process may receive from `settings.environment` (no Xoft secrets, no arbitrary names). */
export const MANAGED_ENV_ALLOWLIST = /^(HERMES_[A-Z0-9_]+|API_SERVER_(CORS_ORIGINS|MODEL_NAME)|TERMINAL_[A-Z0-9_]+|HTTPS?_PROXY|NO_PROXY|LANG|LC_[A-Z_]+|TZ)$/;

/**
 * Validates and normalises a (partial) settings object. Throws Error with a precise message on bad input so the API can
 * answer 400 instead of silently storing nonsense. Unknown keys are rejected ("only expose settings that are supported").
 */
export function validateHermesSettings(input, { strictKeys = true } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!(key in HERMES_DEFAULTS)) {
      if (strictKeys) throw new Error(`Unknown Hermes setting '${key}'. Supported: ${Object.keys(HERMES_DEFAULTS).join(', ')}`);
      continue;
    }
    switch (key) {
      case 'enabled': case 'autoStart': case 'bridgeEnabled': case 'lowPriority':
        if (typeof value !== 'boolean') throw new Error(`${key} must be true or false`);
        out[key] = value; break;
      case 'baseUrl': {
        let u;
        try { u = new URL(String(value)); } catch { throw new Error('baseUrl must be a valid http(s) URL'); }
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error('baseUrl must be http or https');
        out.baseUrl = u.origin + u.pathname.replace(/\/+$/, ''); break;
      }
      case 'runtimePath': case 'hermesHome': case 'workingDirectory': case 'bridgeDeviceId': case 'model': case 'provider':
        if (typeof value !== 'string') throw new Error(`${key} must be a string`);
        if (/[\0\r\n]/.test(value)) throw new Error(`${key} contains illegal characters`);
        out[key] = value.trim(); break;
      case 'allowedRoots':
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || /[\0\r\n]/.test(v))) throw new Error('allowedRoots must be an array of path strings');
        out.allowedRoots = value.map((v) => v.trim()).filter(Boolean); break;
      case 'defaultAutonomy':
        if (!Number.isInteger(value) || value < 0 || value > 5) throw new Error('defaultAutonomy must be an integer from 0 to 5');
        out.defaultAutonomy = value; break;
      case 'permissionProfile':
        normalizeProfile(value); // throws with a clear message if invalid
        out.permissionProfile = value; break;
      case 'maxConcurrentTasks': out[key] = checkInt(key, value, 1, 32); break;
      case 'timeoutMs': out[key] = checkInt(key, value, 10_000, 7 * 24 * 3600 * 1000); break;
      case 'maxToolCalls': out[key] = checkInt(key, value, 0, 100_000); break;
      case 'maxRetries': out[key] = checkInt(key, value, 0, 10); break;
      case 'bridgeApprovalWaitMs': out[key] = checkInt(key, value, 1000, 600_000); break;
      case 'maxMemoryMb': out[key] = checkInt(key, value, 0, 1_048_576); break;
      case 'nativeToolPolicy':
        if (!NATIVE_TOOL_POLICIES.includes(value)) throw new Error(`nativeToolPolicy must be one of: ${NATIVE_TOOL_POLICIES.join(', ')}`);
        out[key] = value; break;
      case 'workspaceMode':
        if (!WORKSPACE_MODES.includes(value)) throw new Error(`workspaceMode must be one of: ${WORKSPACE_MODES.join(', ')}`);
        out[key] = value; break;
      case 'logLevel':
        if (!LOG_LEVELS.includes(value)) throw new Error(`logLevel must be one of: ${LOG_LEVELS.join(', ')}`);
        out[key] = value; break;
      case 'environment': {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('environment must be an object of NAME: value strings');
        const env = {};
        for (const [name, v] of Object.entries(value)) {
          if (!MANAGED_ENV_ALLOWLIST.test(name)) throw new Error(`environment variable '${name}' is not allowed (allowed: HERMES_*, TERMINAL_*, proxy and locale variables)`);
          if (typeof v !== 'string') throw new Error(`environment variable '${name}' must be a string`);
          env[name] = v;
        }
        out.environment = env; break;
      }
      default: out[key] = value;
    }
  }
  return out;
}

function checkInt(key, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
  return value;
}

/**
 * Resolved settings = defaults ⊕ env ⊕ saved. Every value is validated on its own: a bad value (e.g. a typo in an env var)
 * is ignored and the default is kept, so one wrong variable can never stop Xoft from starting.
 */
export function resolveHermesSettings({ env = process.env, saved = {} } = {}) {
  const merged = { ...hermesSettingsFromEnv(env), ...saved };
  const good = {};
  for (const [k, v] of Object.entries(merged)) {
    if (!(k in HERMES_DEFAULTS)) continue;
    try { Object.assign(good, validateHermesSettings({ [k]: v })); } catch { /* invalid → keep the default */ }
  }
  return { ...HERMES_DEFAULTS, ...good };
}

/** Settings safe to show in the UI / API: no secrets exist in here by construction, but `environment` values are masked. */
export function publicHermesSettings(settings) {
  return { ...settings, environment: Object.fromEntries(Object.keys(settings.environment ?? {}).map((k) => [k, '[set]'])), permissionProfileResolved: normalizeProfile(settings.permissionProfile) };
}

export { PROFILES };
