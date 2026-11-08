import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActivityLog } from '../src/activity/ActivityLog.js';
import { ApprovalSystem } from '../src/approval/ApprovalSystem.js';
import { AutonomyManager } from '../src/autonomy/AutonomyManager.js';
import { EventBus } from '../src/events/EventBus.js';
import { Availability, Capability, ErrorCode } from '../src/engines/constants.js';
import { Engine } from '../src/engines/Engine.js';
import { EngineRegistry } from '../src/engines/EngineRegistry.js';
import { EngineRouter } from '../src/engines/EngineRouter.js';
import { EngineTaskManager } from '../src/engines/EngineTaskManager.js';
import { EngineTaskStore } from '../src/engines/EngineTaskStore.js';
import { createEngineApi, errorResponse, registerEngineRoutes, registerToolGatewayRoute } from '../src/engines/engineApi.js';
import { EngineError } from '../src/engines/constants.js';
import { XoftCoreEngine } from '../src/engines/XoftCoreEngine.js';
import { HermesEngine } from '../src/engines/hermes/HermesEngine.js';
import { HermesSettingsStore } from '../src/engines/hermes/HermesSettingsStore.js';
import { buildEngineTools } from '../src/tools/builtins/engineTools.js';
import { startFakeHermes } from './_fakeHermes.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-api-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, t = 5000) { const end = Date.now() + t; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await wait(15); } }
const GOAL = 'Fix the failing tests in my repo, run them, and report what changed.';

class Stub extends Engine {
  constructor(id, run) { super({ id, name: id, capabilities: Object.values(Capability) }); this.run = run; }
  async healthCheck() { return { available: true, level: Availability.READY, status: 'online', dependencies: {}, capabilities: this.capabilities, checkedAt: '' }; }
  taskPolicy() { return { ...super.taskPolicy(), permissionProfile: 'developer', nativeToolPolicy: 'off' }; }
  async execute(t, ctx) { return this.run(t, ctx); }
  async cancel() {}
}

async function rig() {
  const dataDir = tmp(); const fake = await startFakeHermes();
  const activityLog = new ActivityLog({ dataDir }); const eventBus = new EventBus({ activityLog });
  const autonomyManager = new AutonomyManager({ activityLog, eventBus, dataDir }); autonomyManager.set(5);
  const approvalSystem = new ApprovalSystem({ activityLog, eventBus, autonomyManager, dataDir });
  const hermes = new HermesEngine({ settingsStore: new HermesSettingsStore({ dataDir }), dataDir, env: { PATH: process.env.PATH, HERMES_HOME: path.join(dataDir, 'nohome'), HERMES_API_URL: fake.url, HERMES_API_KEY: 'test-key' } });
  const core = new Stub('xoft-core', async () => ({ status: 'completed', output: 'core' }));
  const registry = new EngineRegistry({ eventBus, activityLog }); registry.register(core, { priority: 60 }); registry.register(hermes, { priority: 50 });
  const router = new EngineRouter({ registry, eventBus, activityLog });
  const manager = new EngineTaskManager({ registry, router, store: new EngineTaskStore({ dataDir }), eventBus, activityLog, approvalSystem, autonomyManager, recoveryBackoffMs: 10 });
  await registry.refreshAll();
  const gateway = { rotateToken: () => 'x', status: () => ({ enabled: true }) };
  return { api: createEngineApi({ registry, router, manager, hermes, gateway }), registry, manager, hermes, fake, dataDir, core, close: () => fake.close() };
}

test('errorResponse maps engine error codes to HTTP statuses; plain errors are 400', () => {
  const m = (code) => errorResponse(new EngineError(code, 'x')).status;
  assert.equal(m(ErrorCode.INVALID), 400); assert.equal(m(ErrorCode.NOT_FOUND), 404); assert.equal(m(ErrorCode.POLICY_DENIED), 403);
  assert.equal(m(ErrorCode.UNAVAILABLE), 503); assert.equal(m(ErrorCode.DISABLED), 409); assert.equal(m(ErrorCode.TIMEOUT), 504);
  assert.equal(errorResponse(new Error('bad')).status, 400);
});

