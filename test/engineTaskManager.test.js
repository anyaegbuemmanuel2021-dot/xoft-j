import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActivityLog } from '../src/activity/ActivityLog.js';
import { ApprovalSystem } from '../src/approval/ApprovalSystem.js';
import { AutonomyManager } from '../src/autonomy/AutonomyManager.js';
import { EventBus } from '../src/events/EventBus.js';
import { Availability, Capability, EngineError, EngineEvent, ErrorCode, TaskState } from '../src/engines/constants.js';
import { Engine } from '../src/engines/Engine.js';
import { EngineRegistry } from '../src/engines/EngineRegistry.js';
import { EngineRouter } from '../src/engines/EngineRouter.js';
import { EngineTaskManager } from '../src/engines/EngineTaskManager.js';
import { EngineTaskStore } from '../src/engines/EngineTaskStore.js';

const ALL = Object.values(Capability);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-etm-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 4000, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await wait(10); }
}
const untilAbort = (ctx) => new Promise((resolve) => { if (ctx.signal.aborted) return resolve(); ctx.signal.addEventListener('abort', resolve, { once: true }); });
const GOAL = 'Fix the failing tests in my repo, run them, and report what changed.';

class ScriptEngine extends Engine {
  constructor(id, script, opts = {}) {
    super({ id, name: id, capabilities: opts.capabilities ?? ALL });
    this.script = script; this.recoverScript = opts.recoverScript ?? null; this.available = true; this.calls = []; this.cancelled = []; this.approvals = []; this.policyOverride = opts.policy ?? {};
    this.waiters = [];
  }
  async healthCheck() { return { available: this.available, level: this.available ? Availability.READY : Availability.OFFLINE, status: 'online', reason: this.available ? null : 'down', dependencies: {}, capabilities: this.capabilities, checkedAt: '' }; }
  taskPolicy() { return { maxConcurrentTasks: 2, timeoutMs: 5000, maxToolCalls: 0, maxRetries: 2, allowedRoots: [], defaultWorkingDirectory: null, permissionProfile: 'developer', defaultAutonomy: 3, nativeToolPolicy: 'enforce', workspaceMode: 'in-place', requiresWorkingDirectory: () => false, ...this.policyOverride }; }
  async execute(task, ctx) { this.calls.push('execute'); return this.script(task, ctx, 'execute'); }
  async recover(task, ctx) { this.calls.push('recover'); return (this.recoverScript ?? this.script)(task, ctx, 'recover'); }
  async resume(task, ctx) { this.calls.push('resume'); return (this.recoverScript ?? this.script)(task, ctx, 'resume'); }
  async cancel(task) { this.cancelled.push(task.id); }
  async pause() {}
  async resolveApproval(task, key, decision) { this.approvals.push({ key, decision }); this.waiters.forEach((w) => w(decision)); this.waiters = []; }
  waitDecision() { return new Promise((r) => this.waiters.push(r)); }
}

function rig(engines, { managerOpts = {}, autonomyLevel } = {}) {
  const dataDir = tmp();
  const activityLog = new ActivityLog({ dataDir }); const eventBus = new EventBus({ activityLog });
  const autonomyManager = new AutonomyManager({ activityLog, eventBus, dataDir });
  if (autonomyLevel !== undefined) autonomyManager.set(autonomyLevel);
  const approvalSystem = new ApprovalSystem({ activityLog, eventBus, autonomyManager, dataDir });
  const registry = new EngineRegistry({ eventBus, activityLog });
  engines.forEach((e, i) => registry.register(e, { priority: 60 - i * 10 }));
  const router = new EngineRouter({ registry, eventBus, activityLog });
  const store = new EngineTaskStore({ dataDir });
  const emitted = []; eventBus.on('*', (e) => emitted.push(e.type));
  const manager = new EngineTaskManager({ registry, router, store, eventBus, activityLog, approvalSystem, autonomyManager, recoveryBackoffMs: 10, progressFlushMs: 20, ...managerOpts });
  return { dataDir, activityLog, eventBus, autonomyManager, approvalSystem, registry, router, store, manager, emitted };
}
// 'paused' only counts as settled once the manager has stopped working on the task (a pause during an automatic recovery attempt is interim).
const finalState = (r, id) => until(() => { const t = r.manager.get(id); const busy = r.manager.queueStatus().running.includes(id); return ['completed', 'failed', 'cancelled'].includes(t.state) || (t.state === 'paused' && !busy) ? t : null; }, { label: `task ${id} to settle` });

