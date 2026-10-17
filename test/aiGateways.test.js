import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from '../src/config/index.js';
import { ProviderRouter, TaskType } from '../src/providers/ProviderRouter.js';
import { ModelHealthManager } from '../src/providers/ModelHealthManager.js';
import { FreeLLMAPIProvider } from '../src/providers/FreeLLMAPIProvider.js';
import { LiteLLMProvider } from '../src/providers/LiteLLMProvider.js';
import { GatewaySettingsStore } from '../src/providers/GatewaySettingsStore.js';
import { buildProviderOverview } from '../src/providers/providerOverview.js';
import { NoAiProviderError, AllProvidersFailedError, aiErrorToHttp } from '../src/providers/errors.js';
import { Watchdog } from '../src/watchdog/Watchdog.js';
import { maskKey, redactSecrets, normalizeBaseUrl, gatewayConfigState, gatewayConfigFromEnv } from '../src/providers/gatewayConfig.js';
import { MemoryManager } from '../src/memory/MemoryManager.js';
import * as privacy from '../src/privacy/PrivacyClassifier.js';
import { startMockGateway, closedPort } from './helpers/mockGateway.js';

const P = config.providers;
const SNAP = JSON.parse(JSON.stringify(P));
const realFetch = globalThis.fetch;
const KEYS = ['openai', 'gemini', 'claude', 'xai', 'experiential'];
let directCalls;

/** Every direct provider off, both gateways off, Ollama off — the "nothing configured" baseline. */
function allOff() {
  for (const k of KEYS) P[k].apiKey = null;
  P.ollama.enabled = false;
  Object.assign(P.freellmapi, { enabled: false, apiKey: null, baseUrl: 'http://localhost:3001/v1', model: 'auto', embeddingModel: null, timeoutMs: 60000, vision: false, tools: true });
  Object.assign(P.litellm, { enabled: false, apiKey: null, baseUrl: 'http://localhost:4000/v1', model: '', embeddingModel: null, timeoutMs: 60000, vision: false, tools: true });
  config.aiRouting.primaryProvider = null; config.aiRouting.fallbackProviders = []; config.aiRouting.fallbackEnabled = true;
}
/** Turns the EXISTING OpenAI provider on and answers its real URL (api.openai.com) locally; everything else hits the real network stack. */
function enableDirectOpenAI() {
  P.openai.apiKey = 'sk-test-direct-openai-key-0000';
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.openai.com')) { directCalls++; return new Response(JSON.stringify({ choices: [{ message: { content: 'reply from DIRECT openai' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } }); }
    return realFetch(url, opts);
  };
}
const enableGateway = (id, srv, extra = {}) => Object.assign(P[id], { enabled: true, baseUrl: srv.baseUrl, timeoutMs: 1500, ...extra });
const ask = (router, params = {}) => router.complete(TaskType.SIMPLE, { messages: [{ role: 'user', content: 'hello' }], ...params });
const newRouter = () => { const hm = new ModelHealthManager(); return { hm, router: new ProviderRouter(hm) }; };

let free, lite;
before(async () => { free = await startMockGateway({ apiKey: 'freellmapi-good-key-123456', label: 'free' }); lite = await startMockGateway({ apiKey: null, label: 'lite' }); });
after(async () => { await free.close(); await lite.close(); globalThis.fetch = realFetch; for (const k of Object.keys(SNAP)) Object.assign(P[k], SNAP[k]); });
beforeEach(() => { allOff(); directCalls = 0; free.state.mode = 'ok'; lite.state.mode = 'ok'; free.state.requests.length = 0; lite.state.requests.length = 0; free.state.apiKey = 'freellmapi-good-key-123456'; free.state.retryAfter = null; });
afterEach(() => { globalThis.fetch = realFetch; });