test('GET /engines lists Xoft Core + Hermes with status, health and capabilities; /engines/:id; unknown → 404', async () => {
  const r = await rig();
  const list = (await r.api.listEngines({ query: {} })).body;
  assert.deepEqual(list.engines.map((e) => e.id).sort(), ['hermes', 'xoft-core']);
  const h = list.engines.find((e) => e.id === 'hermes');
  assert.equal(h.health.available, true); assert.ok(h.capabilities.includes('autonomous_tasks')); assert.equal(h.health.dependencies.api_key, true);
  assert.ok(!JSON.stringify(list).includes('test-key'), 'no secrets in engine listings');
  assert.equal((await r.api.getEngine({ params: { id: 'hermes' }, query: { refresh: 'true' } })).body.health.level, 'ready');
  assert.equal((await r.api.getEngine({ params: { id: 'nope' }, query: {} })).status, 404);
  await r.close();
});

test('route preview explains the decision without executing anything; "nothing available" is an answer, not a 500', async () => {
  const r = await rig();
  const coding = (await r.api.routePreview({ body: { goal: GOAL, workingDirectory: tmp() } })).body;
  assert.equal(coding.engine, 'hermes'); assert.ok(coding.chain.includes('xoft-core')); assert.ok(coding.candidates.every((c) => Array.isArray(c.reasons)));
  const noDir = (await r.api.routePreview({ body: { goal: GOAL } })).body;
  assert.equal(noDir.engine, 'xoft-core', 'coding work without a working directory cannot go to Hermes');
  assert.ok(noDir.candidates.find((c) => c.engineId === 'hermes').serveable === false);
  assert.equal((await r.api.routePreview({ body: {} })).status, 400);
  assert.equal((await r.api.routePreview({ body: { goal: 'x', engine: 'ghost' } })).status, 404);
  assert.equal(r.fake.state.runs.size, 0, 'a preview never starts a run');
  r.registry.unregister('xoft-core'); await r.fake.close();
  await r.registry.refresh('hermes');
  const none = await r.api.routePreview({ body: { goal: GOAL, workingDirectory: tmp() } });
  assert.equal(none.status, 200); assert.equal(none.body.engine, null); assert.match(none.body.reason, /No available engine/);
});

test('permissions endpoint documents profiles, schema and autonomy levels', async () => {
  const r = await rig();
  const p = (await r.api.permissions()).body;
  assert.ok(p.permissions.includes('filesystem.delete')); assert.equal(p.profiles.standard.filesystem.delete, false); assert.equal(Object.keys(p.autonomy).length, 6); assert.ok(p.descriptions.full);
  await r.close();
});

test('Hermes settings API: only supported settings, validated, API key refused, applied immediately', async () => {
  const r = await rig();
  const got = (await r.api.hermesSettings()).body;
  assert.equal(got.settings.permissionProfile, 'standard'); assert.equal(got.apiKey.configured, true); assert.ok(!JSON.stringify(got).includes('test-key'));
  const ok = await r.api.hermesUpdateSettings({ body: { maxConcurrentTasks: 3, defaultAutonomy: 4, allowedRoots: [tmp()] } });
  assert.equal(ok.status, 200); assert.equal(ok.body.settings.maxConcurrentTasks, 3); assert.equal(r.hermes.taskPolicy().defaultAutonomy, 4);
  for (const body of [{ maxConcurrentTasks: 'many' }, { nope: 1 }, { apiKey: 'sneaky' }, { permissionProfile: 'root' }, [], null]) assert.equal((await r.api.hermesUpdateSettings({ body })).status, 400, JSON.stringify(body));
  const off = await r.api.hermesUpdateSettings({ body: { enabled: false } });
  assert.equal(off.body.settings.enabled, false); assert.equal(r.registry.health('hermes').level, Availability.DISABLED);
  await r.close();
});