test('happy path: queued → … → completed, events persisted + published, honest "unverified" when no test was observed', async () => {
  const wd = tmp(); const file = path.join(wd, 'a.js');
  const e = new ScriptEngine('script', async (_t, ctx) => {
    ctx.setEngineRef({ runId: 'r1' });
    ctx.onEvent({ type: EngineEvent.TOOL_STARTED, tool: 'write_file', preview: JSON.stringify({ path: file }) });
    ctx.onEvent({ type: EngineEvent.TOOL_COMPLETED, tool: 'write_file', input: JSON.stringify({ path: file }) });
    return { status: 'completed', output: 'I changed a.js', summary: 'changed a.js' };
  });
  const r = rig([e]);
  const t = await r.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd });
  assert.equal(t.state, TaskState.QUEUED);
  assert.equal(t.engine, 'script');
  const done = await finalState(r, t.id);
  assert.equal(done.state, TaskState.COMPLETED);
  assert.equal(done.result.verification.status, 'unverified', 'no test/build command was observed → must not claim verified');
  assert.match(done.result.verification.statement, /NOT independently verified/);
  assert.equal(done.progress.toolCalls, 1);
  assert.deepEqual(done.progress.filesChanged.map((f) => f.path), [file]);
  const states = r.store.events(t.id, { types: ['state'] }).map((x) => x.state);
  assert.deepEqual(states.filter((s, i) => s !== states[i - 1]), ['queued', 'initializing', 'running', 'completed'].filter((s) => s !== 'queued'));
  for (const ev of [EngineEvent.TASK_CREATED, EngineEvent.TASK_STARTED, EngineEvent.TASK_COMPLETED, EngineEvent.TASK_STATE, EngineEvent.TOOL_STARTED, EngineEvent.FILE_CREATED]) assert.ok(r.emitted.includes(ev), `published ${ev}`);
  const rep = r.manager.report(t.id);
  assert.equal(rep.toolCalls, 1); assert.equal(rep.state, 'completed'); assert.ok(rep.durationMs >= 0);
});

test('verification: observed passing test → verified; failing last test → task FAILED even though the engine said done', async () => {
  const mk = (ok) => new ScriptEngine('script', async (_t, ctx) => {
    ctx.onEvent({ type: EngineEvent.TOOL_STARTED, tool: 'terminal', preview: '{"command":"npm test"}' });
    ctx.onEvent(ok ? { type: EngineEvent.TOOL_COMPLETED, tool: 'terminal', command: 'npm test' } : { type: EngineEvent.TOOL_FAILED, tool: 'terminal', command: 'npm test', error: 'exit 1' });
    return { status: 'completed', output: 'All fixed!' };
  });
  const wd = tmp();
  const good = rig([mk(true)]); const g = await good.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd });
  const gd = await finalState(good, g.id);
  assert.equal(gd.state, 'completed'); assert.equal(gd.result.verification.status, 'verified'); assert.equal(gd.result.verification.lastTestPassed, true);

  const bad = rig([mk(false)]); const b = await bad.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd });
  const bd = await finalState(bad, b.id);
  assert.equal(bd.state, 'failed'); assert.equal(bd.errorCode, 'verification_failed'); assert.equal(bd.result.verification.status, 'failed');
  assert.match(bd.error, /last test/);
});

