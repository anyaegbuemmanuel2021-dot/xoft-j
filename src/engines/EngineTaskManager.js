import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACTIVE_STATES, EngineError, EngineEvent, ErrorCode, TERMINAL_STATES, TaskState, Capability } from './constants.js';
import {
  clampToAutonomy, deniedPermissions, detectDestructiveCommand, evaluateNativeToolEvent, fileChangeFromToolEvent,
  grantedPermissions, intersectProfiles, normalizeProfile, parseToolPreview,
} from './EnginePermissions.js';
import { isInside, isSensitivePath, redactDeep, redactString } from './redact.js';

const TEST_COMMAND = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check)|node\s+--test|pytest|python3?\s+-m\s+(?:pytest|unittest)|go\s+test|cargo\s+test|mvn\s+(?:-\S+\s+)*test|gradlew?\s+(?:\S+\s+)*test|dotnet\s+test|jest|vitest|mocha|phpunit|ctest|make\s+test|rspec|bundle\s+exec\s+rspec|deno\s+test)\b/i;

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});
/** A timeout used only as the losing side of a race (e.g. "wait up to 15 s for the run to stop"): must not keep the process alive. */
const nap = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

/** Short human description of what an event means ("Running terminal: npm test"). */
export function describeActivity(e) {
  if (!e) return null;
  const { command, paths } = parseToolPreview(e.preview ?? e.input);
  if (e.type === EngineEvent.TOOL_STARTED) {
    if (command) return `Running ${e.tool}: ${redactString(command).split('\n')[0].slice(0, 120)}`;
    if (paths.length) return `${e.tool}: ${paths.slice(0, 2).join(', ').slice(0, 120)}`;
    return `Using ${e.tool}`;
  }
  if (e.type === EngineEvent.MESSAGE && e.text) return redactString(String(e.text)).replace(/\s+/g, ' ').slice(0, 140);
  return null;
}

const emptyProgress = () => ({ currentActivity: null, currentTool: null, currentStep: null, toolCalls: 0, toolsUsed: {}, commands: [], filesChanged: [], errors: 0, warnings: 0, lastMessage: null, lastEventAt: null, completedTools: 0 });

/**
 * EngineTaskManager — runs tasks on engines (spec sections 9, 10, 21–25, 29, 31).
 *
 * It is engine-agnostic: it asks the EngineRouter where to run, prepares a git safety net, enforces the permission
 * profile / autonomy / limits centrally, turns engine events into persisted progress, brokers approvals through the
 * existing ApprovalSystem, keeps tasks alive across engine crashes and Xoft restarts, and verifies results honestly.
 */
export class EngineTaskManager {
  /**
   * @param {object} deps
   * @param {import('./EngineRegistry.js').EngineRegistry} deps.registry
   * @param {import('./EngineRouter.js').EngineRouter} deps.router
   * @param {import('./EngineTaskStore.js').EngineTaskStore} deps.store
   * @param {import('../events/EventBus.js').EventBus} [deps.eventBus]
   * @param {import('../activity/ActivityLog.js').ActivityLog} [deps.activityLog]
   * @param {import('../approval/ApprovalSystem.js').ApprovalSystem} [deps.approvalSystem]
   * @param {import('../autonomy/AutonomyManager.js').AutonomyManager} [deps.autonomyManager]
   * @param {import('./GitWorkspace.js').GitWorkspace} [deps.gitWorkspace]
   * @param {import('../security/EmergencyStop.js').EmergencyStop} [deps.emergencyStop]
   */
  constructor({ registry, router, store, eventBus = null, activityLog = null, approvalSystem = null, autonomyManager = null, gitWorkspace = null, emergencyStop = null, maxConcurrent = 3, recoveryBackoffMs = 2000, progressFlushMs = 1000, resumeOnStartup = true } = {}) {
    Object.assign(this, { registry, router, store, eventBus, activityLog, approvalSystem, autonomyManager, gitWorkspace, emergencyStop });
    this.maxConcurrent = maxConcurrent;
    this.recoveryBackoffMs = recoveryBackoffMs;
    this.progressFlushMs = progressFlushMs;
    this.resumeOnStartup = resumeOnStartup;
    /** @type {string[]} */ this._pending = [];
    /** @type {Map<string, object>} */ this._running = new Map();
    this._shuttingDown = false;
  }

  // ---- public API -----------------------------------------------------------------------------------------

  /**
   * Creates (and queues) a task. Throws EngineError(INVALID|POLICY_DENIED|UNAVAILABLE|NOT_FOUND) when it cannot be accepted.
   * @param {{goal:string, engine?:string, workingDirectory?:string, permissions?:string|object, autonomy?:number, priority?:'high'|'normal'|'low', allowFallback?:boolean, workspaceMode?:string, timeoutMs?:number, requiredCapabilities?:string[], metadata?:object}} input
   * @param {{createdBy?:string, start?:boolean}} [opts]
   */
  async createTask(input = {}, { createdBy = 'user', start = true } = {}) {
    const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
    if (!goal) throw new EngineError(ErrorCode.INVALID, 'goal is required');
    if (goal.length > 20000) throw new EngineError(ErrorCode.INVALID, 'goal is too long (max 20000 characters)');
    if (this.emergencyStop?.isActive?.()) throw new EngineError(ErrorCode.POLICY_DENIED, 'Emergency stop is active — no new engine tasks can be created.');
    if (input.autonomy !== undefined && (!Number.isInteger(input.autonomy) || input.autonomy < 0 || input.autonomy > 5)) throw new EngineError(ErrorCode.INVALID, 'autonomy must be an integer from 0 to 5');
    let requestedProfile;
    try { requestedProfile = input.permissions === undefined ? null : normalizeProfile(input.permissions); } catch (err) { throw new EngineError(ErrorCode.INVALID, err.message); }

    const analysis = this.router.analyze({ goal, workingDirectory: input.workingDirectory ?? null, requiredCapabilities: input.requiredCapabilities });
    const preferred = input.engine && input.engine !== 'auto' ? String(input.engine) : null;
    const decision = await this.router.route(analysis, { preferredEngine: preferred, allowFallback: input.allowFallback !== false });
    const engine = this.registry.get(decision.engineId);
    const policy = engine.taskPolicy(analysis);

    const wd = this._resolveWorkingDirectory(input.workingDirectory, policy, analysis);
    const globalLevel = this.autonomyManager?.get?.().level ?? 5;
    const requestedLevel = input.autonomy ?? policy.defaultAutonomy ?? 2;
    const autonomy = Math.min(requestedLevel, globalLevel); // the global autonomy setting is a ceiling, never a floor
    const ceiling = normalizeProfile(policy.permissionProfile ?? 'standard');
    const permissions = clampToAutonomy(requestedProfile ? intersectProfiles(requestedProfile, ceiling) : ceiling, autonomy);

    const record = this.store.create({
      goal, engine: decision.engineId, requestedEngine: preferred, chain: decision.chain,
      routing: { reason: decision.reason, fallbackFrom: decision.fallbackFrom, candidates: decision.candidates.map(({ engineId, serveable, level, reasons }) => ({ engineId, serveable, level, reasons })) },
      analysis: { requiredCapabilities: analysis.requiredCapabilities, autonomous: analysis.autonomous, longRunning: analysis.longRunning, complexity: analysis.complexity, signals: analysis.signals },
      state: TaskState.QUEUED, stateReason: null, createdBy, priority: ['high', 'normal', 'low'].includes(input.priority) ? input.priority : 'normal',
      workingDirectory: wd?.workingDirectory ?? null, allowedRoots: wd?.allowedRoots ?? [],
      workspaceMode: input.workspaceMode ?? policy.workspaceMode ?? 'in-place', workspace: null,
      permissions, grantedPermissions: grantedPermissions(permissions), deniedPermissions: deniedPermissions(permissions),
      permissionsClampedByAutonomy: autonomy <= 1 && Boolean(requestedProfile || ceiling),
      autonomy, requestedAutonomy: requestedLevel,
      limits: { timeoutMs: Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : policy.timeoutMs, maxToolCalls: policy.maxToolCalls ?? 0, maxRetries: policy.maxRetries ?? 2 },
      attempts: 0, startedAt: null, completedAt: null, engineRef: null, pendingApprovals: [], approvals: [],
      progress: emptyProgress(), result: null, error: null, mode: 'execute', metadata: input.metadata && typeof input.metadata === 'object' ? redactDeep(input.metadata) : null,
    });
    this._log(record.id, { type: 'created', engine: record.engine, routing: record.routing, autonomy, permissions: record.grantedPermissions });
    this._publish(EngineEvent.TASK_CREATED, { taskId: record.id, engineId: record.engine, goal: goal.slice(0, 300), routing: record.routing.reason }, { audit: true });
    if (start) this._enqueue(record.id);
    return this.get(record.id);
  }

