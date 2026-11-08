import { EngineError, ErrorCode, ENGINE_AUTONOMY_LABELS } from './constants.js';
import { PERMISSION_SCHEMA, PROFILES, PROFILE_DESCRIPTIONS, permissionNames } from './EnginePermissions.js';

const STATUS_BY_CODE = {
  [ErrorCode.INVALID]: 400, [ErrorCode.NOT_FOUND]: 404, [ErrorCode.POLICY_DENIED]: 403, [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.UNAVAILABLE]: 503, [ErrorCode.DISABLED]: 409, [ErrorCode.NOT_SUPPORTED]: 409, [ErrorCode.TIMEOUT]: 504, [ErrorCode.RATE_LIMITED]: 429,
};

/** Converts any thrown error into `{status, body}` — EngineErrors keep their code, plain Errors (e.g. validation) become 400. */
export function errorResponse(err) {
  if (err instanceof EngineError) return { status: STATUS_BY_CODE[err.code] ?? 500, body: { error: err.message, code: err.code, ...(err.details?.candidates ? { candidates: err.details.candidates.map(({ engineId, reasons }) => ({ engineId, reasons })) } : {}) } };
  return { status: 400, body: { error: err?.message ?? 'bad request' } };
}

const guard = (fn) => async (req) => { try { return await fn(req); } catch (err) { return errorResponse(err); } };

/**
 * Transport-independent engine API. Each handler takes `{ params, query, body, baseUrl }` and returns `{ status, body }`,
 * which keeps the logic unit-testable without an HTTP server (the Express glue below is intentionally thin).
 */