test('routing: unavailable preferred engine falls back at creation; engine failing BEFORE any work falls back mid-run', async () => {
  const hermes = new ScriptEngine('hermes', async () => { throw new EngineError(ErrorCode.UNAVAILABLE, 'connection refused', { retryable: true }); });
  const core = new ScriptEngine('xoft-core', async () => ({ status: 'completed', output: 'core did it' }));
  const r = rig([core, hermes]); const wd = tmp();
  hermes.available = false;
  const t1 = await r.manager.createTask({ goal: GOAL, engine: 'hermes', workingDirectory: wd });
  assert.equal(t1.engine, 'xoft-core'); assert.equal(t1.routing.fallbackFrom, 'hermes');
  assert.equal((await finalState(r, t1.id)).state, 'completed');

  hermes.available = true; await r.registry.refresh('hermes');
  const t2 = await r.manager.createTask({ goal: GOAL, engine: 'hermes', workingDirectory: wd });
  assert.equal(t2.engine, 'hermes');
  const d2 = await finalState(r, t2.id);
  assert.equal(d2.state, 'completed'); assert.equal(d2.engine, 'xoft-core', 'ran on the fallback engine');
  assert.equal(d2.routing.fallbackFrom, 'hermes');
  assert.ok(r.emitted.includes(EngineEvent.ENGINE_FALLBACK));
  assert.equal(d2.result.output, 'core did it');
});

test('recovery: engine crashes mid-run → state saved, recovery attempted, run re-attached via recover() — no duplicate start', async () => {
  let first = true;
  const e = new ScriptEngine('script', async (_t, ctx) => {
    ctx.setEngineRef({ runId: 'r1', sessionId: 's1', generation: 1 });
    ctx.onEvent({ type: EngineEvent.TOOL_STARTED, tool: 'write_file', preview: '{"path":"/w/x.js"}' });
    if (first) { first = false; throw new EngineError(ErrorCode.UNAVAILABLE, 'Hermes crashed', { retryable: true }); }
    return { status: 'completed', output: 'x' };
  }, { policy: { nativeToolPolicy: 'off' }, recoverScript: async () => ({ status: 'completed', output: 'recovered output' }) });
  const r = rig([e]); const wd = tmp();
  const t = await r.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd });
  const d = await finalState(r, t.id);
  assert.equal(d.state, 'completed'); assert.equal(d.result.output, 'recovered output');
  assert.deepEqual(e.calls, ['execute', 'recover'], 'recovery re-attaches; it does not start the task again');
  assert.ok(r.emitted.includes(EngineEvent.TASK_RECOVERY));
  assert.ok(r.store.events(t.id, { types: ['state'] }).some((s) => s.state === 'paused' && /unavailable/.test(s.reason)), 'the pause + reason was recorded while recovering');
});

test('recovery impossible → task PAUSED with the reason recorded (never silently lost) and can be resumed later', async () => {
  let broken = true;
  const e = new ScriptEngine('script', async (_t, ctx) => {
    ctx.setEngineRef({ runId: 'r1', generation: 1 });
    ctx.onEvent({ type: EngineEvent.TOOL_STARTED, tool: 'write_file', preview: '{"path":"/w/x.js"}' });
    if (broken) throw new EngineError(ErrorCode.UNAVAILABLE, 'gateway down', { retryable: true });
    return { status: 'completed', output: 'back' };
  }, { policy: { nativeToolPolicy: 'off' } });
  const r = rig([e]); const wd = tmp();
  const t = await r.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd });
  const d = await finalState(r, t.id);
  assert.equal(d.state, TaskState.PAUSED);
  assert.match(d.stateReason, /Recovery failed after 2 attempt/);
  assert.equal(d.progress.toolCalls >= 1, true);
  assert.ok(r.activityLog.query({}).some((x) => x.type === 'engine_task_paused'), 'the user-facing audit trail records it');

  e.available = false;
  await assert.rejects(() => r.manager.resume(t.id), (err) => err.code === ErrorCode.UNAVAILABLE);
  e.available = true; broken = false;
  await r.manager.resume(t.id);
  const d2 = await finalState(r, t.id);
  assert.equal(d2.state, 'completed'); assert.equal(d2.result.output, 'back');
  assert.ok(e.calls.includes('recover'), 'resume of a task with an engine run reference re-attaches');
});