test('Hermes environment / install / bridge / logs / start-stop endpoints answer without needing Hermes installed', async () => {
  const r = await rig();
  const env = (await r.api.hermesEnvironment()).body;
  assert.ok(env.os.platform); assert.ok('installed' in env.hermes);
  const inst = (await r.api.hermesInstall()).body;
  assert.ok(inst.recommended.commands.length); assert.ok(inst.docs.apiServer);
  const logs = (await r.api.hermesLogs({ query: {} })).body; assert.equal(logs.process.running, false); assert.deepEqual(logs.lines, []);
  const br = (await r.api.hermesBridge({ baseUrl: 'http://127.0.0.1:3000' })).body;
  assert.equal(br.serverName, 'xoft'); assert.equal(br.tokenEnvVar, 'XOFT_TOOL_TOKEN');
  assert.equal((await r.api.hermesBridgeRotate()).status, 200);
  const start = await r.api.hermesStart();
  assert.equal(start.status, 200); assert.match(start.body.reason, /already reachable/);
  await r.close();
});

test('Task API: create (202) → get → events → report → cancel; unknown id → 404; bad input → 400/403; fallback visible', async () => {
  const r = await rig(); const wd = tmp();
  r.core.run = async (t, ctx) => { await new Promise((res) => { if (ctx.signal.aborted) res(); ctx.signal.addEventListener('abort', res); setTimeout(res, 800); }); return ctx.signal.aborted ? { status: 'cancelled' } : { status: 'completed', output: 'core ok' }; };
  const bad = await r.api.createTask({ body: { goal: '' } }); assert.equal(bad.status, 400);
  assert.equal((await r.api.createTask({ body: { goal: GOAL, workingDirectory: path.parse(wd).root } })).status, 403);
  assert.equal((await r.api.createTask({ body: { goal: GOAL, engine: 'ghost' } })).status, 404);
  const created = await r.api.createTask({ body: { goal: GOAL, engine: 'xoft-core', workingDirectory: wd } });
  assert.equal(created.status, 202); const id = created.body.task.id;
  await until(() => r.manager.get(id).state === 'running');
  assert.equal((await r.api.getTask({ params: { id } })).body.task.state, 'running');
  assert.ok((await r.api.listTasks({ query: {} })).body.tasks.some((t) => t.id === id));
  assert.ok((await r.api.taskEvents({ params: { id }, query: {} })).body.events.length > 0);
  assert.equal((await r.api.taskReport({ params: { id } })).body.engine, 'xoft-core');
  assert.equal((await r.api.getTask({ params: { id: 'nope' } })).status, 404);
  assert.equal((await r.api.cancelTask({ params: { id }, body: {} })).body.task.state, 'cancelled');
  assert.equal((await r.api.pauseTask({ params: { id }, body: {} })).status, 400, 'cannot pause a finished task');
  assert.equal((await r.api.resumeTask({ params: { id } })).status, 400);
  assert.equal((await r.api.decideTaskApproval({ params: { approvalId: 'zzz' }, body: { decision: 'approve' } })).status, 404);
  await r.close();
});