describe('gateway configuration is a provider-level STATE, never a startup error', () => {
  test('both gateways default to disabled and off the availability list', () => {
    const c = gatewayConfigFromEnv('freellmapi', {}); const l = gatewayConfigFromEnv('litellm', {});
    assert.equal(c.enabled, false); assert.equal(l.enabled, false);
    assert.equal(c.baseUrl, 'http://localhost:3001/v1'); assert.equal(l.baseUrl, 'http://localhost:4000/v1');
    assert.equal(gatewayConfigState('freellmapi', c).state, 'disabled');
  });
  test('enabled without a key: FreeLLMAPI => unconfigured; LiteLLM (key is optional on an open proxy) => configured', () => {
    assert.equal(gatewayConfigState('freellmapi', { enabled: true, baseUrl: 'http://localhost:3001/v1', apiKey: null }).state, 'unconfigured');
    assert.equal(gatewayConfigState('litellm', { enabled: true, baseUrl: 'http://localhost:4000/v1', apiKey: null }).state, 'configured');
  });
  test('garbage values never throw; they become invalid_configuration', () => {
    for (const bad of ['not a url', 'ftp://x/v1', 'http://user:pw@host/v1', '', undefined]) {
      assert.doesNotThrow(() => gatewayConfigState('litellm', { enabled: true, baseUrl: bad, apiKey: 'k' }));
      assert.equal(gatewayConfigState('litellm', { enabled: true, baseUrl: bad, apiKey: 'k' }).state, 'invalid_configuration', String(bad));
    }
    assert.equal(normalizeBaseUrl('http://localhost:4000/v1/?x=1#y').url, 'http://localhost:4000/v1');
    assert.equal(gatewayConfigFromEnv('litellm', { LITELLM_TIMEOUT_MS: 'banana' }).timeoutMs, 60000);
  });
  test('keys are masked and scrubbed from text', () => {
    assert.equal(maskKey(null), null);
    assert.equal(maskKey('sk-abcdefghijklmnopqrstuvwxyz1234'), 'sk-************1234');
    assert.doesNotMatch(maskKey('short'), /short/);
    assert.equal(redactSecrets('bad key sk-live-9999999999 here', ['sk-live-9999999999']), 'bad key [REDACTED] here');
    assert.equal(redactSecrets('Authorization: Bearer abcdefghijklmnop123'), 'Authorization: Bearer [REDACTED]');
  });
  test('a fresh process with every setting garbage, enabled and keyless still imports and constructs the router (no fatal error)', () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { ProviderRouter } = await import('./src/providers/ProviderRouter.js');
      const { config, availableProviders } = await import('./src/config/index.js');
      const r = new ProviderRouter(); 
      console.log(JSON.stringify({ ok: true, avail: availableProviders(), states: [r.gatewayStatus('freellmapi').state, r.gatewayStatus('litellm').state] }));`],
      { cwd: process.cwd(), env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH ?? '', FREELLMAPI_ENABLED: 'true', FREELLMAPI_BASE_URL: 'not a url', LITELLM_ENABLED: 'true', LITELLM_BASE_URL: '::::', LITELLM_TIMEOUT_MS: 'x', OLLAMA_ENABLED: 'true' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepEqual(out.states, ['invalid_configuration', 'invalid_configuration']);
    assert.ok(!out.avail.includes('freellmapi') && !out.avail.includes('litellm'));
  });
});

describe('gateway providers against a real HTTP gateway', () => {
  test('complete(): normalized result, bearer key sent, X-Routed-Via surfaced', async () => {
    enableGateway('freellmapi', free, { apiKey: 'freellmapi-good-key-123456' });
    const r = await new FreeLLMAPIProvider().complete({ messages: [{ role: 'user', content: 'hi' }], system: 'be brief', maxTokens: 50 });
    assert.match(r.text, /reply from free model=auto/); assert.equal(r.usage.inputTokens, 11); assert.equal(r.usage.outputTokens, 5);
    assert.equal(r.raw, 'freellmapi:auto'); assert.equal(r.routedVia, 'free/upstream-x');
    const req = free.state.requests.at(-1);
    assert.equal(req.headers.authorization, 'Bearer freellmapi-good-key-123456'); assert.equal(req.body.messages[0].role, 'system'); assert.equal(req.body.max_tokens, 50);
  });
  test('LiteLLM without a key sends no Authorization header; model comes from config or discovery, never hard-coded', async () => {
    enableGateway('litellm', lite);
    const p = new LiteLLMProvider();
    const r = await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(lite.state.requests.filter((q) => q.url === '/v1/chat/completions').at(-1).headers.authorization, undefined);
    assert.match(r.text, /model=model-a/, 'no LITELLM_MODEL set => first discovered model');
    P.litellm.model = 'my-alias'; assert.match((await p.complete({ messages: [{ role: 'user', content: 'x' }] })).text, /model=my-alias/);
    p.setModel('runtime-pick'); assert.match((await p.complete({ messages: [{ role: 'user', content: 'x' }] })).text, /model=runtime-pick/);
  });
  test('no model configured AND discovery fails => clear invalid_request error, not a guess', async () => {
    enableGateway('litellm', lite); lite.state.mode = '500';
    await assert.rejects(new LiteLLMProvider().complete({ messages: [{ role: 'user', content: 'x' }] }), (e) => e.errorType === 'invalid_request' && /LITELLM_MODEL/.test(e.message));
  });
  test('tool calls are normalized to {name,input}; malformed arguments are an error, not silently {}', async () => {
    enableGateway('litellm', lite, { model: 'm' });
    const tools = [{ name: 'read_file', description: 'd', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
    const r = await new LiteLLMProvider().complete({ messages: [{ role: 'user', content: 'USE_TOOL' }], tools });
    assert.deepEqual(r.toolCalls, [{ name: 'read_file', input: { path: 'a.txt' } }]);
    assert.equal(lite.state.requests.at(-1).body.tools[0].function.name, 'read_file');
    await assert.rejects(new LiteLLMProvider().complete({ messages: [{ role: 'user', content: 'BAD_TOOL' }], tools }), /malformed JSON arguments/);
  });
  test('streaming: deltas arrive incrementally, tool-call fragments reassemble, keep-alives are ignored', async () => {
    enableGateway('litellm', lite, { model: 'm' });
    const chunks = []; let done;
    for await (const ev of new LiteLLMProvider().stream({ messages: [{ role: 'user', content: 'go' }] })) { if (ev.type === 'text') chunks.push(ev.delta); else done = ev.result; }
    assert.deepEqual(chunks, ['Hel', 'lo ', 'stream']); assert.equal(done.text, 'Hello stream'); assert.equal(done.usage.inputTokens, 7);
    const tools = [{ name: 'read_file', description: 'd', inputSchema: { type: 'object' } }];
    let tc; for await (const ev of new LiteLLMProvider().stream({ messages: [{ role: 'user', content: 'USE_TOOL' }], tools })) if (ev.type === 'done') tc = ev.result.toolCalls;
    assert.deepEqual(tc, [{ name: 'read_file', input: { path: 'a.txt' } }]);
  });
  test('model discovery works, is cached, and its failure never throws out of the provider as anything but a typed error', async () => {
    enableGateway('litellm', lite, { model: 'm' });
    const p = new LiteLLMProvider();
    assert.deepEqual((await p.listModels()).map((m) => m.id), ['model-a', 'model-b']);
    const n = lite.state.requests.length; await p.listModels(); assert.equal(lite.state.requests.length, n, 'cached');
    lite.state.mode = '500'; await assert.rejects(p.listModels({ force: true }), (e) => e.errorType === 'server_error');
  });
  test('embeddings: only when an embedding model is configured; results are ordered by index', async () => {
    enableGateway('litellm', lite, { model: 'm' });
    const p = new LiteLLMProvider();
    assert.equal(p.supportsEmbeddings(), false);
    await assert.rejects(p.embed('x'), /no embedding model configured/);
    P.litellm.embeddingModel = 'emb-1';
    assert.equal(p.supportsEmbeddings(), true);
    assert.deepEqual(await p.embed(['a', 'b']), [[0, 0.5], [1, 1.5]], 'vector i must belong to input i even when the gateway answers out of order');
    assert.deepEqual(await p.embed('a'), [0, 0.5], 'a single string returns a single vector');
  });
  test('connection test reports the truth for every condition (CONNECTED / AUTH / UNAVAILABLE / TIMEOUT / SERVER / INVALID / NOT_CONFIGURED)', async () => {
    const probe = async (id, mk) => (mk ?? (id === 'freellmapi' ? new FreeLLMAPIProvider() : new LiteLLMProvider())).probe();
    assert.equal((await probe('litellm')).result, 'NOT_CONFIGURED'); // disabled
    P.freellmapi.enabled = true; assert.equal((await probe('freellmapi')).result, 'NOT_CONFIGURED'); // enabled, no key
    enableGateway('freellmapi', free, { apiKey: 'freellmapi-good-key-123456' });
    const ok = await probe('freellmapi'); assert.equal(ok.result, 'CONNECTED'); assert.equal(ok.modelCount, 2); assert.ok(ok.latencyMs >= 0);
    P.freellmapi.apiKey = 'freellmapi-WRONG-key-000000';
    const bad = await probe('freellmapi'); assert.equal(bad.result, 'AUTHENTICATION_ERROR'); assert.equal(bad.httpStatus, 401);
    assert.ok(!bad.message.includes('freellmapi-WRONG-key-000000'), 'the rejected key must not be echoed back even though the server echoed it');
    P.freellmapi.apiKey = 'freellmapi-good-key-123456';
    P.freellmapi.baseUrl = `http://127.0.0.1:${await closedPort()}/v1`; assert.equal((await probe('freellmapi')).result, 'UNAVAILABLE');
    enableGateway('freellmapi', free, { apiKey: 'freellmapi-good-key-123456', timeoutMs: 1000 }); free.state.mode = 'hang';
    assert.equal((await probe('freellmapi')).result, 'TIMEOUT');
    free.state.mode = '500'; assert.equal((await probe('freellmapi')).result, 'SERVER_ERROR');
    free.state.mode = '404'; assert.equal((await probe('freellmapi')).result, 'INVALID_CONFIGURATION');
    free.state.mode = 'html'; assert.equal((await probe('freellmapi')).result, 'INVALID_CONFIGURATION');
    P.freellmapi.baseUrl = 'nonsense'; assert.equal((await probe('freellmapi')).result, 'INVALID_CONFIGURATION');
  });
  test('a gateway secret never appears in any error message', async () => {
    enableGateway('freellmapi', free, { apiKey: 'freellmapi-WRONG-key-000000' });
    try { await new FreeLLMAPIProvider().complete({ messages: [{ role: 'user', content: 'x' }] }); assert.fail('expected auth error'); }
    catch (e) { assert.equal(e.errorType, 'auth'); assert.ok(!e.message.includes('freellmapi-WRONG-key-000000')); }
  });
});

