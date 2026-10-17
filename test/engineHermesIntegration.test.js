// End-to-end: Xoft task manager → router → HermesEngine → (real HTTP + SSE) → fake Hermes API server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
import { HermesEngine } from '../src/engines/hermes/HermesEngine.js';
import { HermesSettingsStore } from '../src/engines/hermes/HermesSettingsStore.js';
import { startFakeHermes } from './_fakeHermes.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-hint-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 8000, label = 'condition' } = {}) { const end = Date.now() + timeout; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await wait(15); } }
const GOAL = 'Open my project, inspect the authentication system, find the bug, fix it, run the tests and report what you changed.';

class CoreStub extends Engine {
  constructor() { super({ id: 'xoft-core', name: 'Xoft Core', capabilities: Object.values(Capability) }); this.ran = []; }
  async healthCheck() { return { available: true, level: Availability.READY, status: 'online', dependencies: {}, capabilities: this.capabilities, checkedAt: '' }; }
  routingWeight(a) { return a.simple ? 30 : -10; }
  taskPolicy() { return { ...super.taskPolicy(), permissionProfile: 'full', nativeToolPolicy: 'off' }; }
  async execute(task) { this.ran.push(task.id); return { status: 'completed', output: 'handled by Xoft Core' }; }
}

function rig(fake, { env = {}, managerOpts = {} } = {}) {
  const dataDir = tmp();
  const activityLog = new ActivityLog({ dataDir }); const eventBus = new EventBus({ activityLog });
  const autonomyManager = new AutonomyManager({ activityLog, eventBus, dataDir }); autonomyManager.set(5);
  const approvalSystem = new ApprovalSystem({ activityLog, eventBus, autonomyManager, dataDir });
  const hermes = new HermesEngine({ settingsStore: new HermesSettingsStore({ dataDir }), dataDir, activityLog, eventBus, env: { PATH: process.env.PATH, HERMES_HOME: path.join(dataDir, 'nohome'), HERMES_API_URL: fake?.url ?? 'http://127.0.0.1:1', HERMES_API_KEY: 'test-key', HERMES_NATIVE_TOOL_POLICY: 'enforce', HERMES_PERMISSION_PROFILE: 'developer', HERMES_DEFAULT_AUTONOMY: '3', ...env } });
  const core = new CoreStub();
  const registry = new EngineRegistry({ eventBus, activityLog });
  registry.register(core, { priority: 60 }); registry.register(hermes, { priority: 50 });
  const store = new EngineTaskStore({ dataDir });
  const emitted = []; eventBus.on('*', (e) => emitted.push(e.type));
  const manager = new EngineTaskManager({ registry, router: new EngineRouter({ registry, eventBus, activityLog }), store, eventBus, activityLog, approvalSystem, autonomyManager, recoveryBackoffMs: 20, progressFlushMs: 30, ...managerOpts });
  return { dataDir, hermes, core, registry, store, manager, approvalSystem, emitted, activityLog };
}
const settled = (r, id) => until(() => { const t = r.manager.get(id); const busy = r.manager.queueStatus().running.includes(id); return ['completed', 'failed', 'cancelled'].includes(t.state) || (t.state === 'paused' && !busy) ? t : null; }, { label: `task ${id}` });