  get(id) {
    const rec = this.store.get(id);
    if (!rec) return null;
    const run = this._running.get(id);
    return run ? { ...rec, progress: run.progress, live: true } : rec;
  }
  list(q) { return this.store.list(q).map((t) => (this._running.has(t.id) ? this.get(t.id) : t)); }
  events(id, q) { return this.store.events(id, q); }
  activeCount() { return this._running.size; }
  queueStatus() { return { running: [...this._running.keys()], pending: [...this._pending], maxConcurrent: this.maxConcurrent }; }

  /** Cancels a queued / running / paused / waiting task. Resolves with the final record. */
  async cancel(id, { reason = 'cancelled by user' } = {}) {
    const task = this._require(id);
    if (TERMINAL_STATES.has(task.state)) return task;
    const run = this._running.get(id);
    if (run) {
      run.abortReason = 'user_cancel'; run.abortDetail = reason;
      run.controller.abort();
      const engine = this.registry.has(task.engine) ? this.registry.get(task.engine) : null;
      try { await engine?.cancel(task, { reason }); } catch { /* the run loop handles whatever the engine does on abort */ }
      await Promise.race([run.promise, nap(15000)]);
      return this.get(id);
    }
    this._pending = this._pending.filter((p) => p !== id);
    if (task.engineRef) { try { await this.registry.get(task.engine).cancel(task, { reason }); } catch { /* run may be gone already */ } }
    this._resolvePendingApprovals(task, 'reject');
    this._setState(id, TaskState.CANCELLED, { reason, extra: { completedAt: new Date().toISOString(), pendingApprovals: [] } });
    return this.get(id);
  }

  /** Pauses a running task (engines that support it). The task keeps its session and can be resumed. */
  async pause(id, { reason = 'paused by user' } = {}) {
    const task = this._require(id);
    const run = this._running.get(id);
    if (!run || ![TaskState.RUNNING, TaskState.WAITING].includes(task.state)) throw new EngineError(ErrorCode.INVALID, `Task is ${task.state}; only a running task can be paused`);
    const engine = this.registry.get(task.engine);
    if (!engine.supports(Capability.PAUSE)) throw new EngineError(ErrorCode.NOT_SUPPORTED, `Engine '${engine.name}' does not support pausing`);
    run.abortReason = 'pause'; run.abortDetail = reason;
    run.controller.abort();
    try { await engine.pause(task, { reason }); } catch { /* engine may already have stopped */ }
    await Promise.race([run.promise, nap(15000)]);
    return this.get(id);
  }

  /** Resumes a paused task on the engine that owns its session. */
  async resume(id) {
    const task = this._require(id);
    if (task.state !== TaskState.PAUSED) throw new EngineError(ErrorCode.INVALID, `Task is ${task.state}; only a paused task can be resumed`);
    if (this._running.has(id)) throw new EngineError(ErrorCode.INVALID, 'Task is already running');
    const engine = this.registry.get(task.engine);
    const health = await this.registry.refresh(engine.id);
    if (!health.available) throw new EngineError(ErrorCode.UNAVAILABLE, `Engine '${engine.name}' is ${health.level}${health.reason ? ` (${health.reason})` : ''}; resume once it is back.`, { retryable: true });
    this.store.update(id, { mode: task.engineRef ? (engine.supports(Capability.RESUME) ? 'resume' : 'recover') : 'execute', pendingApprovals: [] });
    this._setState(id, TaskState.QUEUED, { reason: 'resume requested' });
    this._publish(EngineEvent.TASK_RESUMED, { taskId: id, engineId: engine.id }, { audit: true });
    this._enqueue(id);
    return this.get(id);
  }

  /** Called by the approvals API when a human decides an approval that belongs to an engine task. */
  async decideApproval({ approvalId, decision, decidedBy = 'user', patchRecord = false }) {
    if (!['approve', 'reject'].includes(decision)) throw new EngineError(ErrorCode.INVALID, "decision must be 'approve' or 'reject'");
    const task = this.store.list().find((t) => (t.pendingApprovals ?? []).some((a) => a.approvalId === approvalId));
    if (!task) throw new EngineError(ErrorCode.NOT_FOUND, `No engine task is waiting on approval '${approvalId}'`);
    const pending = task.pendingApprovals.find((a) => a.approvalId === approvalId);
    if (patchRecord && this.approvalSystem) { try { decision === 'approve' ? this.approvalSystem.approve(approvalId) : this.approvalSystem.reject(approvalId); } catch { /* record may have been patched already */ } }
    const engine = this.registry.get(task.engine);
    let delivered = true;
    try { if (pending.source !== 'bridge') await engine.resolveApproval(task, pending.key, decision === 'approve' ? 'once' : 'deny', { approvalId: pending.engineApprovalId ?? null }); } catch (err) {
      delivered = false;
      this._log(task.id, { type: EngineEvent.APPROVAL_RESOLVED, approvalId, decision, delivered: false, error: err.message });
    }
    const remaining = task.pendingApprovals.filter((a) => a.approvalId !== approvalId);
    const approvals = [...(task.approvals ?? []), { approvalId, tool: pending.tool, summary: pending.summary, decision, decidedBy, decidedAt: new Date().toISOString(), requestedAt: pending.requestedAt, delivered }].slice(-100);
    this.store.update(task.id, { pendingApprovals: remaining, approvals });
    this._log(task.id, { type: EngineEvent.APPROVAL_RESOLVED, approvalId, decision, delivered });
    this._publish(EngineEvent.APPROVAL_RESOLVED, { taskId: task.id, approvalId, decision, delivered }, { audit: true });
    const run = this._running.get(task.id);
    if (run && remaining.length === 0 && task.state === TaskState.WAITING) this._leaveWaiting(task.id, run);
    return { taskId: task.id, decision, delivered };
  }