test('policy: a native tool that breaks the permission profile stops the task (enforce) — and only warns in monitor mode', async () => {
  const script = async (_t, ctx) => {
    ctx.onEvent({ type: EngineEvent.TOOL_STARTED, tool: 'terminal', preview: '{"command":"rm -rf /work/old-build"}' });
    await Promise.race([untilAbort(ctx), wait(300)]);
    return ctx.signal.aborted ? { status: 'cancelled' } : { status: 'completed', output: 'went through' };
  };
  const wd = tmp();
  const enforce = rig([new ScriptEngine('script', script, { policy: { permissionProfile: 'standard', nativeToolPolicy: 'enforce' } })]);
  const a = await enforce.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd });
  const da = await finalState(enforce, a.id);
  assert.equal(da.state, 'failed'); assert.equal(da.errorCode, 'policy_violation');
  assert.match(da.error, /destructive|filesystem\.delete/);
  assert.ok(enforce.emitted.includes(EngineEvent.POLICY_VIOLATION));
  assert.ok(enforce.store.events(a.id, { types: [EngineEvent.POLICY_VIOLATION] }).length >= 1);

  const monitor = rig([new ScriptEngine('script', script, { policy: { permissionProfile: 'standard', nativeToolPolicy: 'monitor' } })]);
  const m = await monitor.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd });
  const dm = await finalState(monitor, m.id);
  assert.equal(dm.state, 'completed'); assert.equal(dm.progress.warnings, 1);

  const granted = rig([new ScriptEngine('script', script, { policy: { permissionProfile: 'developer', nativeToolPolicy: 'enforce' } })]);
  const g = await granted.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd, permissions: { base: 'developer' } });
  assert.equal((await finalState(granted, g.id)).state, 'completed', 'with filesystem.delete granted the same command is allowed');
});

test('permissions: effective profile = requested ∩ engine ceiling; autonomy ≤1 forces read-only; global autonomy is a ceiling', async () => {
  const noop = async () => ({ status: 'completed', output: '' });
  const wd = tmp();
  const r = rig([new ScriptEngine('script', noop, { policy: { permissionProfile: 'standard', defaultAutonomy: 3 } })]);
  const wide = await r.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd, permissions: 'full' });
  assert.equal(wide.permissions.filesystem.delete, false, 'asking for more than the engine ceiling grants nothing extra');
  assert.ok(wide.deniedPermissions.includes('pc.control'));
  const obs = await r.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd, autonomy: 1 });
  assert.equal(obs.permissions.terminal.execute, false); assert.equal(obs.permissions.filesystem.read, true); assert.equal(obs.autonomy, 1);
  await assert.rejects(() => r.manager.createTask({ goal: GOAL, engine: 'script', permissions: { root: { all: true } } }), (e) => e.code === ErrorCode.INVALID);
  await assert.rejects(() => r.manager.createTask({ goal: GOAL, engine: 'script', autonomy: 9 }), (e) => e.code === ErrorCode.INVALID);
  await assert.rejects(() => r.manager.createTask({ goal: '   ' }), (e) => e.code === ErrorCode.INVALID);

  const low = rig([new ScriptEngine('script', noop, { policy: { defaultAutonomy: 5 } })], { autonomyLevel: 2 });
  const t = await low.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd });
  assert.equal(t.autonomy, 2, 'global autonomy 2 caps the engine default of 5');
});

test('limits: tool-call limit and time limit stop the task with a clear reason; waiting for a human does not count as time', async () => {
  const wd = tmp();
  const spam = new ScriptEngine('script', async (_t, ctx) => { for (let i = 0; i < 50 && !ctx.signal.aborted; i += 1) { ctx.onEvent({ type: EngineEvent.TOOL_STARTED, tool: 'read_file', preview: '{"path":"/w/a"}' }); await wait(2); } return { status: 'cancelled' }; }, { policy: { maxToolCalls: 5, nativeToolPolicy: 'off' } });
  const r1 = rig([spam]); const a = await r1.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd });
  const da = await finalState(r1, a.id);
  assert.equal(da.state, 'failed'); assert.equal(da.errorCode, 'tool_limit'); assert.match(da.error, /5 tool calls/);

  const slow = new ScriptEngine('script', async (_t, ctx) => { await untilAbort(ctx); return { status: 'cancelled' }; });
  const r2 = rig([slow]); const b = await r2.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd, timeoutMs: 150 });
  const db = await finalState(r2, b.id);
  assert.equal(db.state, 'failed'); assert.equal(db.errorCode, 'timeout');

  // waiting for approval pauses the clock
  const asks = new ScriptEngine('script', async (_t, ctx) => {
    ctx.onEvent({ type: EngineEvent.APPROVAL_REQUESTED, approvalKey: 'k', tool: 'terminal', command: 'rm -rf build' });
    const d = await asks.waitDecision(); return { status: 'completed', output: d };
  }, { policy: { permissionProfile: 'developer', timeoutMs: 400 } });
  const r3 = rig([asks]); const c = await r3.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd, timeoutMs: 400 });
  const waiting = await until(() => { const t = r3.manager.get(c.id); return t.state === 'waiting' ? t : null; });
  await wait(700); // longer than the 400 ms limit, spent waiting for a human
  assert.equal(r3.manager.get(c.id).state, 'waiting');
  await r3.manager.decideApproval({ approvalId: waiting.pendingApprovals[0].approvalId, decision: 'approve', patchRecord: true });
  assert.equal((await finalState(r3, c.id)).state, 'completed');
});