test('Xoft → Router → Hermes → Result: autonomous coding task is routed to Hermes, streamed live, verified from real events', async () => {
  const wd = tmp();
  const fake = await startFakeHermes({ script: () => [
    { event: 'tool.started', data: { tool: 'read_file', call_id: 'a', preview: JSON.stringify({ path: path.join(wd, 'auth.js') }) } },
    { event: 'tool.completed', data: { tool: 'read_file', call_id: 'a' } },
    { event: 'tool.started', data: { tool: 'patch', call_id: 'b', preview: JSON.stringify({ path: path.join(wd, 'auth.js') }) } },
    { event: 'tool.completed', data: { tool: 'patch', call_id: 'b' } },
    { event: 'tool.started', data: { tool: 'terminal', call_id: 'c', preview: JSON.stringify({ command: 'npm test' }) } },
    { delay: 20, event: 'tool.completed', data: { tool: 'terminal', call_id: 'c' } },
    { event: 'run.completed', data: { output: 'Fixed the token expiry bug in auth.js; npm test passes.' } },
  ] });
  const r = rig(fake); await r.registry.refreshAll();
  const t = await r.manager.createTask({ goal: GOAL, workingDirectory: wd });
  assert.equal(t.engine, 'hermes', 'long-running autonomous coding task goes to Hermes');
  assert.match(t.routing.reason, /hermes/);
  const d = await settled(r, t.id);
  assert.equal(d.state, 'completed');
  assert.equal(d.result.verification.status, 'verified');
  assert.equal(d.result.verification.testsObserved, 1);
  assert.equal(d.progress.toolCalls, 3);
  assert.deepEqual(d.progress.filesChanged.map((f) => f.path), [path.join(wd, 'auth.js')]);
  assert.equal(d.progress.commands[0].command, 'npm test');
  assert.equal(d.engineRef.runId, 'run_1');
  assert.equal(r.core.ran.length, 0);
  for (const ev of [EngineEvent.TOOL_STARTED, EngineEvent.TOOL_COMPLETED, EngineEvent.COMMAND_EXECUTED, EngineEvent.FILE_MODIFIED, EngineEvent.TASK_COMPLETED]) assert.ok(r.emitted.includes(ev), ev);
  assert.ok(r.registry.get('hermes').status === 'online', 'engine goes back to ONLINE when idle');
  await fake.close();
});

test('simple questions stay on Xoft Core even though Hermes is available', async () => {
  const fake = await startFakeHermes(); const r = rig(fake); await r.registry.refreshAll();
  const t = await r.manager.createTask({ goal: 'What is the difference between let and const?' });
  assert.equal(t.engine, 'xoft-core');
  assert.equal((await settled(r, t.id)).result.output, 'handled by Xoft Core');
  assert.equal(fake.state.runs.size, 0);
  await fake.close();
});

test('FALLBACK: Hermes not installed/running → the same request runs on Xoft Core, with the reason on the task', async () => {
  const r = rig(null); await r.registry.refreshAll();
  assert.equal(r.registry.health('hermes').available, false);
  const t = await r.manager.createTask({ goal: GOAL, workingDirectory: tmp(), engine: 'hermes' });
  assert.equal(t.engine, 'xoft-core'); assert.equal(t.routing.fallbackFrom, 'hermes'); assert.match(t.routing.reason, /unavailable/);
  const d = await settled(r, t.id);
  assert.equal(d.state, 'completed'); assert.equal(d.result.output, 'handled by Xoft Core');
  assert.ok(r.emitted.includes(EngineEvent.ENGINE_FALLBACK));
});

