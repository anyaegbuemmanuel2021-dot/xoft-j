import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ActivityLog } from '../src/activity/ActivityLog.js';
import { ApprovalSystem } from '../src/approval/ApprovalSystem.js';
import { AutonomyManager } from '../src/autonomy/AutonomyManager.js';
import { EventBus } from '../src/events/EventBus.js';
import { Availability, Capability, EngineEvent } from '../src/engines/constants.js';
import { Engine } from '../src/engines/Engine.js';
import { EngineRegistry } from '../src/engines/EngineRegistry.js';
import { EngineRouter } from '../src/engines/EngineRouter.js';
import { EngineTaskManager } from '../src/engines/EngineTaskManager.js';
import { EngineTaskStore } from '../src/engines/EngineTaskStore.js';
import { createEngineApi, registerEngineRoutes } from '../src/engines/engineApi.js';
import { HermesEngine } from '../src/engines/hermes/HermesEngine.js';
import { HermesSettingsStore } from '../src/engines/hermes/HermesSettingsStore.js';
import { parseArgs, run } from '../scripts/xoft.mjs';
import { startFakeHermes } from './_fakeHermes.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-cli-'));
const GOAL = 'Fix the failing tests in my repo, run them, and report what changed.';

class Core extends Engine {
  constructor() { super({ id: 'xoft-core', name: 'Xoft Core', capabilities: Object.values(Capability) }); this.setStatus('online'); }
  async healthCheck() { return { available: true, level: Availability.READY, status: 'online', dependencies: {}, capabilities: this.capabilities, checkedAt: '' }; }
  routingWeight(a) { return a.simple ? 30 : -10; }
  taskPolicy() { return { ...super.taskPolicy(), permissionProfile: 'developer', nativeToolPolicy: 'off' }; }
  async execute(t, ctx) {
    ctx.onEvent({ type: EngineEvent.TOOL_STARTED, tool: 'read_file', preview: '{"path":"/x"}' });
    ctx.onEvent({ type: EngineEvent.TOOL_COMPLETED, tool: 'read_file' });
    ctx.onEvent({ type: EngineEvent.APPROVAL_REQUESTED, approvalKey: 'k', tool: 'terminal', command: 'npm install' });
    const how = await new Promise((resolve) => { ctx.signal.addEventListener('abort', () => resolve('cancelled')); this.release = () => resolve('done'); });
    return how === 'done' ? { status: 'completed', output: 'all done' } : { status: 'cancelled' };
  }
  async resolveApproval() { this.release?.(); }
}