test('approvals: human approve/reject goes through Xoft ApprovalSystem and is delivered to the engine; WAITING → RUNNING', async () => {
  for (const decision of ['approve', 'reject']) {
    const e = new ScriptEngine('script', async (_t, ctx) => {
      ctx.onEvent({ type: EngineEvent.APPROVAL_REQUESTED, approvalKey: 'k1', engineApprovalId: 'ea1', tool: 'terminal', command: 'rm -rf old-build', description: 'delete old-build' });
      const d = await e.waitDecision();
      return { status: 'completed', output: `engine saw ${d}` };
    }, { policy: { permissionProfile: 'developer', defaultAutonomy: 3 } });
    const r = rig([e]); const wd = tmp();
    const t = await r.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd });
    const w = await until(() => { const x = r.manager.get(t.id); return x.state === 'waiting' ? x : null; }, { label: 'waiting state' });
    assert.equal(w.pendingApprovals.length, 1);
    const rec = r.approvalSystem.get(w.pendingApprovals[0].approvalId);
    assert.equal(rec.status, 'pending'); assert.equal(rec.metadata.engineTaskId, t.id); assert.match(rec.toolName, /^engine:script:terminal$/);
    assert.equal(rec.riskLevel, 3, 'destructive command → HIGH_IMPACT');
    assert.ok(r.emitted.includes('approval_required'), 'the existing Approvals UI is notified');

    r.approvalSystem[decision === 'approve' ? 'approve' : 'reject'](rec.id);
    const out = await r.manager.decideApproval({ approvalId: rec.id, decision });
    assert.equal(out.delivered, true);
    const d = await finalState(r, t.id);
    assert.equal(d.state, 'completed');
    assert.equal(e.approvals[0].decision, decision === 'approve' ? 'once' : 'deny');
    assert.equal(d.result.output, `engine saw ${decision === 'approve' ? 'once' : 'deny'}`);
    assert.equal(d.pendingApprovals.length, 0);
    assert.equal(d.approvals[0].decision, decision);
  }
});

test('approvals: autonomy decides — level ≥4 auto-approves ordinary actions but never destructive ones; level ≤1 and policy violations are denied', async () => {
  const run = async (autonomy, cmd, profile = 'developer') => {
    const e = new ScriptEngine('script', async (_t, ctx) => {
      ctx.onEvent({ type: EngineEvent.APPROVAL_REQUESTED, approvalKey: 'k', tool: 'terminal', command: cmd });
      await wait(120);
      return { status: 'completed', output: 'x' };
    }, { policy: { permissionProfile: profile, nativeToolPolicy: 'monitor' } });
    const r = rig([e], { autonomyLevel: 5 }); const wd = tmp();
    const t = await r.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd, autonomy });
    await until(() => e.approvals.length || r.manager.get(t.id).state === 'waiting');
    const task = r.manager.get(t.id);
    return { decision: e.approvals[0]?.decision ?? null, state: task.state, pending: task.pendingApprovals.length, approvals: task.approvals };
  };
  const auto = await run(4, 'npm install left-pad'); assert.equal(auto.decision, 'once'); assert.equal(auto.approvals[0].decidedBy, 'policy');
  const destructive = await run(5, 'rm -rf build'); assert.equal(destructive.decision, null, 'destructive always needs a human, even at level 5'); assert.equal(destructive.pending, 1);
  const ask = await run(3, 'npm install left-pad'); assert.equal(ask.decision, null); assert.equal(ask.pending, 1);
  const observe = await run(1, 'npm install left-pad'); assert.equal(observe.decision, 'deny');
  const denied = await run(5, 'rm -rf build', 'standard'); assert.equal(denied.decision, 'deny', 'cannot approve past a permission the profile does not grant');
});