  /** Active (running/waiting/initializing) tasks on an engine — the Tool Gateway uses this to find which policy applies. */
  activeTasks(engineId = null) {
    return [...this._running.keys()].map((id) => this.store.get(id)).filter((t) => t && (!engineId || t.engine === engineId) && ACTIVE_STATES.has(t.state));
  }

  /** The Tool Gateway is holding a tool call for a human decision: show it on the task and move it to WAITING. */
  addBridgeApproval(taskId, { approvalId, tool, summary }) {
    const run = this._running.get(taskId);
    const pending = { approvalId, key: null, source: 'bridge', tool, summary: redactString(summary ?? '').slice(0, 300), destructive: false, requestedAt: new Date().toISOString() };
    this.store.update(taskId, (t) => ({ pendingApprovals: [...(t.pendingApprovals ?? []), pending] }));
    this._log(taskId, { type: EngineEvent.APPROVAL_REQUESTED, approvalId, tool, summary: pending.summary, via: 'bridge' });
    this._publish(EngineEvent.APPROVAL_REQUESTED, { taskId, approvalId, tool, summary: pending.summary, via: 'bridge' }, { audit: true });
    if (run) this._enterWaiting(taskId, run, `waiting for approval: ${pending.summary}`);
  }

  /** The gateway call that was waiting has been decided (or abandoned). */
  removeBridgeApproval(taskId, approvalId) {
    const task = this.store.get(taskId);
    if (!task) return;
    const remaining = (task.pendingApprovals ?? []).filter((a) => a.approvalId !== approvalId);
    if (remaining.length === (task.pendingApprovals ?? []).length) return;
    this.store.update(taskId, { pendingApprovals: remaining });
    const run = this._running.get(taskId);
    if (run && remaining.length === 0 && task.state === TaskState.WAITING) this._leaveWaiting(taskId, run);
  }

  /** Audit entry for a Tool Gateway call (not counted as a tool call — Hermes reports the same call in its own stream). */
  noteBridgeCall(taskId, entry) { this._log(taskId, { type: 'bridge.call', ...entry }); }

  /** Human-readable observability report (spec section 23). */
  report(id) {
    const task = this.get(id);
    if (!task) return null;
    const events = this.store.events(id, { limit: 0 });
    const count = (t) => events.filter((e) => e.type === t).length;
    return {
      taskId: task.id, engine: task.engine, goal: task.goal, state: task.state, stateReason: task.stateReason,
      startedAt: task.startedAt, completedAt: task.completedAt,
      durationMs: task.startedAt ? (new Date(task.completedAt ?? Date.now()) - new Date(task.startedAt)) : null,
      toolCalls: task.progress?.toolCalls ?? 0, toolsUsed: task.progress?.toolsUsed ?? {},
      commands: task.progress?.commands ?? [], filesChanged: task.progress?.filesChanged ?? [],
      errors: events.filter((e) => e.type === EngineEvent.TOOL_FAILED || e.type === EngineEvent.ENGINE_ERROR || e.type === 'error').map((e) => ({ at: e.ts, tool: e.tool ?? null, message: e.error ?? e.message ?? null })).slice(-50),
      warnings: events.filter((e) => e.type === EngineEvent.POLICY_VIOLATION).map((e) => ({ at: e.ts, code: e.code, message: e.message })).slice(-50),
      approvals: task.approvals ?? [], pendingApprovals: task.pendingApprovals ?? [],
      recoveries: count(EngineEvent.TASK_RECOVERY), fallbacks: task.routing?.fallbackFrom ? 1 : 0,
      verification: task.result?.verification ?? null, git: task.result?.git ?? null, workspace: task.workspace,
      result: task.result?.summary ?? null, error: task.error, eventCount: events.length,
    };
  }

  async rollback(id) {
    const task = this._require(id);
    if (!TERMINAL_STATES.has(task.state) && task.state !== TaskState.PAUSED) throw new EngineError(ErrorCode.INVALID, 'Stop the task before rolling it back');
    if (!this.gitWorkspace) throw new EngineError(ErrorCode.NOT_SUPPORTED, 'Git workspace support is not enabled');
    const out = await this.gitWorkspace.rollback(task.workspace, id);
    this._log(id, { type: 'rollback', ...out });
    this.activityLog?.log({ type: 'engine_task_rollback', detail: { taskId: id, ...out } });
    return out;
  }

  /** Re-queue unfinished tasks after a Xoft restart (spec section 24). */
  async recoverOnStartup({ resume = this.resumeOnStartup } = {}) {
    const recovered = [];
    for (const task of this.store.list({ limit: 0 }).reverse()) {
      if (this._running.has(task.id) || this._pending.includes(task.id)) continue;
      if (task.state === TaskState.QUEUED) { this._enqueue(task.id); recovered.push({ id: task.id, action: 'requeued' }); continue; }
      const interrupted = ACTIVE_STATES.has(task.state) || (task.state === TaskState.PAUSED && ['shutdown', 'recovery_failed', 'recovering'].includes(task.pauseCause));
      if (!interrupted) continue; // finished tasks and tasks a human paused on purpose are left alone
      const hadRun = Boolean(task.engineRef?.runId);
      if (task.state !== TaskState.PAUSED) this._setState(task.id, TaskState.PAUSED, { reason: 'Xoft restarted while this task was running', extra: { pendingApprovals: [], pauseCause: 'shutdown' } });
      this._log(task.id, { type: EngineEvent.TASK_RECOVERY, phase: 'startup', hadRun });
      if (resume && this.registry.has(task.engine) && (hadRun || task.mode === 'execute')) {
        this.store.update(task.id, { mode: hadRun ? 'recover' : 'execute' });
        this._setState(task.id, TaskState.QUEUED, { reason: 'automatic recovery after restart' });
        this._enqueue(task.id);
        recovered.push({ id: task.id, action: hadRun ? 'recovering' : 'restarting' });
      } else recovered.push({ id: task.id, action: 'paused' });
    }
    if (recovered.length) this.activityLog?.log({ type: 'engine_tasks_recovered', detail: { recovered } });
    return recovered;
  }