test('Express glue: every route registered, mutating routes are admin-guarded, literal /hermes paths precede /:id, handler output is sent', async () => {
  const r = await rig(); const routes = [];
  const app = { get: (p, ...h) => routes.push(['GET', p, h]), post: (p, ...h) => routes.push(['POST', p, h]), put: (p, ...h) => routes.push(['PUT', p, h]), all: (p, ...h) => routes.push(['ALL', p, h]) };
  const admin = () => {};
  registerEngineRoutes(app, r.api, { requireAdmin: admin, baseUrlFor: () => 'http://127.0.0.1:3000' });
  const find = (m, p) => routes.find(([mm, pp]) => mm === m && pp === p);
  for (const [m, p] of [['GET', '/api/engines'], ['GET', '/api/engines/:id'], ['POST', '/api/engines/route'], ['PUT', '/api/engines/hermes/settings'], ['POST', '/api/engines/hermes/start'], ['POST', '/api/engine-tasks'], ['GET', '/api/engine-tasks/:id/events'], ['POST', '/api/engine-tasks/:id/cancel'], ['POST', '/api/engine-tasks/:id/rollback']]) assert.ok(find(m, p), `${m} ${p}`);
  for (const [m, p] of [['PUT', '/api/engines/hermes/settings'], ['POST', '/api/engines/hermes/start'], ['POST', '/api/engines/hermes/stop'], ['GET', '/api/engines/hermes/logs'], ['GET', '/api/engines/hermes/bridge'], ['GET', '/api/engines/hermes/environment'], ['POST', '/api/engine-tasks'], ['POST', '/api/engine-tasks/:id/cancel'], ['POST', '/api/engine-tasks/:id/pause'], ['POST', '/api/engine-tasks/:id/resume'], ['POST', '/api/engine-tasks/:id/rollback'], ['POST', '/api/engine-tasks/:id/approvals/:approvalId']]) assert.equal(find(m, p)[2][0], admin, `${m} ${p} must require admin`);
  assert.ok(routes.findIndex(([, p]) => p === '/api/engines/hermes/settings') < routes.findIndex(([, p]) => p === '/api/engines/:id'));
  const sent = {}; const res = { status(c) { sent.status = c; return this; }, json(b) { sent.body = b; return this; } };
  await find('GET', '/api/engines')[2].at(-1)({ params: {}, query: {}, body: {} }, res);
  assert.equal(sent.status, 200); assert.equal(sent.body.engines.length, 2);

  const gw = []; registerToolGatewayRoute({ all: (p, h) => gw.push([p, h]) }, { handleHttp: async (q) => ({ status: 401, headers: { 'WWW-Authenticate': 'Bearer' }, body: { error: 'x' } }) });
  const hdrs = {}; const out = {}; await gw[0][1]({ method: 'POST', headers: {}, body: {}, socket: { remoteAddress: '127.0.0.1' } }, { set: (k, v) => { hdrs[k] = v; }, status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; }, end() { out.ended = true; } });
  assert.equal(gw[0][0], '/engine-bridge/mcp'); assert.equal(out.status, 401); assert.equal(hdrs['WWW-Authenticate'], 'Bearer');
  await r.close();
});

test('Xoft AI tools: engine_run_task is EXTERNAL risk (needs approval at default autonomy), cannot pass custom permission objects, status/cancel/list work', async () => {
  const r = await rig(); const wd = tmp();
  r.core.run = async () => ({ status: 'completed', output: 'core ok' });
  const tools = Object.fromEntries(buildEngineTools({ getManager: () => r.manager, getRegistry: () => r.registry }).map((t) => [t.name, t]));
  assert.equal(tools.engine_run_task.riskLevel, 2); assert.equal(tools.engine_task_status.riskLevel, 0); assert.ok(tools.engine_run_task.inputSchema.properties.permissionProfile.enum);
  assert.ok(!('permissions' in tools.engine_run_task.inputSchema.properties), 'an AI-originated task can name a profile, never craft permissions');
  const started = await tools.engine_run_task.run({ goal: GOAL, engine: 'xoft-core', workingDirectory: wd, permissionProfile: 'full' }, {});
  assert.equal(started.engine, 'xoft-core'); assert.equal(r.manager.get(started.taskId).permissions.pc.control, false, 'engine ceiling still applies');
  await until(() => r.manager.get(started.taskId).state === 'completed');
  const st = await tools.engine_task_status.run({ taskId: started.taskId }, {});
  assert.equal(st.state, 'completed'); assert.equal(st.result.verification, 'unverified');
  await assert.rejects(() => tools.engine_task_status.run({ taskId: 'nope' }, {}), /No engine task/);
  const listed = await tools.engine_list.run({}, {});
  assert.deepEqual(listed.engines.map((e) => e.id).sort(), ['hermes', 'xoft-core']);
  assert.equal(r.manager.get(started.taskId).createdBy, 'xoft-ai');
  await r.close();
});