test('cancel: running task is aborted and the engine told to stop; queued task is cancelled without ever starting; paused task cancels too', async () => {
  const e = new ScriptEngine('script', async (_t, ctx) => { ctx.setEngineRef({ runId: 'r1' }); await untilAbort(ctx); return { status: 'cancelled' }; }, { policy: { maxConcurrentTasks: 1 } });
  const r = rig([e]); const wd = tmp();
  const a = await r.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd });
  const b = await r.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd });
  await until(() => r.manager.get(a.id).state === 'running');
  assert.equal(r.manager.get(b.id).state, 'queued', 'engine concurrency limit of 1 keeps the second task queued');
  const cb = await r.manager.cancel(b.id);
  assert.equal(cb.state, 'cancelled'); assert.equal(e.calls.length, 1);
  const ca = await r.manager.cancel(a.id);
  assert.equal(ca.state, 'cancelled'); assert.deepEqual(e.cancelled, [a.id]);
  assert.ok(r.emitted.includes(EngineEvent.TASK_CANCELLED));
  const again = await r.manager.cancel(a.id); assert.equal(again.state, 'cancelled', 'cancelling a finished task is a no-op');
  await assert.rejects(() => r.manager.cancel('nope'), (err) => err.code === ErrorCode.NOT_FOUND);
});

test('pause then resume continues the same task through the engine resume() path', async () => {
  const e = new ScriptEngine('script', async (_t, ctx, mode) => {
    ctx.setEngineRef({ runId: mode === 'execute' ? 'r1' : 'r2', generation: mode === 'execute' ? 1 : 2 });
    if (mode === 'execute') { await untilAbort(ctx); return { status: 'cancelled' }; }
    return { status: 'completed', output: 'finished after resume' };
  });
  const r = rig([e]); const wd = tmp();
  const t = await r.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd });
  await until(() => r.manager.get(t.id).state === 'running');
  const paused = await r.manager.pause(t.id);
  assert.equal(paused.state, 'paused'); assert.equal(paused.stateReason, 'paused by user');
  await r.manager.resume(t.id);
  const d = await finalState(r, t.id);
  assert.equal(d.state, 'completed'); assert.deepEqual(e.calls, ['execute', 'resume']);
  assert.equal(d.engineRef.generation, 2);
  await assert.rejects(() => r.manager.pause(t.id), (err) => err.code === ErrorCode.INVALID);
  const noPause = rig([new ScriptEngine('np', async (_t, c) => { await untilAbort(c); return { status: 'cancelled' }; }, { capabilities: [Capability.CHAT] })]);
  const x = await noPause.manager.createTask({ goal: 'hello there', engine: 'np' });
  await until(() => noPause.manager.get(x.id).state === 'running');
  await assert.rejects(() => noPause.manager.pause(x.id), (err) => err.code === ErrorCode.NOT_SUPPORTED);
  await noPause.manager.cancel(x.id);
});

test('concurrency: global limit queues extra tasks and they start as slots free up; high priority jumps the queue', async () => {
  const order = []; const gates = [];
  const e = new ScriptEngine('script', async (t) => { order.push(t.goal); await new Promise((res) => gates.push(res)); return { status: 'completed', output: t.goal }; }, { policy: { maxConcurrentTasks: 5 } });
  const r = rig([e], { managerOpts: { maxConcurrent: 1 } }); const wd = tmp();
  const t1 = await r.manager.createTask({ goal: `${GOAL} one`, engine: 'script', workingDirectory: wd });
  await until(() => order.length === 1);
  const t2 = await r.manager.createTask({ goal: `${GOAL} two`, engine: 'script', workingDirectory: wd, priority: 'low' });
  const t3 = await r.manager.createTask({ goal: `${GOAL} three`, engine: 'script', workingDirectory: wd, priority: 'high' });
  assert.equal(r.manager.get(t2.id).state, 'queued'); assert.equal(r.manager.get(t3.id).state, 'queued');
  assert.equal(r.manager.activeCount(), 1);
  gates.shift()(); await until(() => order.length === 2);
  assert.match(order[1], /three$/, 'high priority ran before the older low-priority task');
  gates.shift()(); await until(() => order.length === 3); gates.shift()();
  for (const t of [t1, t2, t3]) assert.equal((await finalState(r, t.id)).state, 'completed');
});

