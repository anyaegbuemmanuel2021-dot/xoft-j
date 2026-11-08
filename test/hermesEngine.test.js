import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Availability, Capability, EngineEvent, EngineStatus, ErrorCode } from '../src/engines/constants.js';
import { PROFILES } from '../src/engines/EnginePermissions.js';
import { HermesEngine, capabilitiesFromToolsets, readinessFlag } from '../src/engines/hermes/HermesEngine.js';
import { HermesSettingsStore } from '../src/engines/hermes/HermesSettingsStore.js';
import { startFakeHermes } from './_fakeHermes.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-hermes-'));
function makeEngine(fake, env = {}, extra = {}) {
  const dataDir = tmp();
  return new HermesEngine({ settingsStore: new HermesSettingsStore({ dataDir }), dataDir, env: { PATH: process.env.PATH, HERMES_HOME: path.join(dataDir, 'no-hermes-home'), HERMES_API_URL: fake?.url ?? 'http://127.0.0.1:1', HERMES_API_KEY: 'test-key', ...env }, ...extra });
}
const baseTask = (over = {}) => ({ id: 't1', goal: 'fix the bug', autonomy: 3, permissions: PROFILES.standard, workingDirectory: '/work/p', workspace: { cwd: '/work/p' }, engineRef: null, ...over });
const ctxFor = (events, extra = {}) => ({ signal: new AbortController().signal, onEvent: (e) => events.push(e), setEngineRef: (r) => { extra.ref = { ...(extra.ref ?? {}), ...r }; }, ...extra });

test('health: online Hermes → READY with discovered capabilities and dependency map', async () => {
  const fake = await startFakeHermes(); const e = makeEngine(fake);
  const h = await e.healthCheck();
  assert.equal(h.available, true);
  assert.equal(h.level, Availability.READY);
  assert.equal(e.status, EngineStatus.ONLINE);
  assert.equal(h.dependencies.api, true); assert.equal(h.dependencies.api_key, true); assert.equal(h.dependencies.model, true);
  for (const c of [Capability.AUTONOMOUS_TASKS, Capability.CODING, Capability.TERMINAL, Capability.FILESYSTEM, Capability.WEB_SEARCH, Capability.CANCEL, Capability.PAUSE, Capability.RESUME, Capability.APPROVALS]) assert.ok(e.capabilities.includes(c), c);
  assert.ok(!e.capabilities.includes(Capability.BROWSER), 'no browser toolset and no bridge → browser is not claimed');
  assert.ok(!e.capabilities.includes(Capability.PC_CONTROL));
  assert.ok(!e.capabilities.includes(Capability.TOOL_BRIDGE));
  await fake.close();
});

test('health: Hermes not running → OFFLINE with a useful reason and fallback; never throws', async () => {
  const e = makeEngine(null);
  const h = await e.healthCheck();
  assert.equal(h.available, false);
  assert.equal(h.level, Availability.OFFLINE);
  assert.equal(e.status, EngineStatus.OFFLINE);
  assert.match(h.reason, /not installed|not reachable/);
  assert.equal(h.fallback, 'xoft-core');
  assert.deepEqual(e.capabilities, []);
});

test('health: wrong or missing API key → ERROR that says what to set; partially configured model → PARTIAL, unavailable', async () => {
  const fake = await startFakeHermes();
  const noKey = makeEngine(fake, { HERMES_API_KEY: '' });
  const h1 = await noKey.healthCheck();
  assert.equal(h1.available, false); assert.equal(h1.dependencies.api, true); assert.equal(h1.dependencies.api_key, false);
  assert.match(h1.reason, /HERMES_API_KEY/);
  const bad = makeEngine(fake, { HERMES_API_KEY: 'wrong' });
  assert.match((await bad.healthCheck()).reason, /rejected/);

  fake.state.model = 'missing';
  const e = makeEngine(fake);
  const h = await e.healthCheck();
  assert.equal(h.level, Availability.PARTIAL);
  assert.equal(h.available, false);
  assert.equal(h.dependencies.model, false);
  assert.match(h.reason, /hermes setup/);
  await fake.close();
});