describe('ProviderRouter — the ten-case test matrix (real router, real gateways over HTTP, existing OpenAI provider for the direct path)', () => {
  test('1. FreeLLMAPI OFF, LiteLLM OFF, existing provider ON => Xoft works through the existing provider', async () => {
    enableDirectOpenAI(); const { router } = newRouter();
    assert.match((await ask(router)).text, /DIRECT openai/); assert.equal(directCalls, 1);
    assert.equal(free.chatCalls() + lite.chatCalls(), 0, 'disabled gateways are never contacted');
  });
  test('2. FreeLLMAPI ON, LiteLLM OFF => Xoft uses FreeLLMAPI', async () => {
    enableGateway('freellmapi', free, { apiKey: 'freellmapi-good-key-123456' }); const { router } = newRouter();
    const r = await ask(router); assert.match(r.text, /reply from free/); assert.equal(r.raw.split(':')[0], 'freellmapi'); assert.equal(lite.chatCalls(), 0);
  });
  test('3. FreeLLMAPI OFF, LiteLLM ON => Xoft uses LiteLLM', async () => {
    enableGateway('litellm', lite, { model: 'm' }); const { router } = newRouter();
    const r = await ask(router); assert.match(r.text, /reply from lite/); assert.equal(free.chatCalls(), 0);
  });
  test('4. both ON => router can use both (LiteLLM first by default order; FreeLLMAPI when LiteLLM fails or is pinned)', async () => {
    enableGateway('freellmapi', free, { apiKey: 'freellmapi-good-key-123456' }); enableGateway('litellm', lite, { model: 'm' });
    const { router } = newRouter();
    assert.match((await ask(router)).text, /from lite/);
    lite.state.mode = '500'; assert.match((await ask(router)).text, /from free/);
    lite.state.mode = 'ok'; config.aiRouting.primaryProvider = 'freellmapi'; // operator pins FreeLLMAPI: order is configurable, nothing is hard-coded "best"
    const r2 = newRouter(); assert.match((await ask(r2.router)).text, /from free/);
  });
  test('5. FreeLLMAPI unavailable (offline) => automatic fallback to the next provider', async () => {
    enableDirectOpenAI(); enableGateway('freellmapi', free, { apiKey: 'freellmapi-good-key-123456', baseUrl: `http://127.0.0.1:${await closedPort()}/v1` });
    config.aiRouting.primaryProvider = 'freellmapi'; config.aiRouting.fallbackProviders = ['openai'];
    const { router, hm } = newRouter();
    assert.match((await ask(router)).text, /DIRECT openai/);
    assert.equal(router.gatewayStatus('freellmapi').state, 'unavailable');
    assert.ok(hm.isHardCooling('freellmapi'));
  });
  test('6. LiteLLM unavailable (timeout) => automatic fallback', async () => {
    enableDirectOpenAI(); enableGateway('litellm', lite, { model: 'm', timeoutMs: 1000 }); lite.state.mode = 'hang';
    config.aiRouting.primaryProvider = 'litellm'; config.aiRouting.fallbackProviders = ['openai'];
    const { router } = newRouter();
    assert.match((await ask(router)).text, /DIRECT openai/);
    assert.equal(router.gatewayStatus('litellm').state, 'timeout');
  });
  test('7. ALL providers unavailable => Xoft stays up and returns the clean structured NO_AI_PROVIDER_AVAILABLE only when AI is requested', async () => {
    const { router } = newRouter();                       // construction and status calls never need AI
    assert.deepEqual(router.configuredProviders(), []); router.gatewayStatus('litellm'); router.gatewayStatus('freellmapi');
    await assert.rejects(ask(router), (e) => { assert.ok(e instanceof NoAiProviderError); assert.equal(e.code, 'NO_AI_PROVIDER_AVAILABLE'); return true; });
    const err = await ask(router).catch((e) => e);
    assert.deepEqual({ success: err.toResponse().success, error: err.toResponse().error, message: err.toResponse().message }, { success: false, error: 'NO_AI_PROVIDER_AVAILABLE', message: 'No AI provider is currently configured or available.' });
    const http = aiErrorToHttp(err); assert.equal(http.status, 503); assert.equal(http.body.error, 'NO_AI_PROVIDER_AVAILABLE');
    assert.throws(() => router.select(TaskType.SIMPLE), /no configured provider available/); // legacy message preserved
    assert.throws(() => router.selectEmbedding(), NoAiProviderError); assert.throws(() => router.selectVision(), NoAiProviderError);
    // ...and everything that is NOT inference keeps working with zero providers:
    const overview = await buildProviderOverview({ router, modelHealth: new ModelHealthManager(), config });
    assert.ok(overview.length >= 8 && overview.every((p) => p.status === 'NOT_CONFIGURED'));
    const mem = new MemoryManager({ router, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-mem-')) });
    assert.equal(mem.vectorEnabled, false); mem.addTurn('s', 'user', 'hello'); assert.equal(mem.getConversation('s').length, 1);
  });
  test('7b. every configured provider FAILS at call time => structured AI_PROVIDERS_FAILED (or NO_AI_PROVIDER_AVAILABLE if all were merely unreachable), process survives', async () => {
    enableGateway('freellmapi', free, { apiKey: 'freellmapi-good-key-123456' }); free.state.mode = '500';
    const { router } = newRouter();
    const e1 = await ask(router).catch((e) => e); assert.ok(e1 instanceof AllProvidersFailedError); assert.equal(e1.code, 'AI_PROVIDERS_FAILED'); assert.equal(aiErrorToHttp(e1).status, 502);
    allOff(); enableGateway('litellm', lite, { model: 'm', baseUrl: `http://127.0.0.1:${await closedPort()}/v1` });
    const e2 = await ask(newRouter().router).catch((e) => e); assert.equal(e2.code, 'NO_AI_PROVIDER_AVAILABLE'); assert.equal(e2.attempts[0].errorType, 'unavailable');
  });
  test('8. no API keys anywhere => everything constructs and reports honest states', async () => {
    const { router } = newRouter();
    assert.equal(router.gatewayStatus('freellmapi').state, 'disabled'); assert.equal(router.gatewayStatus('litellm').state, 'disabled');
    P.freellmapi.enabled = true; P.litellm.enabled = true;
    assert.equal(router.gatewayStatus('freellmapi').state, 'unconfigured');
    assert.notEqual(router.gatewayStatus('litellm').state, 'unconfigured'); // open LiteLLM proxy needs no key
    assert.equal(router.gatewayStatus('freellmapi').available, false);
  });
  test('9. invalid FreeLLMAPI key => ONLY FreeLLMAPI becomes authentication_error; others unaffected', async () => {
    enableDirectOpenAI(); enableGateway('freellmapi', free, { apiKey: 'freellmapi-WRONG-key-000000' }); enableGateway('litellm', lite, { model: 'm' });
    config.aiRouting.primaryProvider = 'freellmapi'; config.aiRouting.fallbackProviders = ['litellm', 'openai'];
    const { router, hm } = newRouter();
    assert.match((await ask(router)).text, /from lite/); // fell through to the healthy peer
    assert.equal(router.gatewayStatus('freellmapi').state, 'authentication_error');
    assert.notEqual(router.gatewayStatus('litellm').state, 'authentication_error'); assert.equal(hm.isHealthy('litellm'), true); assert.equal(hm.isHealthy('openai'), true);
  });
  test('10. invalid LiteLLM key => ONLY LiteLLM becomes authentication_error', async () => {
    lite.state.apiKey = 'sk-litellm-master-0000000000';
    enableDirectOpenAI(); enableGateway('litellm', lite, { model: 'm', apiKey: 'sk-litellm-WRONG-0000000000' }); enableGateway('freellmapi', free, { apiKey: 'freellmapi-good-key-123456' });
    config.aiRouting.primaryProvider = 'litellm'; config.aiRouting.fallbackProviders = ['freellmapi', 'openai'];
    const { router } = newRouter();
    assert.match((await ask(router)).text, /from free/);
    assert.equal(router.gatewayStatus('litellm').state, 'authentication_error');
    assert.notEqual(router.gatewayStatus('freellmapi').state, 'authentication_error');
    lite.state.apiKey = null;
  });
  test('a failing/hostile provider can never crash routing (throws strings, undefined, or from isConfigured)', async () => {
    const { router } = newRouter();
    router._instances.openai = { name: 'openai', isConfigured: () => true, complete: async () => { throw 'a bare string'; } };
    router._instances.claude = { name: 'claude', isConfigured: () => { throw new Error('config exploded'); }, complete: async () => ({ text: 'never' }) };
    router._instances.gemini = { name: 'gemini', isConfigured: () => true, complete: async () => ({ text: 'survivor', raw: 'gemini' }) };
    assert.equal((await ask(router)).text, 'survivor');
    assert.doesNotThrow(() => router.configuredProviders());
  });
});

describe('failure handling: no hammering, fast recovery, no permanent hard-coded preference', () => {
  test('a rejected key is NOT retried on every request (cooldown), and fixing it takes effect immediately after a successful test', async () => {
    enableDirectOpenAI(); enableGateway('freellmapi', free, { apiKey: 'freellmapi-WRONG-key-000000' });
    config.aiRouting.primaryProvider = 'freellmapi'; config.aiRouting.fallbackProviders = ['openai'];
    const { router } = newRouter();
    await ask(router); const hits = free.chatCalls(); assert.equal(hits, 1);
    for (let i = 0; i < 5; i++) await ask(router);
    assert.equal(free.chatCalls(), hits, 'no further calls to the gateway while it is cooling down');
    assert.equal(directCalls, 6);
    P.freellmapi.apiKey = 'freellmapi-good-key-123456';       // operator fixes the key...
    assert.equal((await router.probeProvider('freellmapi')).result, 'CONNECTED'); // ...and the connection test clears the cooldown
    assert.match((await ask(router)).text, /from free/);
  });
  test('rate limit honours Retry-After (capped) and other candidates answer meanwhile', async () => {
    enableDirectOpenAI(); enableGateway('litellm', lite, { model: 'm' }); lite.state.mode = '429'; lite.state.retryAfter = 2;
    config.aiRouting.primaryProvider = 'litellm'; config.aiRouting.fallbackProviders = ['openai'];
    const { router, hm } = newRouter();
    await ask(router); assert.equal(router.gatewayStatus('litellm').state, 'rate_limited');
    const cd = hm.getCooldown('litellm'); assert.ok(cd.until - Date.now() <= 2100 && cd.until - Date.now() > 1000);
  });
  test('a gateway that is the ONLY provider and is cooling down fails fast without a network call', async () => {
    enableGateway('freellmapi', free, { apiKey: 'freellmapi-WRONG-key-000000' }); const { router } = newRouter();
    await ask(router).catch(() => {}); const hits = free.chatCalls();
    const e = await ask(router).catch((x) => x); assert.equal(free.chatCalls(), hits); assert.equal(e.code, 'NO_AI_PROVIDER_AVAILABLE'); assert.match(e.message, /cooling down/);
  });
  test('default ordering never puts a gateway ahead of a configured direct provider; primary/fallback env overrides do', async () => {
    enableDirectOpenAI(); enableGateway('freellmapi', free, { apiKey: 'freellmapi-good-key-123456' }); enableGateway('litellm', lite, { model: 'm' });
    const { router } = newRouter();
    for (const t of Object.values(TaskType).filter((x) => x !== 'embedding')) {
      const names = router._preferenceFor(t).map((p) => p.name); const g = Math.min(names.indexOf('litellm'), names.indexOf('freellmapi'));
      assert.ok(names.indexOf('openai') < g && names.indexOf('claude') < g && names.indexOf('gemini') < g && names.indexOf('grok') < g, `${t}: ${names}`);
      assert.equal(names.at(-1), 'ollama');
    }
    assert.match((await ask(router)).text, /DIRECT openai/); assert.equal(free.chatCalls() + lite.chatCalls(), 0);
  });
  test('an unknown AI_PRIMARY_PROVIDER is a structured routing-config error at call time (it cannot stop startup)', async () => {
    config.aiRouting.primaryProvider = 'nonesuch'; const { router } = newRouter();
    const e = await ask(router).catch((x) => x); assert.equal(e.code, 'INVALID_PROVIDER_CONFIG'); assert.match(e.message, /does not match any known provider/); assert.match(e.message, /freellmapi/);
  });
});

describe('health integration: the existing Watchdog and overview understand gateway failures', () => {
  const diag = async (router, hm) => new Watchdog({ telemetry: { snapshot: () => ({ memory: { usedPercent: 1 }, storage: { usedPercent: 1 }, cpu: { percent: 1 } }) }, providerOverview: () => buildProviderOverview({ router, modelHealth: hm, config }), missionManager: { list: () => [], isStuck: () => false }, emergencyStop: { isActive: () => false } }).diagnose();
  test('disabled/unconfigured gateways never count as failures; a gateway with a bad key degrades (not crashes) health; all-down is CRITICAL', async () => {
    enableDirectOpenAI(); const a = newRouter();
    const healthy = (await diag(a.router, a.hm)).checks.find((c) => c.name === 'providers'); assert.equal(healthy.level, 'HEALTHY'); assert.match(healthy.detail, /1 configured/);
    enableGateway('freellmapi', free, { apiKey: 'freellmapi-WRONG-key-000000' });
    config.aiRouting.primaryProvider = 'freellmapi'; config.aiRouting.fallbackProviders = ['openai'];
    const b = newRouter(); await ask(b.router);
    const ov = await buildProviderOverview({ router: b.router, modelHealth: b.hm, config });
    assert.equal(ov.find((p) => p.id === 'freellmapi').status, 'AUTH_ERROR'); assert.equal(ov.find((p) => p.id === 'freellmapi').state, 'authentication_error');
    assert.equal((await diag(b.router, b.hm)).checks.find((c) => c.name === 'providers').level, 'DEGRADED');
    assert.ok(!JSON.stringify(ov).includes('freellmapi-WRONG-key'), 'overview never contains keys');
  });
  test('no provider at all => WARNING "no AI provider configured" (Xoft reports it, keeps running)', async () => {
    const { router, hm } = newRouter(); const c = (await diag(router, hm)).checks.find((x) => x.name === 'providers');
    assert.equal(c.level, 'WARNING'); assert.match(c.detail, /no AI provider configured/);
  });
});

describe('capabilities: tools, vision, streaming, embeddings, privacy, model selection', () => {
  test('gateways with tools disabled are skipped for tool requests; vision only goes to a gateway the operator marked vision-capable', async () => {
    enableGateway('litellm', lite, { model: 'm', tools: false }); enableGateway('freellmapi', free, { apiKey: 'freellmapi-good-key-123456', tools: true });
    const { router } = newRouter();
    const tools = [{ name: 't', description: 'd', inputSchema: { type: 'object' } }];
    assert.match((await ask(router, { tools })).text, /from free/); assert.equal(lite.chatCalls(), 0);
    assert.throws(() => router.selectVision(), NoAiProviderError);
    P.litellm.vision = true; assert.equal(router.selectVision().name, 'litellm');
    const img = { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] };
    const before = free.chatCalls(); P.litellm.vision = false;
    await assert.rejects(router.complete(TaskType.SIMPLE, { messages: [img] }), NoAiProviderError); assert.equal(free.chatCalls(), before, 'image request never sent to a non-vision gateway');
  });
  test('vision messages for a gateway use the OpenAI image_url format', async () => {
    const { VisionInterpreter } = await import('../src/vision/VisionInterpreter.js');
    enableGateway('litellm', lite, { model: 'm', vision: true });
    const { router } = newRouter(); const vi = new VisionInterpreter({ providerRouter: router });
    const msgs = vi._buildMessages(router.selectVision(), 'describe', 'AAAA', 'image/png');
    assert.equal(msgs[0].content[1].type, 'image_url'); assert.equal(msgs[0].content[1].image_url.url, 'data:image/png;base64,AAAA');
  });
  test('router.stream(): streams from a gateway, falls back BEFORE first output, and serves non-streaming providers as one chunk', async () => {
    enableDirectOpenAI(); enableGateway('litellm', lite, { model: 'm' });
    const { router } = newRouter();
    const collect = async (r) => { const t = []; let d; for await (const ev of r.stream(TaskType.SIMPLE, { messages: [{ role: 'user', content: 'hi' }] })) { if (ev.type === 'text') t.push(ev.delta); else d = ev.result; } return { t, d }; };
    config.aiRouting.primaryProvider = 'litellm'; config.aiRouting.fallbackProviders = ['openai'];
    let out = await collect(newRouter().router); assert.deepEqual(out.t, ['Hel', 'lo ', 'stream']);
    lite.state.mode = 'stream-fail-early'; out = await collect(newRouter().router); assert.deepEqual(out.t, ['reply from DIRECT openai'], 'no output had been emitted, so the router fell back');
    config.aiRouting.primaryProvider = 'openai'; lite.state.mode = 'ok'; out = await collect(newRouter().router); assert.deepEqual(out.t, ['reply from DIRECT openai']);
  });
  test('embeddings: existing OpenAI path unchanged; a gateway with an embedding model is used only when OpenAI is absent; otherwise semantic memory is just off', async () => {
    enableGateway('litellm', lite, { model: 'm' }); const { router } = newRouter();
    assert.throws(() => router.selectEmbedding(), NoAiProviderError);
    P.litellm.embeddingModel = 'emb-1'; assert.equal(router.selectEmbedding().name, 'litellm');
    P.openai.apiKey = 'sk-test-direct-openai-key-0000'; assert.equal(router.selectEmbedding().name, 'openai');
  });
  test('privacy routing: SECRET content is never sent to a gateway (even a localhost one that forwards to the cloud)', async () => {
    enableGateway('litellm', lite, { model: 'm' });
    const hm = new ModelHealthManager(); const router = new ProviderRouter(hm, { privacy });
    const e = await router.complete(TaskType.SIMPLE, { messages: [{ role: 'user', content: 'my key is sk-abcdefghijklmnopqrstuvwx' }] }).catch((x) => x);
    assert.match(e.message, /requires a local provider/); assert.equal(lite.chatCalls(), 0);
    const ok = await router.complete(TaskType.SIMPLE, { messages: [{ role: 'user', content: 'capital of France?' }] }); assert.match(ok.text, /from lite/);
  });
  test('runtime model selection and discovery work through the router for both gateways', async () => {
    enableGateway('litellm', lite, { model: 'm' }); enableGateway('freellmapi', free, { apiKey: 'freellmapi-good-key-123456' });
    const { router } = newRouter();
    for (const id of ['litellm', 'freellmapi']) {
      assert.deepEqual((await router.listModels(id)).map((m) => m.id), ['model-a', 'model-b']);
      assert.equal(router.setModel('model-b', { provider: id }).model, 'model-b'); assert.equal(router.getModel(id), 'model-b');
    }
    assert.throws(() => router.setModel('', { provider: 'litellm' }), /model name/);
  });
  test('the gateway never executes tools: it only returns the tool call for Xoft to run', async () => {
    enableGateway('litellm', lite, { model: 'm' }); const { router } = newRouter();
    const tools = [{ name: 'file_delete', description: 'd', inputSchema: { type: 'object' } }];
    const r = await ask(router, { messages: [{ role: 'user', content: 'USE_TOOL' }], tools });
    assert.deepEqual(r.toolCalls, [{ name: 'file_delete', input: { path: 'a.txt' } }]); // a request, not an action — Xoft's executor decides
    const src = fs.readFileSync(new URL('../src/providers/OpenAICompatibleGateway.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /child_process|node:fs|writeFile|exec\(|spawn\(/); // the gateway adapter has no path to files/terminal at all
  });
});

describe('GatewaySettingsStore — UI-driven configuration without leaking keys', () => {
  const mk = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-gwset-')); return { dir, store: new GatewaySettingsStore({ dataDir: dir, config, logger: { warn() {} } }).load() }; };
  test('update validates, applies live, persists with owner-only permissions, and the view never contains the key', () => {
    const { dir, store } = mk();
    const v = store.update('freellmapi', { enabled: true, baseUrl: 'http://localhost:3001/v1/', apiKey: 'freellmapi-super-secret-key-1', model: 'auto:smart' });
    assert.equal(P.freellmapi.enabled, true); assert.equal(P.freellmapi.baseUrl, 'http://localhost:3001/v1'); assert.equal(P.freellmapi.apiKey, 'freellmapi-super-secret-key-1');
    assert.equal(v.apiKeySet, true); assert.ok(!JSON.stringify(v).includes('super-secret'));
    const file = path.join(dir, 'provider-settings.json');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // simulate a restart: wipe live config, then load from the same file
    P.freellmapi.enabled = false; P.freellmapi.apiKey = null;
    const again = new GatewaySettingsStore({ dataDir: dir, config, logger: { warn() {} } }).load();
    assert.equal(P.freellmapi.enabled, true); assert.equal(P.freellmapi.apiKey, 'freellmapi-super-secret-key-1'); assert.equal(again.publicView('freellmapi').source, 'settings');
  });
  test('omitted apiKey leaves the key alone; empty string clears it; bad input is rejected without changing anything', () => {
    const { store } = mk(); store.update('litellm', { apiKey: 'sk-litellm-abcdefghijk' });
    store.update('litellm', { model: 'x' }); assert.equal(P.litellm.apiKey, 'sk-litellm-abcdefghijk');
    store.update('litellm', { apiKey: '' }); assert.equal(P.litellm.apiKey, null);
    for (const bad of [{ baseUrl: 'javascript:alert(1)' }, { baseUrl: 'http://u:p@h/v1' }, { timeoutMs: 5 }, { apiKey: 'has space' }, { bogus: 1 }, { model: 'x'.repeat(300) }]) {
      const before = JSON.stringify(P.litellm); assert.throws(() => store.update('litellm', bad), Error, JSON.stringify(bad)); assert.equal(JSON.stringify(P.litellm), before);
    }
    assert.throws(() => store.update('openai', { enabled: true }), /unknown gateway/);
  });
  test('a corrupt or hostile settings file is ignored (never a startup error); reset() returns to the environment', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-gwset-')); fs.writeFileSync(path.join(dir, 'provider-settings.json'), '{not json');
    let store; assert.doesNotThrow(() => { store = new GatewaySettingsStore({ dataDir: dir, config, logger: { warn() {} } }).load(); });
    assert.ok(store.loadError); assert.equal(P.litellm.enabled, false);
    fs.writeFileSync(path.join(dir, 'provider-settings.json'), JSON.stringify({ litellm: { enabled: true, baseUrl: 'file:///etc/passwd' }, freellmapi: { model: 'ok-model' } }));
    store = new GatewaySettingsStore({ dataDir: dir, config, logger: { warn() {} } }).load();
    assert.equal(P.litellm.enabled, false, 'invalid entry skipped as a whole'); assert.equal(P.freellmapi.model, 'ok-model', 'valid sibling entry still applied');
    store.reset('freellmapi'); assert.equal(P.freellmapi.model, 'auto');
  });
});

describe('source-level guarantees (no provider can be a startup dependency)', () => {
  const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  test('no module throws at import/startup because a provider key or gateway is missing', () => {
    for (const f of ['src/config/index.js', 'src/providers/gatewayConfig.js', 'src/providers/FreeLLMAPIProvider.js', 'src/providers/LiteLLMProvider.js', 'src/providers/GatewaySettingsStore.js']) {
      assert.doesNotMatch(read(f), /if\s*\(\s*!\s*[\w.]*(API_KEY|apiKey)[\w.]*\s*\)\s*{?\s*throw/i, f);
    }
    assert.doesNotMatch(read('src/providers/OpenAICompatibleGateway.js'), /constructor[\s\S]{0,400}throw new/);
  });
  test('index.js: gateway settings load is non-fatal and the startup message for "no provider" is informational, not an exit', () => {
    const idx = read('src/index.js');
    assert.match(idx, /new GatewaySettingsStore\(\{[^}]*\}\)\.load\(\)/);
    assert.match(idx, /running normally without AI/);
    assert.doesNotMatch(idx, /if\s*\(\s*!\s*availableProviders\(\)[^)]*\)\s*(process\.exit|throw)/);
    assert.doesNotMatch(idx, /if\s*\(\s*!\s*router\.configuredProviders\(\)[^)]*\)\s*(process\.exit|throw)/);
  });
});