test('working directory rules: must exist, no protected/system/too-broad paths, must be inside allowed roots; required for coding work', async () => {
  const e = new ScriptEngine('script', async () => ({ status: 'completed', output: '' }), { policy: { requiresWorkingDirectory: (a) => a.requiredCapabilities.includes(Capability.CODING) } });
  const r = rig([e]);
  const base = tmp(); const proj = path.join(base, 'proj'); fs.mkdirSync(proj);
  const bad = async (wd, code, re) => assert.rejects(() => r.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd }), (err) => err.code === code && re.test(err.message));
  await bad(path.join(base, 'ghost'), ErrorCode.INVALID, /does not exist/);
  fs.writeFileSync(path.join(base, 'f.txt'), 'x'); await bad(path.join(base, 'f.txt'), ErrorCode.INVALID, /not a directory/);
  const ssh = path.join(base, '.ssh'); fs.mkdirSync(ssh); await bad(ssh, ErrorCode.POLICY_DENIED, /protected/);
  await bad(path.parse(base).root, ErrorCode.POLICY_DENIED, /too broad/);
  await bad(os.homedir(), ErrorCode.POLICY_DENIED, /too broad/);
  await assert.rejects(() => r.manager.createTask({ goal: GOAL, engine: 'script' }), (err) => err.code === ErrorCode.INVALID && /workingDirectory is required/.test(err.message));
  const ok = await r.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: proj });
  assert.equal(ok.workingDirectory, proj); assert.deepEqual(ok.allowedRoots, [proj]);

  const rooted = rig([new ScriptEngine('script', async () => ({ status: 'completed', output: '' }), { policy: { allowedRoots: [proj] } })]);
  const inside = path.join(proj, 'sub'); fs.mkdirSync(inside);
  assert.equal((await rooted.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: inside })).workingDirectory, inside);
  await assert.rejects(() => rooted.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: base }), (err) => err.code === ErrorCode.POLICY_DENIED && /outside the allowed/.test(err.message));
});

test('security: secrets in events/results are never written to the task log or record', async () => {
  const key = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  const e = new ScriptEngine('script', async (_t, ctx) => {
    ctx.onEvent({ type: EngineEvent.TOOL_STARTED, tool: 'terminal', preview: `{"command":"curl -H 'Authorization: Bearer ${key}' https://x"}` });
    ctx.onEvent({ type: EngineEvent.MESSAGE, text: `my key is ${key}` });
    return { status: 'completed', output: `used ${key}` };
  }, { policy: { nativeToolPolicy: 'off' } });
  const r = rig([e]); const wd = tmp();
  const t = await r.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd });
  const d = await finalState(r, t.id);
  const everything = JSON.stringify([d, r.store.events(t.id), r.activityLog.query({})]);
  assert.ok(!everything.includes(key), 'API key must not appear anywhere persisted');
  assert.ok(everything.includes('[REDACTED'));
});