export function createEngineApi({ registry, router, manager, hermes = null, gateway = null }) {
  const hermesOr409 = () => { if (!hermes) throw new EngineError(ErrorCode.NOT_FOUND, 'Hermes engine is not registered'); return hermes; };
  return {
    listEngines: guard(async ({ query }) => {
      if (query?.refresh === 'true') await registry.refreshAll();
      return { status: 200, body: { engines: registry.list(), queue: manager.queueStatus() } };
    }),

    getEngine: guard(async ({ params, query }) => {
      const engine = registry.get(params.id);
      if (query?.refresh === 'true') await registry.refresh(engine.id);
      return { status: 200, body: { ...engine.describe(), health: registry.health(engine.id) } };
    }),

    refresh: guard(async ({ body }) => {
      if (body?.engine) await registry.refresh(body.engine); else await registry.refreshAll();
      return { status: 200, body: { engines: registry.list() } };
    }),

    /** Dry run: what would the router do with this goal? Executes nothing. */
    routePreview: guard(async ({ body }) => {
      if (!body?.goal || typeof body.goal !== 'string') throw new EngineError(ErrorCode.INVALID, 'goal is required');
      const analysis = router.analyze({ goal: body.goal, workingDirectory: body.workingDirectory ?? null });
      try {
        const d = await router.route(analysis, { preferredEngine: body.engine && body.engine !== 'auto' ? body.engine : null, allowFallback: body.allowFallback !== false, refresh: body.refresh === true });
        return { status: 200, body: { analysis, engine: d.engineId, chain: d.chain, fallbackFrom: d.fallbackFrom, reason: d.reason, candidates: d.candidates.map(({ engineId, serveable, level, score, reasons }) => ({ engineId, serveable, level, score, reasons })) } };
      } catch (err) {
        if (err instanceof EngineError && err.code === ErrorCode.UNAVAILABLE) return { status: 200, body: { analysis, engine: null, chain: [], reason: err.message, candidates: (err.details?.candidates ?? []).map(({ engineId, serveable, level, reasons }) => ({ engineId, serveable, level, reasons })) } };
        throw err;
      }
    }),

    permissions: guard(async () => ({ status: 200, body: { schema: PERMISSION_SCHEMA, permissions: permissionNames(), profiles: PROFILES, descriptions: PROFILE_DESCRIPTIONS, autonomy: ENGINE_AUTONOMY_LABELS } })),

    // ---- Hermes --------------------------------------------------------------------------------------------
    hermesSettings: guard(async () => ({ status: 200, body: { settings: hermesOr409().getSettings(), apiKey: hermesOr409().describe().apiKey } })),
    hermesUpdateSettings: guard(async ({ body }) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new EngineError(ErrorCode.INVALID, 'settings object required');
      if ('apiKey' in body || 'api_key' in body) throw new EngineError(ErrorCode.INVALID, 'The API key is not a setting. Set HERMES_API_KEY in the environment.');
      const settings = await hermesOr409().updateSettings(body);
      await registry.refresh('hermes');
      return { status: 200, body: { settings } };
    }),
    hermesEnvironment: guard(async () => ({ status: 200, body: await hermesOr409().environment() })),
    hermesInstall: guard(async () => ({ status: 200, body: hermesOr409().installGuidance() })),
    hermesStart: guard(async () => { const r = await hermesOr409().start(); await registry.refresh('hermes'); return { status: 200, body: r }; }),
    hermesStop: guard(async () => { const r = await hermesOr409().stop(); await registry.refresh('hermes'); return { status: 200, body: r }; }),
    hermesLogs: guard(async ({ query }) => ({ status: 200, body: { process: hermesOr409().processStatus(), lines: hermesOr409().logs(Math.min(Number(query?.lines) || 100, 400)) } })),
    hermesBridge: guard(async ({ baseUrl }) => ({ status: 200, body: hermesOr409().bridgeInfo({ baseUrl }) })),
    hermesBridgeApply: guard(async ({ baseUrl }) => ({ status: 200, body: hermesOr409().applyBridge({ baseUrl }) })),
    hermesBridgeRotate: guard(async () => {
      if (!gateway) throw new EngineError(ErrorCode.NOT_SUPPORTED, 'Tool Gateway is not available');
      gateway.rotateToken();
      return { status: 200, body: { rotated: true, note: 'Update XOFT_TOOL_TOKEN in Hermes (or restart a Xoft-managed Hermes) — the old token no longer works.' } };
    }),

    // ---- tasks -------------------------------------------------------------------------------------------
    listTasks: guard(async ({ query }) => ({ status: 200, body: { tasks: manager.list({ state: query?.state ? String(query.state).split(',') : undefined, engine: query?.engine || undefined, limit: Math.min(Number(query?.limit) || 100, 500) }), queue: manager.queueStatus() } })),
    createTask: guard(async ({ body }) => {
      const task = await manager.createTask(body ?? {}, { createdBy: 'api' });
      return { status: 202, body: { task } };
    }),
    getTask: guard(async ({ params }) => { const t = manager.get(params.id); if (!t) throw new EngineError(ErrorCode.NOT_FOUND, `No engine task '${params.id}'`); return { status: 200, body: { task: t } }; }),
    taskEvents: guard(async ({ params, query }) => {
      if (!manager.get(params.id)) throw new EngineError(ErrorCode.NOT_FOUND, `No engine task '${params.id}'`);
      return { status: 200, body: { events: manager.events(params.id, { after: Number(query?.after) || 0, limit: Math.min(Number(query?.limit) || 500, 2000), types: query?.types ? String(query.types).split(',') : null }) } };
    }),
    taskReport: guard(async ({ params }) => { const r = manager.report(params.id); if (!r) throw new EngineError(ErrorCode.NOT_FOUND, `No engine task '${params.id}'`); return { status: 200, body: r }; }),
    cancelTask: guard(async ({ params, body }) => ({ status: 200, body: { task: await manager.cancel(params.id, { reason: body?.reason ?? 'cancelled by user' }) } })),
    pauseTask: guard(async ({ params, body }) => ({ status: 200, body: { task: await manager.pause(params.id, { reason: body?.reason ?? 'paused by user' }) } })),
    resumeTask: guard(async ({ params }) => ({ status: 200, body: { task: await manager.resume(params.id) } })),
    rollbackTask: guard(async ({ params }) => ({ status: 200, body: await manager.rollback(params.id) })),
    decideTaskApproval: guard(async ({ params, body }) => ({ status: 200, body: await manager.decideApproval({ approvalId: params.approvalId, decision: body?.decision, decidedBy: 'api', patchRecord: true }) })),
  };
}