test('health: disabled in settings → DISABLED, no network call', async () => {
  const fake = await startFakeHermes(); const e = makeEngine(fake, { HERMES_ENABLED: 'false' });
  const h = await e.healthCheck();
  assert.equal(h.level, Availability.DISABLED); assert.equal(e.status, EngineStatus.DISABLED);
  assert.equal(fake.state.requests.length, 0);
  await fake.close();
});

test('toolset / readiness parsing is defensive', () => {
  assert.equal(capabilitiesFromToolsets({ nope: 1 }), null);
  const c = capabilitiesFromToolsets([{ name: 'browser', enabled: true, tools: ['browser_navigate'] }, { name: 'terminal', enabled: false, tools: ['terminal'] }]);
  assert.equal(c.browser, true); assert.equal(c.terminal, false);
  assert.equal(readinessFlag({ readiness: { checks: [{ name: 'model', status: 'fail' }] } }, /model/), false);
  assert.equal(readinessFlag({ readiness: { checks: { model: { status: 'ok' } } } }, /model/), true);
  assert.equal(readinessFlag({}, /model/), null);
});

test('execute: maps Hermes events, pairs tool start/finish, captures commands and returns the result', async () => {
  const fake = await startFakeHermes({ script: () => [
    { event: 'tool.started', data: { tool: 'terminal', call_id: 'c1', preview: '{"command":"npm test"}' } },
    { delay: 5, event: 'tool.completed', data: { tool: 'terminal', call_id: 'c1', duration: 1.2, preview: 'ok' } },
    { event: 'tool.started', data: { tool: 'write_file', call_id: 'c2', preview: '{"path":"/work/p/a.js"}' } },
    { event: 'tool.completed', data: { tool: 'write_file', call_id: 'c2', error: true, preview: 'EACCES' } },
    { event: 'message.delta', data: { text: 'All ' } }, { event: 'message.delta', data: { text: 'done.' } },
    { event: 'run.completed', data: { output: 'All done.', usage: { total_tokens: 12 } } },
  ] });
  const e = makeEngine(fake); await e.healthCheck();
  const events = []; const holder = {};
  const result = await e.execute(baseTask(), ctxFor(events, holder));
  assert.equal(result.status, 'completed'); assert.equal(result.output, 'All done.'); assert.equal(result.usage.total_tokens, 12);
  const started = events.filter((x) => x.type === EngineEvent.TOOL_STARTED);
  assert.equal(started.length, 2); assert.equal(started[0].tool, 'terminal');
  const done = events.find((x) => x.type === EngineEvent.TOOL_COMPLETED);
  assert.equal(done.command, 'npm test'); assert.equal(done.tool, 'terminal');
  const failed = events.find((x) => x.type === EngineEvent.TOOL_FAILED);
  assert.equal(failed.tool, 'write_file'); assert.ok(failed.error);
  assert.ok(events.some((x) => x.type === EngineEvent.MESSAGE));
  assert.equal(holder.ref.runId, 'run_1'); assert.equal(holder.ref.sessionId, 'xoft-t1'); assert.equal(holder.ref.generation, 1);

  const post = fake.state.requests.find((r) => r.method === 'POST' && r.path === '/v1/runs');
  assert.equal(post.headers['idempotency-key'], 'xoft:t1:1', 'idempotent so a retried start cannot duplicate work');
  assert.equal(post.headers.authorization, 'Bearer test-key');
  const sent = fake.state.runs.get('run_1').body;
  assert.equal(sent.session_id, 'xoft-t1'); assert.equal(sent.input, 'fix the bug');
  assert.match(sent.instructions, /Working directory: \/work\/p/);
  assert.match(sent.instructions, /NOT granted/);
  assert.match(sent.instructions, /Do not claim tests passed/);
  await fake.close();
});

test('execute: failed run → status failed with Hermes error; cancelled run → cancelled', async () => {
  const fake = await startFakeHermes({ script: (run) => (run.body.input.includes('cancel') ? [{ event: 'run.cancelled', data: {} }] : [{ event: 'run.failed', data: { error: 'model quota exceeded' } }]) });
  const e = makeEngine(fake); await e.healthCheck();
  const r1 = await e.execute(baseTask(), ctxFor([]));
  assert.equal(r1.status, 'failed'); assert.match(r1.error, /quota/);
  const r2 = await e.execute(baseTask({ id: 't2', goal: 'cancel me' }), ctxFor([]));
  assert.equal(r2.status, 'cancelled');
  await fake.close();
});