  /** Detaches from running tasks (the engine keeps the run where it supports that) so they can be recovered on the next start. */
  async shutdown({ waitMs = 5000 } = {}) {
    this._shuttingDown = true;
    const runs = [...this._running.values()];
    for (const run of runs) { run.abortReason = 'shutdown'; run.controller.abort(); }
    await Promise.race([Promise.allSettled(runs.map((r) => r.promise)), nap(waitMs)]);
  }

  // ---- queue ------------------------------------------------------------------------------------------------

  _enqueue(id) {
    if (this._pending.includes(id) || this._running.has(id)) return;
    this._pending.push(id);
    const rank = { high: 0, normal: 1, low: 2 };
    this._pending.sort((a, b) => (rank[this.store.get(a)?.priority] ?? 1) - (rank[this.store.get(b)?.priority] ?? 1));
    queueMicrotask(() => this._pump());
  }

  _pump() {
    if (this._shuttingDown) return;
    for (const id of [...this._pending]) {
      if (this._running.size >= this.maxConcurrent) break;
      const task = this.store.get(id);
      if (!task || task.state !== TaskState.QUEUED) { this._pending = this._pending.filter((p) => p !== id); continue; }
      const engine = this.registry.has(task.engine) ? this.registry.get(task.engine) : null;
      const cap = engine?.taskPolicy?.()?.maxConcurrentTasks ?? this.maxConcurrent;
      const onEngine = [...this._running.values()].filter((r) => r.engineId === task.engine).length;
      if (onEngine >= cap) continue; // engine is at its own concurrency limit — leave queued, try the next task
      this._pending = this._pending.filter((p) => p !== id);
      const run = { id, engineId: task.engine, controller: new AbortController(), abortReason: null, abortDetail: null, progress: { ...emptyProgress(), ...(task.progress ?? {}) }, timer: null, deadline: 0, waitStarted: null, flushTimer: null, dirty: false, lastCheckpointAt: Date.now() };
      this._running.set(id, run);
      run.promise = this._runTask(id, run).catch((err) => this._failUnexpected(id, err)).finally(() => {
        clearTimeout(run.timer); clearInterval(run.flushTimer);
        this._running.delete(id);
        this._publishEngineBusy(task.engine);
        queueMicrotask(() => this._pump());
      });
      this._publishEngineBusy(task.engine);
    }
  }

  _publishEngineBusy(engineId) {
    const engine = this.registry.has(engineId) ? this.registry.get(engineId) : null;
    engine?.setActiveTasks?.([...this._running.values()].filter((r) => r.engineId === engineId).length);
  }

  // ---- run loop ---------------------------------------------------------------------------------------------

  async _runTask(id, run) {
    let task = this.store.get(id);
    this._setState(id, TaskState.INITIALIZING, { reason: null, extra: { startedAt: task.startedAt ?? new Date().toISOString(), attempts: (task.attempts ?? 0) + 1 } });
    run.flushTimer = setInterval(() => this._flush(id, run), this.progressFlushMs);
    run.flushTimer.unref?.();
    this._armDeadline(id, run, task.limits?.timeoutMs);

    // Git safety net (spec 31) — created once per task, reused on resume/recovery.
    task = this.store.get(id);
    if (!task.workspace) {
      try { await this._prepareWorkspace(id, task); } catch (err) { return this._fail(id, run, `Could not prepare the workspace: ${err.message}`, 'workspace'); }
      task = this.store.get(id);
    }
    if (run.controller.signal.aborted) return this._finishAborted(id, run);

    const chain = task.chain ?? [task.engine];
    let idx = Math.max(0, chain.indexOf(task.engine));
    for (;;) {
      const engine = this.registry.get(chain[idx]);
      if (chain[idx] !== task.engine) { this.store.update(id, { engine: chain[idx] }); run.engineId = chain[idx]; this._publishEngineBusy(chain[idx]); task = this.store.get(id); }
      const outcome = await this._attempt(id, run, engine);
      if (outcome.kind === 'fallback' && idx + 1 < chain.length) {
        const from = chain[idx]; idx += 1;
        const reason = outcome.error?.message ?? 'engine unavailable';
        this._log(id, { type: EngineEvent.ENGINE_FALLBACK, from, to: chain[idx], reason });
        this._publish(EngineEvent.ENGINE_FALLBACK, { taskId: id, from, to: chain[idx], reason }, { audit: true });
        this.store.update(id, (t) => ({ routing: { ...t.routing, fallbackFrom: from, reason: `'${from}' failed before doing any work (${reason}); fell back to '${chain[idx]}'` }, engineRef: null }));
        continue;
      }
      if (outcome.kind === 'fallback') return this._fail(id, run, outcome.error?.message ?? 'engine unavailable and no fallback engine is compatible', 'unavailable');
      return undefined;
    }
  }

  async _attempt(id, run, engine) {
    const state = { sideEffects: false, commands: [], lastCommandsOk: [] };
    run.attemptState = state;
    let task = this.store.get(id);
    let mode = task.mode ?? 'execute';
    this.store.update(id, { mode: 'execute' });
    let tries = 0;

    const ctxFor = (m) => ({
      signal: run.controller.signal,
      abortReason: () => run.abortReason,
      profile: task.permissions,
      cwd: task.workspace?.cwd ?? task.workingDirectory,
      allowedRoots: task.allowedRoots,
      attempt: task.attempts,
      mode: m,
      onEvent: (e) => this._onEngineEvent(id, run, engine, state, e),
      setEngineRef: (ref) => { this.store.update(id, (t) => ({ engineRef: { ...(t.engineRef ?? {}), ...ref } })); },
    });

    for (;;) {
      if (run.controller.signal.aborted) { this._finishAborted(id, run); return { kind: 'done' }; }
      task = this.store.get(id);
      this._setState(id, TaskState.RUNNING, { reason: null });
      this._flush(id, run, true);
      let result;
      try {
        const ctx = ctxFor(mode);
        if (mode === 'resume') result = await engine.resume(task, ctx);
        else if (mode === 'recover') result = await engine.recover(task, ctx);
        else result = await engine.execute(task, ctx);
      } catch (err) {
        if (run.controller.signal.aborted) { this._finishAborted(id, run); return { kind: 'done' }; }
        const recoverable = err instanceof EngineError ? (err.retryable || err.code === ErrorCode.UNAVAILABLE) : false;
        this._log(id, { type: 'error', code: err.code ?? 'ERROR', error: err.message, recoverable });
        run.progress.errors += 1;
        if (!recoverable) { this._fail(id, run, err.message, err.code ?? 'engine_error'); return { kind: 'done' }; }
        if (!state.sideEffects && mode === 'execute' && !this.store.get(id).engineRef?.runId) return { kind: 'fallback', error: err };
        if (tries >= (task.limits?.maxRetries ?? 2)) {
          this._pauseWithReason(id, run, `Recovery failed after ${tries} attempt(s): ${err.message}`);
          return { kind: 'done' };
        }
        tries += 1;
        this._pauseWithReason(id, run, `Engine '${engine.name}' became unavailable: ${err.message} — recovery attempt ${tries}/${task.limits?.maxRetries ?? 2}`, { keepRunning: true });
        this._log(id, { type: EngineEvent.TASK_RECOVERY, phase: 'engine_failure', attempt: tries, error: err.message });
        this._publish(EngineEvent.TASK_RECOVERY, { taskId: id, engineId: engine.id, attempt: tries, error: err.message }, { audit: true });
        await sleep(this.recoveryBackoffMs * 2 ** (tries - 1), run.controller.signal);
        if (run.controller.signal.aborted) { this._finishAborted(id, run); return { kind: 'done' }; }
        try { await engine.ensureAvailable?.({ task }); } catch (e) { this._log(id, { type: 'warning', message: `engine restart failed: ${e.message}` }); }
        await this.registry.refresh(engine.id);
        mode = this.store.get(id).engineRef?.runId ? 'recover' : 'execute';
        continue;
      }
      return this._handleResult(id, run, engine, state, result);
    }
  }

