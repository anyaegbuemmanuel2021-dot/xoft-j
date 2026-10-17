import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config/index.js';
import { ProviderRouter } from '../src/providers/ProviderRouter.js';
import { ModelHealthManager } from '../src/providers/ModelHealthManager.js';
import { GatewaySettingsStore } from '../src/providers/GatewaySettingsStore.js';
import { registerGatewayRoutes } from '../src/providers/gatewayRoutes.js';
import { startMockGateway } from './helpers/mockGateway.js';

/**
 * The real Express server cannot be started in this sandbox (express/ws cannot be installed offline), so the route handlers are driven
 * through a recording stand-in for `app` with fake req/res objects. This tests the handler LOGIC (auth gating, validation, masking,
 * status codes) — not Express wiring, which is a one-line registerGatewayRoutes(app, …) call in index.js.
 */
const P = config.providers; const SNAP = JSON.parse(JSON.stringify(P));
let free; let env;
const requireAdmin = (req, res, next) => (req.deviceAuth ? res.status(403).json({ error: 'This action requires the admin API key, not a device token.' }) : next());

function setup() {
  for (const k of ['openai', 'gemini', 'claude', 'xai', 'experiential']) P[k].apiKey = null; P.ollama.enabled = false;
  Object.assign(P.freellmapi, { enabled: false, apiKey: null, baseUrl: 'http://localhost:3001/v1', model: 'auto', embeddingModel: null, timeoutMs: 60000 });
  Object.assign(P.litellm, { enabled: false, apiKey: null, baseUrl: 'http://localhost:4000/v1', model: '', embeddingModel: null, timeoutMs: 60000 });
  config.aiRouting.primaryProvider = null; config.aiRouting.fallbackProviders = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-routes-'));
  const router = new ProviderRouter(new ModelHealthManager());
  const gatewaySettings = new GatewaySettingsStore({ dataDir: dir, config, logger: { warn() {} } }).load();
  const logged = []; const routes = new Map();
  const app = Object.fromEntries(['get', 'put', 'post', 'delete'].map((m) => [m, (p, ...h) => routes.set(`${m.toUpperCase()} ${p}`, h)]));
  registerGatewayRoutes(app, { router, gatewaySettings, config, activityLog: { log: (e) => logged.push(e) }, requireAdmin });
  const call = async (method, route, { params = {}, body = {}, deviceAuth = null } = {}) => {
    const handlers = routes.get(`${method} ${route}`); assert.ok(handlers, `no route ${method} ${route}`);
    const req = { params, body, deviceAuth }; let out = { status: 200, body: undefined };
    const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
    let i = 0; const next = async () => { const h = handlers[i++]; if (h) await h(req, res, next); };
    await next(); return out;
  };
  return { dir, router, gatewaySettings, logged, routes, call };
}
before(async () => { free = await startMockGateway({ apiKey: 'freellmapi-good-key-123456', label: 'free' }); });
after(async () => { await free.close(); for (const k of Object.keys(SNAP)) Object.assign(P[k], SNAP[k]); });
beforeEach(() => { env = setup(); free.state.mode = 'ok'; });