test('abort signal stops the Hermes run (cancel) and returns cancelled; shutdown detaches WITHOUT stopping it', async () => {
  const fake = await startFakeHermes({ script: () => [{ event: 'tool.started', data: { tool: 'terminal', preview: '{"command":"sleep 100"}' } }, { hang: true }] });
  const e = makeEngine(fake); await e.healthCheck();
  const ac = new AbortController(); const events = [];
  const p = e.execute(baseTask(), { ...ctxFor(events), signal: ac.signal, abortReason: () => 'user_cancel' });
  await new Promise((r) => setTimeout(r, 120));
  ac.abort();
  const r = await p;
  assert.equal(r.status, 'cancelled');
  await new Promise((r2) => setTimeout(r2, 50));
  assert.deepEqual(fake.state.stopped, ['run_1']);

  const ac2 = new AbortController();
  const p2 = e.execute(baseTask({ id: 't2' }), { ...ctxFor([]), signal: ac2.signal, abortReason: () => 'shutdown' });
  await new Promise((r2) => setTimeout(r2, 120)); ac2.abort(); await p2;
  await new Promise((r2) => setTimeout(r2, 50));
  assert.deepEqual(fake.state.stopped, ['run_1'], 'a Xoft shutdown must leave the Hermes run alive for re-attachment');
  await fake.close();
});

test('approvals: approval.request becomes APPROVAL_REQUESTED and the decision is delivered to Hermes', async () => {
  const fake = await startFakeHermes({ script: () => [
    { waitApproval: true, data: { approval_id: 'ap1', tool: 'terminal', command: 'rm -rf build', description: 'delete build dir' } },
    { event: 'run.completed', data: { output: 'finished' } },
  ] });
  const e = makeEngine(fake); await e.healthCheck();
  const events = []; const holder = {};
  const task = baseTask();
  const p = e.execute(task, ctxFor(events, holder));
  await new Promise((r) => setTimeout(r, 150));
  const req = events.find((x) => x.type === EngineEvent.APPROVAL_REQUESTED);
  assert.ok(req); assert.equal(req.command, 'rm -rf build'); assert.equal(req.engineApprovalId, 'ap1');
  await e.resolveApproval({ ...task, engineRef: holder.ref }, req.approvalKey, 'once', { approvalId: 'ap1' });
  const r = await p;
  assert.equal(r.status, 'completed');
  assert.equal(fake.state.approvals[0].body.decision, 'once');
  assert.equal(fake.state.approvals[0].body.approval_id, 'ap1');
  await fake.close();
});

test('recover: re-attaches to a live run, takes the result of a finished one, and restarts in the SAME session when the run is gone', async () => {
  let n = 0;
  const fake = await startFakeHermes({ script: (run) => { n += 1; return run.body.input.startsWith('Continue the task') ? [{ event: 'run.completed', data: { output: 'resumed ok' } }] : [{ delay: 300, event: 'run.completed', data: { output: 'first ok' } }]; } });
  const e = makeEngine(fake); await e.healthCheck();
  const holder = {};
  const first = e.execute(baseTask(), ctxFor([], holder));
  await new Promise((r) => setTimeout(r, 60));
  const rec = await e.recover({ ...baseTask(), engineRef: holder.ref }, ctxFor([]));   // run is still alive → re-attach
  assert.equal(rec.status, 'completed'); assert.equal(rec.output, 'first ok');
  await first;
  assert.equal(n, 1, 're-attaching must not start duplicate work');

  const done = await e.recover({ ...baseTask(), engineRef: holder.ref }, ctxFor([]));   // finished → return its output
  assert.equal(done.output, 'first ok'); assert.equal(n, 1);

  const gone = await e.recover({ ...baseTask(), engineRef: { runId: 'run_999', sessionId: 'xoft-t1', generation: 1 } }, ctxFor([], holder));  // 404 → continue in session
  assert.equal(gone.status, 'completed'); assert.equal(gone.output, 'resumed ok');
  const cont = [...fake.state.runs.values()].pop().body;
  assert.equal(cont.session_id, 'xoft-t1', 'same session keeps the agent\'s context');
  assert.match(cont.input, /Continue the task/);
  assert.equal(holder.ref.generation, 2);
  await fake.close();
});