test('restart recovery: unfinished tasks are paused with a reason, then re-attached (run known) or restarted (no run yet); queued tasks are re-queued', async () => {
  const dataDir = tmp();
  const mk = () => {
    const activityLog = new ActivityLog({ dataDir }); const eventBus = new EventBus({ activityLog });
    const e = new ScriptEngine('script', async (t) => ({ status: 'completed', output: `fresh ${t.id.slice(0, 4)}` }), { recoverScript: async () => ({ status: 'completed', output: 're-attached' }) });
    const registry = new EngineRegistry({ eventBus }); registry.register(e);
    const store = new EngineTaskStore({ dataDir });
    const manager = new EngineTaskManager({ registry, router: new EngineRouter({ registry }), store, eventBus, activityLog, recoveryBackoffMs: 10, progressFlushMs: 20 });
    return { e, store, manager, activityLog };
  };
  const first = mk(); const wd = tmp();
  const withRun = await first.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd }, { start: false });
  const noRun = await first.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd }, { start: false });
  const queued = await first.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd }, { start: false });
  first.store.update(withRun.id, { state: 'running', engineRef: { runId: 'r9', generation: 1 }, mode: 'execute' });
  first.store.update(noRun.id, { state: 'initializing' });
  first.store.update(first.manager.get(queued.id).id, { state: 'queued' });
  const done = await first.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd }, { start: false });
  first.store.update(done.id, { state: 'completed' });

  // "Xoft restarts": a brand new manager over the same data directory
  const second = mk();
  const rec = await second.manager.recoverOnStartup();
  assert.deepEqual(Object.fromEntries(rec.map((x) => [x.id, x.action])), { [withRun.id]: 'recovering', [noRun.id]: 'restarting', [queued.id]: 'requeued' });
  for (const id of [withRun.id, noRun.id, queued.id]) assert.equal((await finalState({ manager: second.manager }, id)).state, 'completed');
  assert.equal(second.manager.get(withRun.id).result.output, 're-attached');
  assert.equal(second.manager.get(done.id).state, 'completed');
  assert.ok(second.store.events(withRun.id, { types: ['state'] }).some((s) => s.state === 'paused' && /Xoft restarted/.test(s.reason)), 'the interruption was recorded');

  const third = mk(); // with auto-resume disabled they stay paused for a human
  const x = await third.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd }, { start: false });
  third.store.update(x.id, { state: 'running' });
  const rec3 = await mk().manager.recoverOnStartup({ resume: false });
  assert.ok(rec3.some((y) => y.id === x.id && y.action === 'paused'));
});

test('shutdown detaches running tasks as PAUSED (recoverable) instead of failing them', async () => {
  const e = new ScriptEngine('script', async (_t, ctx) => { ctx.setEngineRef({ runId: 'r1' }); await untilAbort(ctx); return { status: 'cancelled' }; });
  const r = rig([e]); const wd = tmp();
  const t = await r.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd });
  await until(() => r.manager.get(t.id).state === 'running');
  await r.manager.shutdown({ waitMs: 2000 });
  const d = r.manager.get(t.id);
  assert.equal(d.state, 'paused'); assert.match(d.stateReason, /shutting down/);
  assert.equal(e.cancelled.length, 0, 'shutdown must not tell the engine to stop the run');
});

test('emergency stop blocks new engine tasks', async () => {
  const e = new ScriptEngine('script', async () => ({ status: 'completed', output: '' }));
  const r = rig([e], { managerOpts: { emergencyStop: { isActive: () => true } } });
  await assert.rejects(() => r.manager.createTask({ goal: GOAL, engine: 'script' }), (err) => err.code === ErrorCode.POLICY_DENIED && /Emergency stop/.test(err.message));
});

test('bridge approvals show on the task, move it to WAITING, and clear when decided (no engine delivery)', async () => {
  const e = new ScriptEngine('script', async (_t, ctx) => { await untilAbort(ctx); return { status: 'cancelled' }; });
  const r = rig([e]); const wd = tmp();
  const t = await r.manager.createTask({ goal: GOAL, engine: 'script', workingDirectory: wd });
  await until(() => r.manager.get(t.id).state === 'running');
  r.manager.addBridgeApproval(t.id, { approvalId: 'ap-bridge', tool: 'send_email', summary: 'send_email {...}' });
  assert.equal(r.manager.get(t.id).state, 'waiting');
  const out = await r.manager.decideApproval({ approvalId: 'ap-bridge', decision: 'approve' });
  assert.equal(out.delivered, true); assert.equal(e.approvals.length, 0, 'bridge approvals are consumed by the waiting gateway call, not sent to the engine');
  assert.equal(r.manager.get(t.id).state, 'running');
  await r.manager.cancel(t.id);
});