  async _handleResult(id, run, engine, state, result) {
    const status = result?.status ?? 'failed';
    if (run.controller.signal.aborted && status !== 'completed') { this._finishAborted(id, run); return { kind: 'done' }; }
    this._flush(id, run, true);
    if (status === 'completed') { await this._finalizeSuccess(id, run, state, result); return { kind: 'done' }; }
    if (status === 'cancelled') { this._setState(id, TaskState.CANCELLED, { reason: result.error ?? 'cancelled by the engine', extra: { completedAt: new Date().toISOString() } }); this._finishUp(id, run); return { kind: 'done' }; }
    if (status === 'paused') { this._pauseWithReason(id, run, result.error ?? 'engine paused the task'); return { kind: 'done' }; }
    this._fail(id, run, result?.error ?? 'engine reported failure', 'engine_failed', result);
    return { kind: 'done' };
  }

  _finishAborted(id, run) {
    const why = run.abortReason;
    const task = this.store.get(id);
    this._flush(id, run, true);
    if (why === 'user_cancel') this._setState(id, TaskState.CANCELLED, { reason: run.abortDetail ?? 'cancelled by user', extra: { completedAt: new Date().toISOString(), pendingApprovals: [] } });
    else if (why === 'pause') this._setState(id, TaskState.PAUSED, { reason: run.abortDetail ?? 'paused by user', extra: { pendingApprovals: [], pauseCause: 'user' } });
    else if (why === 'shutdown') this._setState(id, TaskState.PAUSED, { reason: 'Xoft is shutting down — the task will be recovered on next start', extra: { pendingApprovals: [], pauseCause: 'shutdown' } });
    else if (why === 'timeout') this._fail(id, run, `Task exceeded its time limit of ${Math.round((task.limits?.timeoutMs ?? 0) / 1000)}s`, 'timeout');
    else if (why === 'tool_limit') this._fail(id, run, `Task exceeded its limit of ${task.limits?.maxToolCalls} tool calls`, 'tool_limit');
    else if (why === 'policy') this._fail(id, run, run.abortDetail ?? 'Task stopped for violating its permission policy', 'policy_violation');
    else if (why === 'emergency_stop') this._setState(id, TaskState.CANCELLED, { reason: 'emergency stop', extra: { completedAt: new Date().toISOString() } });
    else this._setState(id, TaskState.CANCELLED, { reason: 'aborted', extra: { completedAt: new Date().toISOString() } });
    if (why === 'user_cancel' || why === 'timeout' || why === 'policy' || why === 'tool_limit' || why === 'emergency_stop') this._resolvePendingApprovals(task, 'reject');
    this._finishUp(id, run);
  }

  _fail(id, run, message, code, result = null) {
    const task = this.store.get(id);
    if (task && TERMINAL_STATES.has(task.state)) return;
    this._flush(id, run, true);
    this._setState(id, TaskState.FAILED, { reason: message, extra: { error: redactString(message), errorCode: code, completedAt: new Date().toISOString(), pendingApprovals: [], result: result ? { summary: redactString(String(result.error ?? message)).slice(0, 4000), output: redactString(String(result.output ?? '')).slice(0, 20000) } : task?.result ?? null } });
    this._finishUp(id, run);
  }

  _failUnexpected(id, err) {
    const task = this.store.get(id);
    if (!task || TERMINAL_STATES.has(task.state)) return;
    this._log(id, { type: 'error', code: 'INTERNAL', error: err?.message ?? String(err) });
    this._setState(id, TaskState.FAILED, { reason: `internal error: ${err?.message}`, extra: { error: redactString(err?.message ?? 'internal error'), errorCode: 'internal', completedAt: new Date().toISOString() } });
  }

  /** Pause that records WHY (spec: "task paused, reason recorded, user notified"). keepRunning=true is used inside the recovery loop. */
  _pauseWithReason(id, run, reason, { keepRunning = false } = {}) {
    this._flush(id, run, true);
    this._setState(id, TaskState.PAUSED, { reason, extra: { pauseCause: keepRunning ? 'recovering' : 'recovery_failed' } });
    this.activityLog?.log({ type: 'engine_task_paused', taskId: id, detail: { reason } });
    if (!keepRunning) this._finishUp(id, run);
  }

  _finishUp(id, run) {
    clearTimeout(run.timer); clearInterval(run.flushTimer);
    const task = this.store.get(id);
    if (task && TERMINAL_STATES.has(task.state) && task.workspace?.mode === 'worktree') { /* the worktree is kept on purpose: it holds the work for review */ }
  }

  async _prepareWorkspace(id, task) {
    if (!task.workingDirectory) { this.store.update(id, { workspace: { mode: 'none', cwd: null, isRepo: false, notes: [] } }); return; }
    if (!this.gitWorkspace) { this.store.update(id, { workspace: { mode: 'in-place', cwd: task.workingDirectory, isRepo: false, notes: ['git safety net disabled'] } }); return; }
    const ws = await this.gitWorkspace.prepare({ workingDirectory: task.workingDirectory, mode: task.workspaceMode, taskId: id });
    const roots = ws.cwd && ws.cwd !== task.workingDirectory ? [ws.cwd, ...(ws.worktreePath ? [ws.worktreePath] : [])] : task.allowedRoots;
    this.store.update(id, { workspace: ws, allowedRoots: roots });
    this._log(id, { type: 'workspace', mode: ws.mode, isRepo: ws.isRepo, branch: ws.branch, backupRef: ws.backupRef, cleanAtStart: ws.cleanAtStart, notes: ws.notes });
  }