test('resume() always starts a fresh generation in the same session; pause() stops the run', async () => {
  const fake = await startFakeHermes({ script: () => [{ hang: true }] });
  const e = makeEngine(fake); await e.healthCheck();
  const holder = { ref: { runId: 'run_1', sessionId: 'xoft-t1', generation: 1 } };
  const ac = new AbortController();
  const p = e.resume(baseTask({ engineRef: holder.ref }), { ...ctxFor([], holder), signal: ac.signal, abortReason: () => 'pause' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(holder.ref.generation, 2);
  await e.pause({ engineRef: holder.ref }); // explicit pause call on the engine
  ac.abort(); await p;
  assert.ok(fake.state.stopped.length >= 1);
  assert.equal(fake.state.requests.find((r) => r.method === 'POST' && r.path === '/v1/runs').headers['idempotency-key'], 'xoft:t1:2');
  await fake.close();
});

test('execute surfaces an unreachable Hermes as a retryable UNAVAILABLE error (so the task manager can recover or fall back)', async () => {
  const e = makeEngine(null);
  await assert.rejects(() => e.execute(baseTask(), ctxFor([])), (err) => err.code === ErrorCode.UNAVAILABLE && err.retryable === true);
});

test('canServe/routingWeight/taskPolicy reflect settings; coding needs a working directory', async () => {
  const fake = await startFakeHermes(); const e = makeEngine(fake); const h = await e.healthCheck();
  const coding = { requiredCapabilities: [Capability.CODING, Capability.FILESYSTEM], autonomous: true, longRunning: true, simple: false };
  assert.equal(e.canServe({ ...coding, workingDirectory: null }, h), false, 'no working directory → cannot serve (router falls back)');
  assert.equal(e.canServe({ ...coding, workingDirectory: '/p' }, h), true);
  assert.ok(e.routingWeight(coding) > 30);
  assert.ok(e.routingWeight({ simple: true, requiredCapabilities: [Capability.CHAT] }) < -30);
  const pol = e.taskPolicy({ requiredCapabilities: [Capability.CODING] });
  assert.equal(pol.maxConcurrentTasks, 2); assert.equal(pol.requiresWorkingDirectory({ requiredCapabilities: [Capability.CODING] }), true);
  assert.equal(pol.requiresWorkingDirectory({ requiredCapabilities: [Capability.CHAT] }), false);
  await fake.close();
});

test('settings: validated, persisted, secrets are not settings, env is the fallback', async () => {
  const fake = await startFakeHermes(); const e = makeEngine(fake);
  const s = await e.updateSettings({ maxConcurrentTasks: 4, defaultAutonomy: 3, permissionProfile: 'developer', allowedRoots: ['/work'], timeoutMs: 120000 });
  assert.equal(s.maxConcurrentTasks, 4); assert.equal(e.taskPolicy().maxConcurrentTasks, 4);
  await assert.rejects(() => e.updateSettings({ maxConcurrentTasks: 0 }), /maxConcurrentTasks/);
  await assert.rejects(() => e.updateSettings({ defaultAutonomy: 9 }), /defaultAutonomy/);
  await assert.rejects(() => e.updateSettings({ permissionProfile: 'root' }), /Unknown permission profile/);
  await assert.rejects(() => e.updateSettings({ apiKey: 'x' }), /Unknown Hermes setting/);
  await assert.rejects(() => e.updateSettings({ baseUrl: 'ftp://x' }), /http/);
  await assert.rejects(() => e.updateSettings({ environment: { OPENAI_API_KEY: 'x' } }), /not allowed/);
  const saved = JSON.parse(fs.readFileSync(e.settingsStore.file, 'utf8'));
  assert.equal(saved.maxConcurrentTasks, 4);
  assert.ok(!JSON.stringify(saved).includes('test-key'));
  const mode = fs.statSync(e.settingsStore.file).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(mode, 0o600);
  const disabled = await e.updateSettings({ enabled: false });
  assert.equal(disabled.enabled, false); assert.equal(e.status, EngineStatus.DISABLED);
  await fake.close();
});
