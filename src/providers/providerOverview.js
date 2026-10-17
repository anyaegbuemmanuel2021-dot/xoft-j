/**
 * providerOverview — safe, secret-free summary of every AI provider for the
 * Command Center. Built from the SAME sources the router already uses
 * (isConfigured(), ModelHealthManager, config model names). It never includes
 * API keys, base URLs or anything from request/response bodies.
 */
export const PROVIDER_META = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'claude', label: 'Claude' },
  { id: 'grok', label: 'Grok' },
  { id: 'ollama', label: 'Ollama' },
  { id: 'experiential', label: 'Experiential Labs' },
  { id: 'freellmapi', label: 'FreeLLMAPI' },
  { id: 'litellm', label: 'LiteLLM' },
];

function modelFor(id, router, config) {
  const p = config.providers;
  switch (id) {
    case 'openai': return p.openai.chatModel;
    case 'gemini': return p.gemini.model;
    case 'claude': return p.claude.model;
    case 'grok': return p.xai.model;
    case 'ollama': return p.ollama.model;
    case 'experiential': {
      try { return router.getModel('experiential') ?? p.experiential.model; } catch { return p.experiential.model; }
    }
    case 'freellmapi': return router.getInstance?.('freellmapi')?.getModel?.() ?? p.freellmapi?.model ?? null;
    case 'litellm': return router.getInstance?.('litellm')?.getModel?.() ?? p.litellm?.model ?? null;
    default: return null;
  }
}

export async function buildProviderOverview({ router, modelHealth, config }) {
  const out = [];
  for (const { id, label } of PROVIDER_META) {
    const instance = router.getInstance?.(id) ?? null;
    const configured = Boolean(instance?.isConfigured?.());
    const stats = modelHealth.getStats(id);
    let reachable = null;
    if (id === 'ollama' && configured && typeof instance.ping === 'function') {
      try { reachable = await instance.ping(); } catch { reachable = false; }
    }
    let status = configured ? stats.status : 'NOT_CONFIGURED';
    // Optional gateways report their richer state (disabled/unconfigured/authentication_error/cooldown…) from the same health data.
    let state = null;
    if ((id === 'freellmapi' || id === 'litellm') && typeof router.gatewayStatus === 'function') {
      const g = router.gatewayStatus(id);
      state = g.state;
      // Map the richer gateway state onto the SAME status vocabulary every consumer (Watchdog, dashboard, missions) already understands.
      status = ({ disabled: 'NOT_CONFIGURED', unconfigured: 'NOT_CONFIGURED', invalid_configuration: 'NOT_CONFIGURED', available: 'AVAILABLE', starting: 'UNKNOWN', authentication_error: 'AUTH_ERROR', rate_limited: 'RATE_LIMITED', timeout: 'TIMEOUT', unhealthy: 'DEGRADED', unavailable: 'UNAVAILABLE', server_error: 'UNAVAILABLE', cooldown: 'UNAVAILABLE' })[g.state] ?? 'UNAVAILABLE';
    }
    if (id === 'ollama' && configured && reachable === false) status = 'UNAVAILABLE';
    out.push({
      id,
      label,
      configured,
      status,
      state,
      model: modelFor(id, router, config),
      avgLatencyMs: stats.avgLatencyMs,
      calls: stats.calls,
      failures: stats.failureCount,
      reachable,
      switchable: id === 'experiential',
    });
  }
  return out;
}