  // ---- events -----------------------------------------------------------------------------------------------

  _onEngineEvent(id, run, engine, state, e) {
    if (!e?.type) return;
    const now = new Date().toISOString();
    const p = run.progress;
    p.lastEventAt = now;
    const task = this.store.get(id);
    switch (e.type) {
      case EngineEvent.TOOL_STARTED: {
        state.sideEffects = true;
        p.toolCalls += 1; p.currentTool = e.tool ?? null; p.toolsUsed[e.tool ?? 'unknown'] = (p.toolsUsed[e.tool ?? 'unknown'] ?? 0) + 1;
        p.currentActivity = describeActivity(e) ?? p.currentActivity;
        const { command } = parseToolPreview(e.preview ?? e.input);
        state.lastStarted = { tool: e.tool, command };
        this._leaveWaitingIfIdle(id, run);
        const limit = task?.limits?.maxToolCalls ?? 0;
        if (limit > 0 && p.toolCalls > limit) { run.abortReason ??= 'tool_limit'; run.controller.abort(); }
        this._checkPolicy(id, run, engine, task, e);
        this._log(id, { type: e.type, tool: e.tool, preview: e.preview ?? null, via: e.via ?? 'native', callId: e.callId ?? null });
        this._publish(e.type, { taskId: id, engineId: engine.id, tool: e.tool, activity: p.currentActivity, toolCalls: p.toolCalls }, {});
        break;
      }
      case EngineEvent.TOOL_COMPLETED: case EngineEvent.TOOL_FAILED: {
        p.currentTool = null; p.completedTools += 1;
        if (e.type === EngineEvent.TOOL_FAILED || e.error) { p.errors += 1; }
        const started = state.lastStarted;
        const cmd = e.command ?? started?.command ?? null;
        if (cmd && /^(terminal|shell|bash|sh|zsh|powershell|pwsh|cmd|exec|execute_code|run_command|terminal_run|process|python)$/i.test(e.tool ?? started?.tool ?? '')) {
          const ok = !(e.type === EngineEvent.TOOL_FAILED || e.error);
          const entry = { command: redactString(cmd).slice(0, 300), ok, at: now, test: TEST_COMMAND.test(cmd) };
          p.commands = [...p.commands, entry].slice(-50); state.commands.push(entry);
          this._log(id, { type: EngineEvent.COMMAND_EXECUTED, ...entry });
          this._publish(EngineEvent.COMMAND_EXECUTED, { taskId: id, engineId: engine.id, ...entry }, {});
        }
        const fc = !(e.type === EngineEvent.TOOL_FAILED || e.error) ? fileChangeFromToolEvent({ tool: e.tool ?? started?.tool, preview: e.input ?? e.preview ?? null }) : null;
        if (fc) this._noteFileChange(id, run, engine, fc);
        if (e.fileChange) this._noteFileChange(id, run, engine, e.fileChange);
        this._log(id, { type: e.type, tool: e.tool, duration: e.duration ?? null, error: e.error ?? null, preview: e.resultPreview ?? e.preview ?? null, via: e.via ?? 'native' });
        this._publish(e.type, { taskId: id, engineId: engine.id, tool: e.tool, error: e.error ?? null }, {});
        if (p.completedTools % 10 === 0) this._checkpoint(id, run, engine);
        break;
      }
      case EngineEvent.MESSAGE: {
        if (e.text) { p.lastMessage = redactString(String(e.text)).slice(-500); p.currentActivity = describeActivity(e) ?? p.currentActivity; }
        this._log(id, { type: e.type, text: String(e.text ?? '').slice(0, 1500), kind: e.kind ?? 'assistant' });
        this._publish(e.type, { taskId: id, engineId: engine.id, text: redactString(String(e.text ?? '')).slice(0, 300) }, {});
        break;
      }
      case EngineEvent.TASK_PROGRESS: {
        if (e.step !== undefined) p.currentStep = e.step;
        if (e.note) p.currentActivity = String(e.note).slice(0, 200);
        this._leaveWaitingIfIdle(id, run);
        this._log(id, { type: e.type, step: e.step ?? null, note: e.note ?? null });
        this._publish(e.type, { taskId: id, engineId: engine.id, step: p.currentStep, note: e.note ?? null }, {});
        break;
      }
      case EngineEvent.TASK_WAITING: {
        this._enterWaiting(id, run, e.reason ?? 'waiting');
        break;
      }
      case EngineEvent.APPROVAL_REQUESTED: {
        state.sideEffects = true;
        this._handleApprovalRequest(id, run, engine, task, e).catch((err) => this._log(id, { type: 'error', error: `approval handling failed: ${err.message}` }));
        break;
      }
      case EngineEvent.FILE_CREATED: case EngineEvent.FILE_MODIFIED: case EngineEvent.FILE_DELETED:
        state.sideEffects = true;
        this._noteFileChange(id, run, engine, { kind: e.type.split('.').pop() === 'created' ? 'created' : e.type.endsWith('deleted') ? 'deleted' : 'modified', paths: e.paths ?? [] });
        break;
      case EngineEvent.TASK_CHECKPOINT: this._checkpoint(id, run, engine, e); break;
      default:
        this._log(id, { ...e });
    }
    run.dirty = true;
  }

  _noteFileChange(id, run, engine, { kind, paths }) {
    const type = kind === 'created' ? EngineEvent.FILE_CREATED : kind === 'deleted' ? EngineEvent.FILE_DELETED : EngineEvent.FILE_MODIFIED;
    const set = new Map(run.progress.filesChanged.map((f) => [f.path, f]));
    for (const p of paths ?? []) set.set(p, { path: p, kind });
    run.progress.filesChanged = [...set.values()].slice(-200);
    this._log(id, { type, paths });
    this._publish(type, { taskId: id, engineId: engine.id, paths }, {});
  }

  _checkPolicy(id, run, engine, task, e) {
    const mode = engine.taskPolicy?.().nativeToolPolicy ?? 'enforce';
    if (mode === 'off' || e.via === 'bridge') return; // Tool Gateway calls were already enforced before they ran
    const violation = evaluateNativeToolEvent(task.permissions, { tool: e.tool, preview: e.preview ?? e.input }, { allowedRoots: task.allowedRoots, workingDirectory: task.workspace?.cwd ?? task.workingDirectory, bridgeName: engine.bridgeName ?? 'xoft' });
    if (!violation) return;
    run.progress.warnings += 1;
    this._log(id, { type: EngineEvent.POLICY_VIOLATION, tool: e.tool, ...violation, enforced: mode === 'enforce' });
    this._publish(EngineEvent.POLICY_VIOLATION, { taskId: id, engineId: engine.id, tool: e.tool, code: violation.code, message: violation.message, enforced: mode === 'enforce' }, { audit: true });
    if (mode === 'enforce') { run.abortReason ??= 'policy'; run.abortDetail ??= `Stopped: ${violation.message}`; run.controller.abort(); }
  }