test('RECOVERY: Hermes crashes mid-task → Xoft keeps the task, restarts it in the same Hermes session after Hermes returns, and finishes', async () => {
  const wd = tmp(); const file = path.join(wd, 'x.js');
  const fake = await startFakeHermes({ script: (run) => (run.body.input.startsWith('Continue the task') ? [
    { event: 'tool.started', data: { tool: 'terminal', call_id: 'z', preview: JSON.stringify({ command: 'npm test' }) } },
    { event: 'tool.completed', data: { tool: 'terminal', call_id: 'z' } },
    { event: 'run.completed', data: { output: 'Finished after the restart.' } },
  ] : [
    { event: 'tool.started', data: { tool: 'write_file', call_id: 'w', preview: JSON.stringify({ path: file }) } },
    { event: 'tool.completed', data: { tool: 'write_file', call_id: 'w' } },
    { delay: 60, crash: true },
  ]) });
  const r = rig(fake, { env: { HERMES_MAX_RETRIES: '4' } }); await r.registry.refreshAll();
  const t = await r.manager.createTask({ goal: GOAL, workingDirectory: wd });
  assert.equal(t.engine, 'hermes');
  await until(() => r.manager.get(t.id).progress.toolCalls >= 1, { label: 'first tool' });
  await until(() => r.manager.get(t.id).state === 'paused', { label: 'paused while Hermes is down' });
  assert.match(r.manager.get(t.id).stateReason, /unavailable|interrupted|recovery/i);
  await wait(300);
  await fake.restart();                                  // Hermes comes back
  const d = await settled(r, t.id);
  assert.equal(d.state, 'completed', JSON.stringify({ s: d.state, why: d.stateReason, err: d.error }));
  assert.equal(d.result.output, 'Finished after the restart.');
  assert.equal(d.engineRef.generation, 2, 'a second Hermes run continued the work');
  assert.equal(d.engineRef.sessionId, `xoft-${t.id}`);
  const runs = [...fake.state.runs.values()];
  assert.equal(runs.length, 2);
  assert.equal(runs[1].body.session_id, runs[0].body.session_id, 'same Hermes session → the agent keeps its context');
  assert.ok(d.progress.filesChanged.some((f) => f.path === file), 'progress from before the crash was preserved');
  assert.equal(d.result.verification.status, 'verified');
  assert.ok(r.emitted.includes(EngineEvent.TASK_RECOVERY));
  await fake.close();
});

test('RECOVERY exhausted: Hermes never comes back → task is PAUSED with the reason (not lost), resumable once Hermes is back', async () => {
  const wd = tmp();
  const fake = await startFakeHermes({ script: (run) => (run.body.input.startsWith('Continue') ? [{ event: 'run.completed', data: { output: 'resumed' } }] : [{ event: 'tool.started', data: { tool: 'read_file', preview: JSON.stringify({ path: path.join(wd, 'a') }) } }, { delay: 30, crash: true }]) });
  const r = rig(fake, { env: { HERMES_MAX_RETRIES: '1' } }); await r.registry.refreshAll();
  const t = await r.manager.createTask({ goal: GOAL, workingDirectory: wd });
  const d = await settled(r, t.id);
  assert.equal(d.state, 'paused'); assert.match(d.stateReason, /Recovery failed/);
  assert.ok(d.engineRef.runId);
  await assert.rejects(() => r.manager.resume(t.id), (e) => e.code === 'ENGINE_UNAVAILABLE');
  await fake.restart();
  await r.manager.resume(t.id);
  const d2 = await settled(r, t.id);
  assert.equal(d2.state, 'completed'); assert.equal(d2.result.output, 'resumed');
  await fake.close();
});

test('APPROVALS: Hermes asks to delete → task WAITING, Xoft approval created, human approves → decision reaches Hermes, task continues', async () => {
  const wd = tmp();
  const fake = await startFakeHermes({ script: () => [
    { event: 'tool.started', data: { tool: 'terminal', call_id: 'q', preview: JSON.stringify({ command: 'rm -rf old-build' }) } },
    { waitApproval: true, data: { approval_id: 'ap-77', tool: 'terminal', command: 'rm -rf old-build', description: 'Delete old-build/' } },
    { event: 'tool.completed', data: { tool: 'terminal', call_id: 'q' } },
    { event: 'run.completed', data: { output: 'cleaned' } },
  ] });
  const r = rig(fake, { env: { HERMES_NATIVE_TOOL_POLICY: 'monitor' } }); await r.registry.refreshAll();
  const t = await r.manager.createTask({ goal: GOAL, workingDirectory: wd, permissions: 'developer' });
  const w = await until(() => { const x = r.manager.get(t.id); return x.state === 'waiting' ? x : null; }, { label: 'waiting' });
  const approval = r.approvalSystem.get(w.pendingApprovals[0].approvalId);
  assert.equal(approval.status, 'pending'); assert.equal(approval.input.command, 'rm -rf old-build'); assert.equal(approval.metadata.engineTaskId, t.id);
  r.approvalSystem.approve(approval.id);
  await r.manager.decideApproval({ approvalId: approval.id, decision: 'approve' });
  const d = await settled(r, t.id);
  assert.equal(d.state, 'completed');
  assert.equal(fake.state.approvals[0].body.decision, 'once'); assert.equal(fake.state.approvals[0].body.approval_id, 'ap-77');
  await fake.close();
});

