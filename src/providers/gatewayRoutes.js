import { GATEWAY_IDS, maskKey } from './gatewayConfig.js';

/**
 * REST surface for the optional AI gateways (FreeLLMAPI, LiteLLM): status, configuration, connection test, model discovery/selection.
 * Kept out of index.js so it can be exercised directly. All mutating/secret-adjacent routes require the admin key (not a device token);
 * API keys are write-only — never returned, logged, or included in error text.
 */
export function registerGatewayRoutes(app, { router, gatewaySettings, config, activityLog, requireAdmin, expensiveLimit = (_q, _s, n) => n() }) {
// Admin-only (not device tokens). Keys are write-only: they are never returned, logged, or included in errors.
const gatewayView = (id) => ({ ...gatewaySettings.publicView(id), apiKeyMasked: maskKey(config.providers[id].apiKey), status: router.gatewayStatus(id) });
const isGatewayId = (id) => GATEWAY_IDS.includes(id);
app.get('/api/ai/status', (_req, res) => {
  const configured = router.configuredProviders();
  res.json({
    aiAvailable: configured.length > 0,
    configuredProviders: configured,
    gateways: Object.fromEntries(GATEWAY_IDS.map((id) => [id, router.gatewayStatus(id)])),
    note: configured.length ? null : 'No AI provider is configured. Xoft is running normally without AI; only AI features are unavailable.',
  });
});
app.get('/api/providers/gateways', requireAdmin, (_req, res) => res.json(Object.fromEntries(GATEWAY_IDS.map((id) => [id, gatewayView(id)]))));
app.put('/api/providers/gateways/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  if (!isGatewayId(id)) return res.status(404).json({ error: `unknown gateway '${id}'` });
  try {
    const before = gatewaySettings.publicView(id);
    gatewaySettings.update(id, req.body ?? {});
    router.resetProviderHealth(id); // new key/URL/model deserves a fresh start (no stale cooldown)
    const inst = router.getInstance(id); if (inst) inst.lastProbe = null;
    activityLog.log({ type: 'ai_gateway_configured', detail: { gateway: id, changed: Object.keys(req.body ?? {}).filter((k) => k !== 'apiKey'), apiKeyChanged: 'apiKey' in (req.body ?? {}), wasEnabled: before.enabled } }); // never the key itself
    res.json(gatewayView(id));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/providers/gateways/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  if (!isGatewayId(id)) return res.status(404).json({ error: `unknown gateway '${id}'` });
  gatewaySettings.reset(id); router.resetProviderHealth(id);
  activityLog.log({ type: 'ai_gateway_reset', detail: { gateway: id } });
  res.json(gatewayView(id));
});
app.post('/api/providers/gateways/:id/test', requireAdmin, expensiveLimit, async (req, res) => {
  const { id } = req.params;
  if (!isGatewayId(id)) return res.status(404).json({ error: `unknown gateway '${id}'` });
  try { res.json({ id, ...(await router.probeProvider(id)), status: router.gatewayStatus(id) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/providers/gateways/:id/models', requireAdmin, expensiveLimit, async (req, res) => {
  const { id } = req.params;
  if (!isGatewayId(id)) return res.status(404).json({ error: `unknown gateway '${id}'` });
  const p = router.getInstance(id);
  // Discovery failure is a normal, reportable state (the gateway can still work with an explicitly configured model) — not a 5xx.
  if (!p.isConfigured()) return res.json({ id, available: false, models: [], selected: p.getModel(), reason: gatewayView(id).status.state });
  try { const models = await p.listModels({ force: true }); res.json({ id, available: true, models: models.map((m) => ({ id: m.id, owned_by: m.owned_by ?? null })), selected: p.getModel() }); }
  catch (err) { res.json({ id, available: false, models: [], selected: p.getModel(), reason: 'discovery_failed', message: String(err.message).slice(0, 300) }); }
});
app.post('/api/providers/gateways/:id/model', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (!isGatewayId(id)) return res.status(404).json({ error: `unknown gateway '${id}'` });
  const model = String(req.body?.model ?? '').trim();
  if (!model) return res.status(400).json({ error: 'model is required' });
  try {
    const p = router.getInstance(id);
    // If the gateway can list models, the name must be one of them; if discovery is unavailable the explicit name is accepted
    // (a gateway may serve models it does not enumerate), and the first real call will surface a wrong name clearly.
    let verified = false;
    try { const list = await p.listModels(); verified = true; if (!list.some((m) => m.id === model)) return res.status(400).json({ error: `'${model}' is not in ${p.label}'s model list` }); } catch { /* discovery unavailable */ }
    gatewaySettings.update(id, { model });
    activityLog.log({ type: 'ai_model_selected', detail: { provider: id, model, verifiedAgainstCatalog: verified } });
    res.json({ id, model, verifiedAgainstCatalog: verified });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
}