  _checkpoint(id, run, engine, extra = {}) {
    run.lastCheckpointAt = Date.now();
    this._flush(id, run, true);
    this._log(id, { type: EngineEvent.TASK_CHECKPOINT, toolCalls: run.progress.toolCalls, filesChanged: run.progress.filesChanged.length, ...extra });
    this._publish(EngineEvent.TASK_CHECKPOINT, { taskId: id, engineId: engine.id, toolCalls: run.progress.toolCalls }, {});
  }

  // ---- approvals --------------------------------------------------------------------------------------------

  async _handleApprovalRequest(id, run, engine, task, e) {
    const key = e.approvalKey ?? e.approvalId ?? null;
    const command = e.command ?? parseToolPreview(e.preview ?? e.input).command ?? null;
    const destructive = command ? detectDestructiveCommand(command).destructive : /delete|remove|destroy/i.test(String(e.description ?? e.tool ?? ''));
    const violation = e.tool ? evaluateNativeToolEvent(task.permissions, { tool: e.tool, preview: e.preview ?? e.input ?? command }, { allowedRoots: task.allowedRoots, workingDirectory: task.workspace?.cwd ?? task.workingDirectory, bridgeName: engine.bridgeName ?? 'xoft' }) : null;
    const summary = redactString(String(e.description ?? command ?? e.tool ?? 'engine action')).slice(0, 300);
    const decide = async (decision, why, auto) => {
      this._log(id, { type: EngineEvent.APPROVAL_RESOLVED, key, decision, auto, why });
      this._publish(EngineEvent.APPROVAL_RESOLVED, { taskId: id, engineId: engine.id, decision, auto, why }, { audit: true });
      this.store.update(id, (t) => ({ approvals: [...(t.approvals ?? []), { approvalId: null, tool: e.tool, summary, decision, decidedBy: auto ? 'policy' : 'user', decidedAt: new Date().toISOString(), why }].slice(-100) }));
      try { await engine.resolveApproval(this.store.get(id), key, decision === 'approve' ? 'once' : 'deny', { approvalId: e.engineApprovalId ?? null }); } catch (err) { this._log(id, { type: 'error', error: `could not deliver approval decision: ${err.message}` }); }
    };

    if (violation && violation.code !== 'outside_workspace') { run.progress.warnings += 1; this._publish(EngineEvent.POLICY_VIOLATION, { taskId: id, engineId: engine.id, code: violation.code, message: violation.message }, { audit: true }); return decide('reject', violation.message, true); }
    if (violation) { return decide('reject', violation.message, true); }
    if (task.autonomy <= 1) return decide('reject', 'autonomy level does not permit actions that need approval', true);
    if (task.autonomy >= 4 && !destructive) return decide('approve', `auto-approved at autonomy level ${task.autonomy}`, true);

    const approvalId = this._createXoftApproval({ taskId: id, engine, key, e, summary, destructive, command });
    const pending = { approvalId, key, engineApprovalId: e.engineApprovalId ?? null, tool: e.tool ?? null, summary, destructive, requestedAt: new Date().toISOString() };
    this.store.update(id, (t) => ({ pendingApprovals: [...(t.pendingApprovals ?? []), pending] }));
    this._log(id, { type: EngineEvent.APPROVAL_REQUESTED, approvalId, tool: e.tool, summary, destructive });
    this._publish(EngineEvent.APPROVAL_REQUESTED, { taskId: id, engineId: engine.id, approvalId, tool: e.tool, summary, destructive }, { audit: true });
    this._enterWaiting(id, run, `waiting for approval: ${summary}`);
  }

  _createXoftApproval({ taskId, engine, key, e, summary, destructive, command }) {
    if (!this.approvalSystem) return crypto.randomUUID();
    const tool = { name: `engine:${engine.id}:${e.tool ?? 'action'}`, riskLevel: destructive ? 3 : 2 };
    const input = redactDeep({ summary, tool: e.tool ?? null, command: command ?? null, engine: engine.name, task: taskId });
    const { approvalId } = this.approvalSystem.requestApproval({ tool, input, taskId: null, reason: 'engine_action', metadata: { engineTaskId: taskId, engineId: engine.id, approvalKey: key } });
    return approvalId;
  }

  _resolvePendingApprovals(task, decision) {
    for (const a of task?.pendingApprovals ?? []) {
      try { if (this.approvalSystem?.get(a.approvalId)?.status === 'pending') (decision === 'reject' ? this.approvalSystem.reject(a.approvalId) : this.approvalSystem.approve(a.approvalId)); } catch { /* record gone */ }
    }
  }

  // ---- waiting / deadlines ----------------------------------------------------------------------------------

  _enterWaiting(id, run, reason) {
    const task = this.store.get(id);
    if (!task || task.state === TaskState.WAITING || TERMINAL_STATES.has(task.state)) return;
    run.waitStarted = Date.now(); clearTimeout(run.timer); // time spent waiting for a human does not count against the task's time limit
    this._setState(id, TaskState.WAITING, { reason });
  }

  _leaveWaiting(id, run) {
    if (run.waitStarted) { run.deadline += Date.now() - run.waitStarted; run.waitStarted = null; this._armDeadline(id, run); }
    this._setState(id, TaskState.RUNNING, { reason: null });
  }

  _leaveWaitingIfIdle(id, run) {
    const task = this.store.get(id);
    if (task?.state === TaskState.WAITING && (task.pendingApprovals ?? []).length === 0) this._leaveWaiting(id, run);
  }

  _armDeadline(id, run, timeoutMs) {
    if (timeoutMs) run.deadline = Date.now() + timeoutMs;
    clearTimeout(run.timer);
    const remaining = Math.max(1, run.deadline - Date.now());
    run.timer = setTimeout(() => { run.abortReason ??= 'timeout'; run.controller.abort(); }, remaining);
    run.timer.unref?.();
  }

  // ---- completion + verification ----------------------------------------------------------------------------