test('PERMISSIONS: a native Hermes command the profile forbids stops the run at Hermes (stop endpoint called) and fails the task', async () => {
  const wd = tmp();
  const fake = await startFakeHermes({ script: () => [
    { event: 'tool.started', data: { tool: 'terminal', call_id: 'a', preview: JSON.stringify({ command: 'rm -rf /home/me/Documents' }) } },
    { hang: true },
  ] });
  const r = rig(fake, { env: { HERMES_PERMISSION_PROFILE: 'standard' } }); await r.registry.refreshAll();
  const t = await r.manager.createTask({ goal: GOAL, workingDirectory: wd });
  const d = await settled(r, t.id);
  assert.equal(d.state, 'failed'); assert.equal(d.errorCode, 'policy_violation');
  assert.deepEqual(fake.state.stopped, ['run_1'], 'Xoft told Hermes to stop');
  assert.ok(r.emitted.includes(EngineEvent.POLICY_VIOLATION));
  await fake.close();
});

test('PERMISSIONS: writing outside the working directory and touching .env are stopped too', async () => {
  for (const bad of [{ tool: 'write_file', preview: { path: '/etc/cron.d/evil' } }, { tool: 'read_file', preview: { path: '__WD__/.env' } }]) {
    const wd = tmp();
    const fake = await startFakeHermes({ script: () => [{ event: 'tool.started', data: { tool: bad.tool, preview: JSON.stringify({ path: bad.preview.path.replace('__WD__', wd) }) } }, { hang: true }] });
    const r = rig(fake); await r.registry.refreshAll();
    const t = await r.manager.createTask({ goal: GOAL, workingDirectory: wd });
    const d = await settled(r, t.id);
    assert.equal(d.state, 'failed', bad.tool); assert.equal(d.errorCode, 'policy_violation');
    await fake.close();
  }
});

test('CANCELLATION: cancelling a running Hermes task stops the Hermes run and ends the task as cancelled', async () => {
  const fake = await startFakeHermes({ script: () => [{ event: 'tool.started', data: { tool: 'terminal', preview: JSON.stringify({ command: 'npm run build' }) } }, { hang: true }] });
  const r = rig(fake, { env: { HERMES_NATIVE_TOOL_POLICY: 'off' } }); await r.registry.refreshAll();
  const t = await r.manager.createTask({ goal: GOAL, workingDirectory: tmp() });
  await until(() => r.manager.get(t.id).progress.toolCalls >= 1);
  const c = await r.manager.cancel(t.id);
  assert.equal(c.state, 'cancelled');
  assert.deepEqual(fake.state.stopped, ['run_1']);
  assert.equal(r.registry.get('hermes').status, 'online');
  await fake.close();
});

test('PAUSE/RESUME: pause interrupts the Hermes run; resume continues in the same session', async () => {
  const fake = await startFakeHermes({ script: (run) => (run.body.input.startsWith('Continue') ? [{ event: 'run.completed', data: { output: 'done after resume' } }] : [{ event: 'tool.started', data: { tool: 'terminal', preview: JSON.stringify({ command: 'sleep 1' }) } }, { hang: true }]) });
  const r = rig(fake, { env: { HERMES_NATIVE_TOOL_POLICY: 'off' } }); await r.registry.refreshAll();
  const t = await r.manager.createTask({ goal: GOAL, workingDirectory: tmp() });
  await until(() => r.manager.get(t.id).state === 'running' && r.manager.get(t.id).progress.toolCalls >= 1);
  const p = await r.manager.pause(t.id);
  assert.equal(p.state, 'paused'); assert.equal(fake.state.stopped.length >= 1, true);
  await r.manager.resume(t.id);
  const d = await settled(r, t.id);
  assert.equal(d.state, 'completed'); assert.equal(d.result.output, 'done after resume');
  assert.equal([...fake.state.runs.values()][1].body.session_id, [...fake.state.runs.values()][0].body.session_id);
  await fake.close();
});