async function server() {
  const dataDir = tmp(); const fake = await startFakeHermes();
  const activityLog = new ActivityLog({ dataDir }); const eventBus = new EventBus({ activityLog });
  const autonomyManager = new AutonomyManager({ activityLog, eventBus, dataDir }); autonomyManager.set(3);
  const approvalSystem = new ApprovalSystem({ activityLog, eventBus, autonomyManager, dataDir });
  const hermes = new HermesEngine({ settingsStore: new HermesSettingsStore({ dataDir }), dataDir, env: { PATH: process.env.PATH, HERMES_HOME: path.join(dataDir, 'nohome'), HERMES_API_URL: fake.url, HERMES_API_KEY: 'test-key' } });
  const registry = new EngineRegistry({ eventBus, activityLog }); const core = new Core(); registry.register(core, { priority: 60 }); registry.register(hermes, { priority: 50 });
  const manager = new EngineTaskManager({ registry, router: new EngineRouter({ registry, eventBus, activityLog }), store: new EngineTaskStore({ dataDir }), eventBus, activityLog, approvalSystem, autonomyManager, recoveryBackoffMs: 10, progressFlushMs: 20 });
  await registry.refreshAll();
  const api = createEngineApi({ registry, router: manager.router, manager, hermes, gateway: { rotateToken() {}, status: () => ({ enabled: true, tools: 3, connected: false, url: 'http://127.0.0.1:3000/engine-bridge/mcp' }) } });
  const routes = [];
  const guard = (req, res, next) => (req.headers['x-api-key'] === 'admin-key' ? next() : res.status(403).json({ error: 'admin required' }));
  const app = {}; for (const m of ['get', 'post', 'put']) app[m] = (p, ...h) => routes.push({ m: m.toUpperCase(), re: new RegExp(`^${p.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`), names: [...p.matchAll(/:([a-zA-Z]+)/g)].map((x) => x[1]), h });
  registerEngineRoutes(app, api, { requireAdmin: guard, baseUrlFor: () => 'http://127.0.0.1:3000' });
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
      const u = new URL(req.url, 'http://x');
      const route = routes.find((r) => r.m === req.method && r.re.test(u.pathname));
      const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (!route) return send(404, { error: 'no route' });
      const match = route.re.exec(u.pathname);
      const r = { params: Object.fromEntries(route.names.map((n, i) => [n, match[i + 1]])), query: Object.fromEntries(u.searchParams), body: b ? JSON.parse(b) : {}, headers: req.headers };
      const rs = { status(c) { this.code = c; return this; }, json(x) { send(this.code ?? 200, x); } };
      let i = 0; const next = async () => { const h = route.h[i++]; if (h) await h(r, rs, next); };
      await next();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, core, manager, close: async () => { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); await fake.close(); } };
}
const cli = async (s, argv, extra = {}) => {
  const out = []; const err = [];
  const { env, ...rest } = extra;
  const code = await run(argv, { out: (x) => out.push(x), err: (x) => err.push(x), sleep: () => new Promise((r) => setTimeout(r, 20)), ...rest, env: { XOFT_URL: s.url, XOFT_API_KEY: 'admin-key', ...env } });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

test('parseArgs handles flags, values, booleans, -- and quoted goals', () => {
  const p = parseArgs(['run', '--engine', 'hermes', '--dir=/p', '--wait', '--autonomy', '3', 'Fix it']);
  assert.deepEqual(p.positional, ['run', 'Fix it']); assert.equal(p.flags.engine, 'hermes'); assert.equal(p.flags.dir, '/p'); assert.equal(p.flags.wait, true); assert.equal(p.flags.autonomy, '3');
  assert.deepEqual(parseArgs(['a', '--', '--literal']).positional, ['a', '--literal']);
});

test('xoft engines / engine status hermes / route: real HTTP against the engine API', async () => {
  const s = await server();
  const list = await cli(s, ['engines']);
  assert.equal(list.code, 0); assert.match(list.out, /xoft-core\s+online\s+ready/); assert.match(list.out, /hermes\s+online\s+ready/);
  const st = await cli(s, ['engine', 'status', 'hermes']);
  assert.equal(st.code, 0); assert.match(st.out, /Availability: ready/); assert.match(st.out, /api_key=yes/); assert.match(st.out, /autonomous_tasks/);
  const route = await cli(s, ['route', GOAL, '--dir', tmp()]);
  assert.equal(route.code, 0); assert.match(route.out, /→ hermes/);
  const json = await cli(s, ['engines', '--json']); assert.equal(JSON.parse(json.out).engines.length, 2);
  assert.equal((await cli(s, ['engine', 'status', 'ghost'])).code, 1);
  await s.close();
});

test('xoft engine settings: show + change (validated), admin key required', async () => {
  const s = await server();
  const show = await cli(s, ['engine', 'settings']); assert.equal(show.code, 0); assert.match(show.out, /maxConcurrentTasks\s+2/); assert.match(show.out, /API key: set/); assert.ok(!show.out.includes('test-key'));
  const set = await cli(s, ['engine', 'settings', 'maxConcurrentTasks=5', 'defaultAutonomy=4', 'autoStart=true']); assert.equal(set.code, 0);
  assert.match((await cli(s, ['engine', 'settings'])).out, /maxConcurrentTasks\s+5/);
  const bad = await cli(s, ['engine', 'settings', 'maxConcurrentTasks=0']); assert.equal(bad.code, 1); assert.match(bad.err, /maxConcurrentTasks/);
  const noKey = await cli(s, ['engine', 'settings'], { env: { XOFT_API_KEY: '' } }); assert.equal(noKey.code, 1); assert.match(noKey.err, /admin API key is required/);
  await s.close();
});

test('xoft task run → status → approve → logs → completion; stop; unknown prefix', async () => {
  const s = await server(); const wd = tmp();
  const started = await cli(s, ['task', 'run', '--engine', 'xoft-core', '--dir', wd, '--autonomy', '3', 'Fix the failing tests in my repo']);
  assert.equal(started.code, 0); const id = /Task ([0-9a-f-]{36})/.exec(started.out)[1];
  assert.match(started.out, /Engine: xoft-core/);
  await new Promise((r) => setTimeout(r, 300));
  const status = await cli(s, ['task', 'status', id.slice(0, 8)]);
  assert.match(status.out, /AWAITING APPROVAL/); const approvalId = /AWAITING APPROVAL ([0-9a-f-]{36})/.exec(status.out)[1];
  const logs = await cli(s, ['task', 'logs', id.slice(0, 8)]);
  assert.match(logs.out, /engine\.tool\.started\s+read_file/); assert.match(logs.out, /approval\.requested/);
  const approve = await cli(s, ['task', 'approve', id.slice(0, 8), approvalId]);
  assert.equal(approve.code, 0); assert.match(approve.out, /Approved/);
  const done = await cli(s, ['task', 'logs', id, '--follow']);
  assert.equal(done.code, 0); assert.match(done.out, /all done/); assert.match(done.err, /\[completed\]/);
  assert.match((await cli(s, ['task', 'list'])).out, new RegExp(id.slice(0, 8)));
  assert.equal((await cli(s, ['task', 'status', 'ffffffff'])).code, 1);

  const second = await cli(s, ['task', 'run', '--engine', 'xoft-core', '--dir', wd, 'Fix the tests again and rerun them']);
  const id2 = /Task ([0-9a-f-]{36})/.exec(second.out)[1];
  await new Promise((r) => setTimeout(r, 200));
  const stop = await cli(s, ['task', 'stop', id2.slice(0, 8)]); assert.equal(stop.code, 0); assert.match(stop.out, /cancelled/);
  assert.equal((await cli(s, ['task', 'pause', id2.slice(0, 8)])).code, 1);
  await s.close();
});

test('xoft task run --wait follows to the end and returns a non-zero code on failure; engine fallback is reported', async () => {
  const s = await server(); const wd = tmp();
  s.core.execute = async () => ({ status: 'failed', error: 'tests still fail' });
  const r = await cli(s, ['task', 'run', '--engine', 'xoft-core', '--dir', wd, '--wait', 'Fix the failing tests in my repo']);
  assert.equal(r.code, 1); assert.match(r.err, /\[failed\]/); assert.match(r.err, /tests still fail/);
  const bad = await cli(s, ['task', 'run', '--dir', path.parse(wd).root, 'Fix the failing tests in my repo']);
  assert.equal(bad.code, 1); assert.match(bad.err, /too broad|outside/);
  await s.close();
});

test('install: prints the official command, never runs it without --run --yes, runs it only when told to', async () => {
  const s = await server(); const spawned = [];
  const show = await cli(s, ['engine', 'install', 'hermes'], { platform: 'linux', spawnImpl: (...a) => { spawned.push(a); return { on() {} }; } });
  assert.equal(show.code, 0); assert.match(show.out, /curl -fsSL https:\/\/hermes-agent\.nousresearch\.com\/install\.sh \| bash/); assert.equal(spawned.length, 0);
  const win = await cli(s, ['engine', 'install', 'hermes'], { platform: 'win32' }); assert.match(win.out, /install\.ps1/);
  const noYes = await cli(s, ['engine', 'install', 'hermes', '--run'], { spawnImpl: (...a) => { spawned.push(a); return { on() {} }; } });
  assert.equal(noYes.code, 2); assert.match(noYes.err, /--yes/); assert.equal(spawned.length, 0);
  const ran = await cli(s, ['engine', 'install', 'hermes', '--run', '--yes'], { platform: 'linux', spawnImpl: (cmd, args, opts) => { spawned.push([cmd, args, opts]); return { on(ev, cb) { if (ev === 'exit') setTimeout(() => cb(0), 5); } }; } });
  assert.equal(ran.code, 0); assert.equal(spawned[0][0], 'bash'); assert.equal(spawned[0][2].stdio, 'inherit');
  await s.close();
});

test('bridge --show-token reads the local secret file; usage + unknown commands + unreachable server are clean errors', async () => {
  const s = await server(); const dataDir = tmp();
  fs.mkdirSync(path.join(dataDir, 'engines'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'engines', 'engine-secrets.json'), JSON.stringify({ 'xoft-tool-token': { value: 'TOKEN-123' } }));
  const b = await cli(s, ['engine', 'bridge', '--show-token'], { env: { XOFT_DATA_DIR: dataDir } });
  assert.equal(b.code, 0); assert.match(b.out, /mcp_servers:/); assert.match(b.err, /XOFT_TOOL_TOKEN=TOKEN-123/);
  assert.equal((await cli(s, ['wat'])).code, 1);
  assert.equal((await cli(s, ['task', 'run'])).code, 1);
  assert.equal((await cli(s, [])).code, 1);
  const deadErr = []; const dead = await run(['engines'], { env: { XOFT_URL: 'http://127.0.0.1:1' }, out() {}, err: (x) => deadErr.push(x) });
  assert.equal(dead, 1); assert.match(deadErr.join(''), /Cannot reach Xoft/);
  await s.close();
});