describe('gateway REST routes', () => {
  test('GET /api/ai/status with ZERO providers: 200, aiAvailable=false, honest gateway states, no secrets, no auth needed to read status', async () => {
    const r = await env.call('GET', '/api/ai/status');
    assert.equal(r.status, 200); assert.equal(r.body.aiAvailable, false); assert.deepEqual(r.body.configuredProviders, []);
    assert.equal(r.body.gateways.freellmapi.state, 'disabled'); assert.equal(r.body.gateways.litellm.state, 'disabled');
    assert.match(r.body.note, /running normally without AI/); assert.ok(!JSON.stringify(r.body).match(/apiKey|sk-/));
  });
  test('admin-only: a device token gets 403 on every configuration route and nothing changes', async () => {
    for (const [m, route, params] of [['GET', '/api/providers/gateways', {}], ['PUT', '/api/providers/gateways/:id', { id: 'litellm' }], ['DELETE', '/api/providers/gateways/:id', { id: 'litellm' }], ['POST', '/api/providers/gateways/:id/test', { id: 'litellm' }], ['GET', '/api/providers/gateways/:id/models', { id: 'litellm' }], ['POST', '/api/providers/gateways/:id/model', { id: 'litellm' }]]) {
      const r = await env.call(m, route, { params, body: { enabled: true, apiKey: 'sk-x-1234567890' }, deviceAuth: 'dev-1' });
      assert.equal(r.status, 403, `${m} ${route}`);
    }
    assert.equal(P.litellm.enabled, false); assert.equal(P.litellm.apiKey, null);
  });
  test('PUT saves, applies live, returns a view WITHOUT the key, logs without the key, and a successful configuration makes the gateway available', async () => {
    const put = await env.call('PUT', '/api/providers/gateways/:id', { params: { id: 'freellmapi' }, body: { enabled: true, baseUrl: free.baseUrl, apiKey: 'freellmapi-good-key-123456', model: 'auto' } });
    assert.equal(put.status, 200); assert.equal(put.body.apiKeySet, true);
    assert.ok(!JSON.stringify(put.body).includes('good-key-123456')); assert.match(put.body.apiKeyMasked, /^fre\*+3456$/);
    assert.ok(!JSON.stringify(env.logged).includes('good-key'), 'activity log must not contain the key'); assert.equal(env.logged[0].detail.apiKeyChanged, true);
    assert.deepEqual(env.router.configuredProviders(), ['freellmapi']);
    const all = await env.call('GET', '/api/providers/gateways'); assert.ok(!JSON.stringify(all.body).includes('good-key-123456'));
    const st = await env.call('GET', '/api/ai/status'); assert.equal(st.body.aiAvailable, true);
  });
  test('PUT rejects bad input with 400 and leaves configuration untouched; unknown gateway => 404', async () => {
    for (const body of [{ baseUrl: 'file:///etc/passwd' }, { baseUrl: 'http://u:p@h/v1' }, { timeoutMs: 1 }, { nonsense: true }, { apiKey: 'a b c' }]) {
      const before = JSON.stringify(P.litellm); const r = await env.call('PUT', '/api/providers/gateways/:id', { params: { id: 'litellm' }, body });
      assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(JSON.stringify(P.litellm), before);
    }
    assert.equal((await env.call('PUT', '/api/providers/gateways/:id', { params: { id: 'openai' }, body: { enabled: true } })).status, 404);
  });
  test('POST test: real connection test result + updated status; a wrong key reports AUTHENTICATION_ERROR and the status reflects it', async () => {
    await env.call('PUT', '/api/providers/gateways/:id', { params: { id: 'freellmapi' }, body: { enabled: true, baseUrl: free.baseUrl, apiKey: 'freellmapi-WRONG-key-000000' } });
    const bad = await env.call('POST', '/api/providers/gateways/:id/test', { params: { id: 'freellmapi' } });
    assert.equal(bad.body.result, 'AUTHENTICATION_ERROR'); assert.equal(bad.body.status.state, 'authentication_error'); assert.ok(!JSON.stringify(bad.body).includes('WRONG-key'));
    await env.call('PUT', '/api/providers/gateways/:id', { params: { id: 'freellmapi' }, body: { apiKey: 'freellmapi-good-key-123456' } });
    const ok = await env.call('POST', '/api/providers/gateways/:id/test', { params: { id: 'freellmapi' } });
    assert.equal(ok.body.result, 'CONNECTED'); assert.equal(ok.body.status.state, 'available');
  });
  test('GET models: lists when reachable; an unconfigured or failing gateway is a normal 200 {available:false}, never a 5xx', async () => {
    const off = await env.call('GET', '/api/providers/gateways/:id/models', { params: { id: 'litellm' } });
    assert.equal(off.status, 200); assert.equal(off.body.available, false); assert.equal(off.body.reason, 'disabled');
    await env.call('PUT', '/api/providers/gateways/:id', { params: { id: 'freellmapi' }, body: { enabled: true, baseUrl: free.baseUrl, apiKey: 'freellmapi-good-key-123456' } });
    const ok = await env.call('GET', '/api/providers/gateways/:id/models', { params: { id: 'freellmapi' } });
    assert.deepEqual(ok.body.models.map((m) => m.id), ['model-a', 'model-b']);
    free.state.mode = '500'; const bad = await env.call('GET', '/api/providers/gateways/:id/models', { params: { id: 'freellmapi' } });
    assert.equal(bad.status, 200); assert.equal(bad.body.available, false); assert.equal(bad.body.reason, 'discovery_failed');
  });
  test('POST model: must be a discovered model when discovery works; accepted explicitly when discovery is unavailable; empty rejected', async () => {
    await env.call('PUT', '/api/providers/gateways/:id', { params: { id: 'freellmapi' }, body: { enabled: true, baseUrl: free.baseUrl, apiKey: 'freellmapi-good-key-123456' } });
    assert.equal((await env.call('POST', '/api/providers/gateways/:id/model', { params: { id: 'freellmapi' }, body: { model: '' } })).status, 400);
    assert.equal((await env.call('POST', '/api/providers/gateways/:id/model', { params: { id: 'freellmapi' }, body: { model: 'ghost' } })).status, 400);
    const ok = await env.call('POST', '/api/providers/gateways/:id/model', { params: { id: 'freellmapi' }, body: { model: 'model-b' } });
    assert.equal(ok.body.verifiedAgainstCatalog, true); assert.equal(P.freellmapi.model, 'model-b');
    free.state.mode = '500'; env.router.getInstance('freellmapi')._models.at = 0; // force rediscovery, which now fails
    const manual = await env.call('POST', '/api/providers/gateways/:id/model', { params: { id: 'freellmapi' }, body: { model: 'my-custom-model' } });
    assert.equal(manual.status, 200); assert.equal(manual.body.verifiedAgainstCatalog, false); assert.equal(P.freellmapi.model, 'my-custom-model');
  });
  test('DELETE resets to environment values', async () => {
    await env.call('PUT', '/api/providers/gateways/:id', { params: { id: 'litellm' }, body: { enabled: true, apiKey: 'sk-litellm-abcdefghij', model: 'x' } });
    const r = await env.call('DELETE', '/api/providers/gateways/:id', { params: { id: 'litellm' } });
    assert.equal(r.status, 200); assert.equal(P.litellm.enabled, false); assert.equal(P.litellm.apiKey, null); assert.equal(r.body.source, 'environment');
  });
  test('saving settings clears a stale cooldown so a corrected key works immediately', async () => {
    await env.call('PUT', '/api/providers/gateways/:id', { params: { id: 'freellmapi' }, body: { enabled: true, baseUrl: free.baseUrl, apiKey: 'freellmapi-WRONG-key-000000' } });
    await env.router.complete('simple', { messages: [{ role: 'user', content: 'x' }] }).catch(() => {});
    assert.equal(env.router.gatewayStatus('freellmapi').state, 'authentication_error');
    await env.call('PUT', '/api/providers/gateways/:id', { params: { id: 'freellmapi' }, body: { apiKey: 'freellmapi-good-key-123456' } });
    assert.match((await env.router.complete('simple', { messages: [{ role: 'user', content: 'x' }] })).text, /from free/);
  });
});