test('XoftCoreEngine: chat goes through the Orchestrator; planned work through TaskPlanner; honest health (no provider/devices)', async () => {
  const handled = []; const cancelled = [];
  const steps = [{ id: 's1', toolName: 'file_read', status: 'pending', input: { path: '/x' } }];
  const planner = {
    plan: async (g) => (g.includes('impossible') ? { id: 'p0', status: 'blocked', blockedReason: 'no tool', steps: [] } : { id: 'p1', status: 'planned', steps }),
    execute: async () => { steps[0].status = 'running'; await wait(40); steps[0].status = 'completed'; steps[0].result = { text: 'hello' }; return { id: 'p1', status: 'completed', steps }; },
    get: () => ({ id: 'p1', status: steps[0].status === 'completed' ? 'completed' : 'running', steps }),
    cancel: (id) => cancelled.push(id),
  };
  let providers = ['p']; let devices = [{ id: 'd', platform: 'windows', trust: 'trusted', online: true }];
  const core = new XoftCoreEngine({ orchestrator: { handle: async (s, g) => { handled.push([s, g]); return { reply: 'an answer' }; } }, taskPlanner: planner, providerRouter: { configuredProviders: () => providers }, deviceManager: { listDevices: () => devices }, options: { pollIntervalMs: 10 } });
  let h = await core.healthCheck();
  assert.equal(h.available, true); assert.equal(h.dependencies.devices, true);
  assert.equal(core.canServe({ requiredCapabilities: ['filesystem'] }, h), true);
  devices = []; h = await core.healthCheck();
  assert.equal(h.available, true); assert.match(h.reason, /no paired device/); assert.equal(core.canServe({ requiredCapabilities: ['filesystem'] }, h), false); assert.equal(core.canServe({ requiredCapabilities: ['chat'] }, h), true);
  providers = []; h = await core.healthCheck();
  assert.equal(h.available, false); assert.match(h.reason, /no AI provider/); assert.equal(core.status, 'offline');
  providers = ['p']; devices = [{ id: 'd', platform: 'windows', trust: 'trusted', online: true }]; await core.healthCheck();

  const ev = [];
  const chat = await core.execute({ id: 't1', goal: 'hi', analysis: { requiredCapabilities: ['chat'] } }, { onEvent: (e) => ev.push(e) });
  assert.equal(chat.status, 'completed'); assert.equal(chat.output, 'an answer'); assert.equal(handled[0][0], 'engine-task:t1');
  const work = await core.execute({ id: 't2', goal: 'read the file', analysis: { requiredCapabilities: ['filesystem'] } }, { onEvent: (e) => ev.push(e), setEngineRef: () => {} });
  assert.equal(work.status, 'completed'); assert.match(work.summary, /1\/1/);
  assert.ok(ev.some((e) => e.type === 'engine.tool.started' && e.tool === 'file_read')); assert.ok(ev.some((e) => e.type === 'engine.tool.completed'));
  const blocked = await core.execute({ id: 't3', goal: 'do something impossible', analysis: { requiredCapabilities: ['filesystem'] } }, { onEvent() {} });
  assert.equal(blocked.status, 'failed'); assert.match(blocked.error, /cannot plan/);
  assert.ok(core.routingWeight({ simple: true, requiredCapabilities: ['chat'] }) > core.routingWeight({ autonomous: true, longRunning: true, requiredCapabilities: ['coding'] }));
  await core.cancel({ engineRef: { plannerTaskId: 'p1' } }); assert.deepEqual(cancelled, ['p1']);
});