/**
 * Registers the engine routes on an Express-style app. `guards` are middleware (e.g. requireAdmin). Kept thin so the
 * behaviour lives in createEngineApi() where it can be tested without a server.
 */
export function registerEngineRoutes(app, api, { requireAdmin = (_q, _s, next) => next(), baseUrlFor = () => null } = {}) {
  const wrap = (handler) => async (req, res) => {
    const out = await handler({ params: req.params, query: req.query, body: req.body, baseUrl: baseUrlFor(req) });
    res.status(out.status).json(out.body);
  };
  const admin = requireAdmin;
  // Order matters: literal /hermes/* paths before the /:id catch-all.
  app.get('/api/engines', wrap(api.listEngines));
  app.post('/api/engines/refresh', wrap(api.refresh));
  app.post('/api/engines/route', wrap(api.routePreview));
  app.get('/api/engines/permissions', wrap(api.permissions));
  app.get('/api/engines/hermes/settings', admin, wrap(api.hermesSettings));
  app.put('/api/engines/hermes/settings', admin, wrap(api.hermesUpdateSettings));
  app.get('/api/engines/hermes/environment', admin, wrap(api.hermesEnvironment));
  app.get('/api/engines/hermes/install', wrap(api.hermesInstall));
  app.post('/api/engines/hermes/start', admin, wrap(api.hermesStart));
  app.post('/api/engines/hermes/stop', admin, wrap(api.hermesStop));
  app.get('/api/engines/hermes/logs', admin, wrap(api.hermesLogs));
  app.get('/api/engines/hermes/bridge', admin, wrap(api.hermesBridge));
  app.post('/api/engines/hermes/bridge/apply', admin, wrap(api.hermesBridgeApply));
  app.post('/api/engines/hermes/bridge/rotate-token', admin, wrap(api.hermesBridgeRotate));
  app.get('/api/engines/:id', wrap(api.getEngine));

  app.get('/api/engine-tasks', wrap(api.listTasks));
  app.post('/api/engine-tasks', admin, wrap(api.createTask));
  app.get('/api/engine-tasks/:id', wrap(api.getTask));
  app.get('/api/engine-tasks/:id/events', wrap(api.taskEvents));
  app.get('/api/engine-tasks/:id/report', wrap(api.taskReport));
  app.post('/api/engine-tasks/:id/cancel', admin, wrap(api.cancelTask));
  app.post('/api/engine-tasks/:id/pause', admin, wrap(api.pauseTask));
  app.post('/api/engine-tasks/:id/resume', admin, wrap(api.resumeTask));
  app.post('/api/engine-tasks/:id/rollback', admin, wrap(api.rollbackTask));
  app.post('/api/engine-tasks/:id/approvals/:approvalId', admin, wrap(api.decideTaskApproval));
}

/** Mounts the MCP Tool Gateway. Must be registered BEFORE the /api auth middleware path logic doesn't apply (it uses its own bearer token). */
export function registerToolGatewayRoute(app, gateway) {
  app.all('/engine-bridge/mcp', async (req, res) => {
    const out = await gateway.handleHttp({ method: req.method, headers: req.headers, body: req.body, remoteAddress: req.socket?.remoteAddress });
    for (const [k, v] of Object.entries(out.headers ?? {})) res.set(k, v);
    if (out.body === undefined) return res.status(out.status).end();
    return res.status(out.status).json(out.body);
  });
}