  async _finalizeSuccess(id, run, state, result) {
    const task = this.store.get(id);
    let git = null; let patchFile = null;
    try { if (this.gitWorkspace && task.workspace?.isRepo) { git = await this.gitWorkspace.summarize(task.workspace); patchFile = await this.gitWorkspace.savePatch(task.workspace, id); } } catch (err) { this._log(id, { type: 'warning', message: `git summary failed: ${err.message}` }); }
    const verification = this.verify({ commands: state.commands.length ? state.commands : run.progress.commands, git, filesFromEvents: run.progress.filesChanged, goalAnalysis: task.analysis });
    const output = redactString(String(result.output ?? '')).slice(0, 20000);
    const summary = redactString(String(result.summary ?? output.slice(0, 1200) ?? '')).slice(0, 4000);
    const finalResult = { summary: summary || 'Engine finished without a text summary.', output, usage: result.usage ?? null, runtime: result.runtime ?? null, verification, git, patchFile };
    this._flush(id, run, true);
    if (verification.status === 'failed') {
      this._setState(id, TaskState.FAILED, { reason: verification.statement, extra: { result: finalResult, error: verification.statement, errorCode: 'verification_failed', completedAt: new Date().toISOString(), pendingApprovals: [] } });
    } else {
      this._setState(id, TaskState.COMPLETED, { reason: verification.statement, extra: { result: finalResult, error: null, completedAt: new Date().toISOString(), pendingApprovals: [] } });
    }
    this._finishUp(id, run);
  }

  /**
   * Honest verification (spec section 12). The engine's own claim of success is never treated as proof. Evidence used:
   * test/build commands that were actually observed and whether the last one passed, and git's own change summary.
   */
  verify({ commands = [], git = null, filesFromEvents = [], goalAnalysis = null }) {
    const tests = commands.filter((c) => c.test || TEST_COMMAND.test(c.command ?? ''));
    const last = tests[tests.length - 1] ?? null;
    const filesChanged = git?.available ? git.files.length : filesFromEvents.length;
    const expectsCode = Boolean(goalAnalysis?.requiredCapabilities?.includes?.(Capability.CODING));
    let status; let statement;
    if (last && !last.ok) { status = 'failed'; statement = `The engine reported completion, but the last test/build command it ran failed (${last.command.slice(0, 80)}).`; }
    else if (last) { status = 'verified'; statement = `Verified: ${tests.length} test/build command(s) were observed and the last one passed (${last.command.slice(0, 80)}).`; }
    else if (expectsCode && filesChanged > 0) { status = 'unverified'; statement = `The engine reported completion and ${filesChanged} file(s) changed, but no test or build command was observed — the change is NOT independently verified.`; }
    else { status = 'unverified'; statement = 'The engine reported completion; no test or build command was observed, so the outcome is not independently verified.'; }
    return { status, statement, testsObserved: tests.length, lastTestPassed: last ? last.ok : null, filesChanged, source: git?.available ? 'event-log+git' : 'event-log' };
  }

  // ---- state + persistence ----------------------------------------------------------------------------------

  _setState(id, state, { reason = null, extra = {} } = {}) {
    const before = this.store.get(id);
    if (!before) return null;
    if (before.state === state && !Object.keys(extra).length && before.stateReason === reason) return before;
    const run = this._running.get(id);
    const rec = this.store.update(id, { state, stateReason: reason, ...(state !== TaskState.PAUSED ? { pauseCause: null } : {}), ...extra, ...(run ? { progress: run.progress } : {}) });
    this._log(id, { type: 'state', state, previous: before.state, reason });
    const payload = { taskId: id, engineId: rec.engine, state, previous: before.state, reason };
    this._publish(EngineEvent.TASK_STATE, payload, { audit: TERMINAL_STATES.has(state) || state === TaskState.PAUSED || state === TaskState.WAITING });
    const specific = { [TaskState.RUNNING]: before.state === TaskState.QUEUED || before.state === TaskState.INITIALIZING ? (before.startedAt && before.attempts > 1 ? null : EngineEvent.TASK_STARTED) : null, [TaskState.WAITING]: EngineEvent.TASK_WAITING, [TaskState.PAUSED]: EngineEvent.TASK_PAUSED, [TaskState.COMPLETED]: EngineEvent.TASK_COMPLETED, [TaskState.FAILED]: EngineEvent.TASK_FAILED, [TaskState.CANCELLED]: EngineEvent.TASK_CANCELLED }[state];
    if (specific) this._publish(specific, { taskId: id, engineId: rec.engine, reason, result: state === TaskState.COMPLETED ? rec.result?.summary?.slice(0, 300) : undefined }, { audit: TERMINAL_STATES.has(state) });
    if (TERMINAL_STATES.has(state)) this.activityLog?.log({ type: `engine_task_${state}`, taskId: null, detail: { engineTaskId: id, engine: rec.engine, reason, goal: rec.goal?.slice(0, 200) } });
    return rec;
  }

  _flush(id, run, force = false) {
    if (!run || (!force && !run.dirty)) return;
    run.dirty = false;
    this.store.update(id, { progress: run.progress });
  }

  _log(id, event) { try { return this.store.appendEvent(id, event); } catch { return null; } }

  _publish(type, payload, { audit = false } = {}) {
    if (!this.eventBus) return;
    if (audit) { this.eventBus.emitEvent(type, payload); return; }
    // High-frequency events skip the ActivityLog (whole-file JSON rewrite per event would not scale); they still reach the
    // WebSocket bridge through the '*' channel and are persisted in the task's own append-only event log.
    this.eventBus.emit(type, payload);
    this.eventBus.emit('*', { type, payload, ts: new Date().toISOString() });
  }

  _require(id) {
    const t = this.store.get(id);
    if (!t) throw new EngineError(ErrorCode.NOT_FOUND, `No engine task '${id}'`);
    return t;
  }

  _resolveWorkingDirectory(requested, policy, analysis) {
    let wd = requested || policy.defaultWorkingDirectory || null;
    if (!wd) {
      if (policy.requiresWorkingDirectory?.(analysis)) throw new EngineError(ErrorCode.INVALID, 'workingDirectory is required for this task (or set a default working directory in the engine settings)');
      return null;
    }
    wd = path.resolve(String(wd));
    let st; try { st = fs.statSync(wd); } catch { throw new EngineError(ErrorCode.INVALID, `workingDirectory does not exist: ${wd}`); }
    if (!st.isDirectory()) throw new EngineError(ErrorCode.INVALID, `workingDirectory is not a directory: ${wd}`);
    if (isSensitivePath(wd)) throw new EngineError(ErrorCode.POLICY_DENIED, 'workingDirectory is a protected location (credentials, keys or system files) and cannot be used');
    const roots = (policy.allowedRoots ?? []).map((r) => path.resolve(r));
    if (roots.length) {
      if (!roots.some((r) => isInside(wd, r))) throw new EngineError(ErrorCode.POLICY_DENIED, `workingDirectory ${wd} is outside the allowed directories configured for this engine`);
    } else if (path.parse(wd).root === wd || wd === os.homedir()) {
      throw new EngineError(ErrorCode.POLICY_DENIED, 'workingDirectory is too broad (a filesystem root or your whole home directory). Pick a project folder, or list allowed directories in the engine settings.');
    }
    return { workingDirectory: wd, allowedRoots: [wd] };
  }
}
