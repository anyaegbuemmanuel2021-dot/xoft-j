/**
 * Structured AI-provider errors.
 *
 * Xoft treats every AI provider as an optional, replaceable engine. When inference cannot be served the
 * router throws one of these — never a bare crash — so callers/HTTP layers can return a clean, machine-readable
 * status while every non-AI part of Xoft keeps running.
 */

export const AI_ERROR_CODES = {
  NO_AI_PROVIDER_AVAILABLE: 'NO_AI_PROVIDER_AVAILABLE',
  AI_PROVIDERS_FAILED: 'AI_PROVIDERS_FAILED',
  INVALID_PROVIDER_CONFIG: 'INVALID_PROVIDER_CONFIG',
};

/** Base class: something AI-related is unavailable. `success:false` so it can be serialized as-is. */
export class AiUnavailableError extends Error {
  constructor(code, message, { taskType = null, tried = [], attempts = [] } = {}) {
    super(message);
    this.name = 'AiUnavailableError';
    this.success = false;
    this.code = code;
    this.taskType = taskType;
    this.tried = tried; // provider names considered
    this.attempts = attempts; // [{provider, errorType, message}] for providers actually called
  }

  /** The clean structured shape returned to API clients / the UI. No secrets, no upstream bodies. */
  toResponse() {
    return {
      success: false,
      error: this.code,
      message: this.code === AI_ERROR_CODES.NO_AI_PROVIDER_AVAILABLE
        ? 'No AI provider is currently configured or available.'
        : this.code === AI_ERROR_CODES.INVALID_PROVIDER_CONFIG
          ? 'The AI provider routing configuration is invalid.'
          : 'Every configured AI provider failed to answer this request.',
      taskType: this.taskType,
      tried: this.tried,
      attempts: this.attempts.map((a) => ({ provider: a.provider, errorType: a.errorType })),
    };
  }
}

export class NoAiProviderError extends AiUnavailableError {
  constructor(message, opts) { super(AI_ERROR_CODES.NO_AI_PROVIDER_AVAILABLE, message, opts); this.name = 'NoAiProviderError'; }
}

export class ProviderRoutingConfigError extends AiUnavailableError {
  constructor(message, opts) { super(AI_ERROR_CODES.INVALID_PROVIDER_CONFIG, message, opts); this.name = 'ProviderRoutingConfigError'; }
}

/**
 * Every provider that was tried failed. If ALL failures were "could not reach it at all", the honest description is
 * "no AI provider is available" (NO_AI_PROVIDER_AVAILABLE); a mix that includes real upstream errors is AI_PROVIDERS_FAILED.
 */
export class AllProvidersFailedError extends AiUnavailableError {
  constructor(message, opts) {
    const attempts = opts?.attempts ?? [];
    const allUnreachable = attempts.length > 0 && attempts.every((a) => a.errorType === 'unavailable');
    super(allUnreachable ? AI_ERROR_CODES.NO_AI_PROVIDER_AVAILABLE : AI_ERROR_CODES.AI_PROVIDERS_FAILED, message, opts);
    this.name = 'AllProvidersFailedError';
  }
}

/**
 * Error thrown by gateway providers. `errorType` drives ModelHealthManager and the router's cooldown logic:
 * rate_limit | auth | timeout | server_error | unavailable | invalid_request | unknown
 */
export class ProviderError extends Error {
  constructor(message, { errorType = 'unknown', status = null, provider = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.errorType = errorType;
    this.status = status;
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Classifies any thrown value into a health-manager errorType. Typed errors win; plain Errors from the older providers keep the
 * message-regex behaviour ProviderRouter has always used (so existing providers are classified exactly as before).
 */
export function classifyProviderError(err) {
  if (err?.errorType) return err.errorType;
  const m = String(err?.message ?? '');
  if (/rate.?limit|429/i.test(m)) return 'rate_limit';
  if (/timeout|ETIMEDOUT/i.test(m)) return 'timeout';
  if (/401|403|auth/i.test(m)) return 'auth';
  return 'unknown';
}

/** Maps an AI error to an HTTP status + JSON body for API handlers. Returns null for non-AI errors. */
export function aiErrorToHttp(err) {
  if (!(err instanceof AiUnavailableError)) return null;
  const status = err.code === AI_ERROR_CODES.NO_AI_PROVIDER_AVAILABLE ? 503 : err.code === AI_ERROR_CODES.INVALID_PROVIDER_CONFIG ? 500 : 502;
  return { status, body: err.toResponse() };
}