test('XOFT RESTART: a task running on Hermes is re-attached by a NEW manager (same data) without starting a second run', async () => {
  const wd = tmp();
  const fake = await startFakeHermes({ script: () => [{ delay: 700, event: 'run.completed', data: { output: 'long job finished' } }] });
  const r1 = rig(fake, { env: { HERMES_NATIVE_TOOL_POLICY: 'off' } }); await r1.registry.refreshAll();
  const t = await r1.manager.createTask({ goal: GOAL, workingDirectory: wd });
  await until(() => r1.manager.get(t.id).engineRef?.runId);
  await r1.manager.shutdown({ waitMs: 1000 });                       // Xoft stops; the Hermes run keeps going
  assert.equal(r1.manager.get(t.id).state, 'paused');
  assert.equal(fake.state.stopped.length, 0, 'shutdown did not stop the Hermes run');

  // new process over the same data directory
  const dataDir = r1.dataDir;
  const activityLog = new ActivityLog({ dataDir }); const eventBus = new EventBus({ activityLog });
  const hermes = new HermesEngine({ settingsStore: new HermesSettingsStore({ dataDir }), dataDir, env: { PATH: process.env.PATH, HERMES_HOME: path.join(dataDir, 'nohome'), HERMES_API_URL: fake.url, HERMES_API_KEY: 'test-key', HERMES_NATIVE_TOOL_POLICY: 'off' } });
  const registry = new EngineRegistry({ eventBus }); registry.register(new CoreStub()); registry.register(hermes);
  const manager = new EngineTaskManager({ registry, router: new EngineRouter({ registry }), store: new EngineTaskStore({ dataDir }), eventBus, activityLog, recoveryBackoffMs: 20 });
  await registry.refreshAll();
  const rec = await manager.recoverOnStartup();
  assert.equal(rec[0].action, 'recovering');
  const d = await settled({ manager }, t.id);
  assert.equal(d.state, 'completed'); assert.equal(d.result.output, 'long job finished');
  assert.equal(fake.state.runs.size, 1, 'exactly one Hermes run existed — recovery re-attached instead of duplicating work');
  await fake.close();
});

test('observability: the report lists tool calls, commands, files, approvals, warnings and the final verification', async () => {
  const wd = tmp();
  const fake = await startFakeHermes({ script: () => [
    { event: 'tool.started', data: { tool: 'terminal', call_id: 'a', preview: JSON.stringify({ command: 'npm test' }) } },
    { event: 'tool.completed', data: { tool: 'terminal', call_id: 'a' } },
    { event: 'tool.started', data: { tool: 'write_file', call_id: 'b', preview: JSON.stringify({ path: path.join(wd, 'n.js') }) } },
    { event: 'tool.completed', data: { tool: 'write_file', call_id: 'b' } },
    { event: 'run.completed', data: { output: 'ok' } },
  ] });
  const r = rig(fake); await r.registry.refreshAll();
  const t = await r.manager.createTask({ goal: GOAL, workingDirectory: wd });
  await settled(r, t.id);
  const rep = r.manager.report(t.id);
  assert.equal(rep.engine, 'hermes'); assert.equal(rep.toolCalls, 2); assert.equal(rep.commands.length, 1); assert.equal(rep.filesChanged.length, 1);
  assert.equal(rep.verification.status, 'verified'); assert.ok(rep.eventCount > 5); assert.equal(rep.state, 'completed');
  const log = r.store.events(t.id);
  assert.ok(log.some((e) => e.type === EngineEvent.COMMAND_EXECUTED && e.command === 'npm test'));
  assert.ok(log.every((e, i) => i === 0 || e.seq > log[i - 1].seq), 'monotonic sequence numbers');
  await fake.close();
});
