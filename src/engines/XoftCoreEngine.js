import { Availability, Capability, EngineError, EngineEvent, EngineStatus, ErrorCode } from './constants.js';
import { Engine } from './Engine.js';

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(resolve, ms); // ref'd on purpose: an awaited wait must keep the process alive
  signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/**
 * XoftCoreEngine — adapter that exposes Xoft's EXISTING execution machinery (Orchestrator + TaskPlanner + ToolRegistry +
 * ApprovalSystem) through the Engine interface. It adds no new behaviour: a "chat" task goes to Orchestrator.handle(),
 * anything else is planned and executed by TaskPlanner exactly as `POST /api/tasks` + `/execute` do today, including its
 * retries, recovery, idempotency and its own approval flow.
 *
 * Its capabilities are honest about what Xoft Core really has: file/browser/terminal/PC actions exist only through a paired,
 * online device agent (pc-agent), so those capabilities are reported unavailable when no such device is online.
 */
export class XoftCoreEngine extends Engine {
  /**
   * @param {object} deps
   * @param {import('../orchestrator/Orchestrator.js').Orchestrator} deps.orchestrator
   * @param {import('../planner/TaskPlanner.js').TaskPlanner} deps.taskPlanner
   * @param {import('../providers/ProviderRouter.js').ProviderRouter} deps.providerRouter
   * @param {import('../devices/DeviceManager.js').DeviceManager} [deps.deviceManager]
   * @param {object} [deps.options] { pollIntervalMs, maxConcurrentTasks, timeoutMs }
   */
  constructor({ orchestrator, taskPlanner, providerRouter, deviceManager = null, options = {} }) {
    super({
      id: 'xoft-core', name: 'Xoft Core', kind: 'core',
      description: "Xoft's built-in engine: conversation, memory and the planner that drives Xoft's own tools and paired devices.",
      capabilities: [Capability.CHAT, Capability.PLANNING, Capability.MULTI_STEP, Capability.MEMORY, Capability.WEB_SEARCH, Capability.FILESYSTEM, Capability.BROWSER, Capability.TERMINAL, Capability.PC_CONTROL, Capability.CODING, Capability.APPROVALS, Capability.CANCEL, Capability.STREAMING],
    });
    this.orchestrator = orchestrator;
    this.taskPlanner = taskPlanner;
    this.providerRouter = providerRouter;
    this.deviceManager = deviceManager;
    this.pollIntervalMs = options.pollIntervalMs ?? 1500;
    this.options = { maxConcurrentTasks: 2, timeoutMs: 30 * 60 * 1000, ...options };
    this.setStatus(EngineStatus.ONLINE);
  }

  _hasProvider() { return (this.providerRouter?.configuredProviders?.() ?? []).length > 0; }

  _onlineDevices() {
    try { return (this.deviceManager?.listDevices?.() ?? []).filter((d) => d.platform !== 'server' && d.trust === 'trusted' && d.online); } catch { return []; }
  }

  async healthCheck() {
    const provider = this._hasProvider();
    const devices = this._onlineDevices().length > 0;
    const level = provider ? Availability.READY : Availability.OFFLINE;
    const reason = provider ? (devices ? null : 'no paired device online — file, browser, terminal and PC actions are unavailable') : 'no AI provider is configured (see Settings → AI providers)';
    if (this.status !== EngineStatus.BUSY) this.setStatus(provider ? EngineStatus.ONLINE : EngineStatus.OFFLINE, reason);
    return {
      available: provider, level, status: this.status, reason,
      dependencies: { runtime: true, model: provider, devices, filesystem: devices, terminal: devices, browser: devices, pc_control: devices },
      capabilities: this.capabilities, fallback: null, checkedAt: new Date().toISOString(),
    };
  }

  canServe(analysis, health) {
    if (!health?.available) return false;
    const need = analysis?.requiredCapabilities ?? [];
    if (!this.supportsAll(need)) return false;
    const deviceCaps = [Capability.FILESYSTEM, Capability.BROWSER, Capability.TERMINAL, Capability.PC_CONTROL];
    if (need.some((c) => deviceCaps.includes(c)) && !health.dependencies?.devices) return false;
    return true;
  }

  routingWeight(analysis) {
    let w = 0;
    if (analysis?.simple) w += 30;
    if (analysis?.requiredCapabilities?.every((c) => c === Capability.CHAT)) w += 15;
    if (analysis?.autonomous) w -= 10;
    if (analysis?.longRunning) w -= 15;
    return w;
  }

  taskPolicy() {
    return { maxConcurrentTasks: this.options.maxConcurrentTasks, timeoutMs: this.options.timeoutMs, maxToolCalls: 0, maxRetries: 0, allowedRoots: [], defaultWorkingDirectory: null, permissionProfile: 'full', defaultAutonomy: 2, nativeToolPolicy: 'off', workspaceMode: 'in-place', requiresWorkingDirectory: () => false };
  }

  async execute(task, ctx = {}) {
    const emit = ctx.onEvent ?? (() => {});
    const analysis = task.analysis ?? {};
    const chatOnly = (analysis.requiredCapabilities ?? [Capability.CHAT]).every((c) => c === Capability.CHAT);
    emit({ type: EngineEvent.TASK_PROGRESS, step: 'start', note: chatOnly ? 'Answering…' : 'Planning with Xoft Core…' });

    if (chatOnly) {
      const out = await this.orchestrator.handle(`engine-task:${task.id}`, task.goal);
      emit({ type: EngineEvent.MESSAGE, text: out.reply });
      return { status: 'completed', output: out.reply, summary: out.reply?.slice(0, 1200), engineRef: { kind: 'orchestrator' } };
    }

    const planned = await this.taskPlanner.plan(task.goal);
    ctx.setEngineRef?.({ plannerTaskId: planned.id, kind: 'planner' });
    if (planned.status === 'blocked' || !planned.steps.length) {
      return { status: 'failed', error: `Xoft Core cannot plan this with its available tools${planned.blockedReason ? `: ${planned.blockedReason}` : ''}` };
    }
    return this._drive(task, planned.id, ctx, () => this.taskPlanner.execute(planned.id));
  }

  /** Re-attach to an existing planner task (restart recovery) — never re-plans, and idempotency keys prevent duplicate side effects. */
  async recover(task, ctx = {}) {
    const id = task.engineRef?.plannerTaskId;
    if (!id) return this.execute(task, ctx);
    let current; try { current = this.taskPlanner.get(id); } catch { return this.execute(task, ctx); }
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') return this._result(current);
    return this._drive(task, id, ctx, () => this.taskPlanner.execute(id));
  }

  async resume(task, ctx = {}) { return this.recover(task, ctx); }

  async _drive(task, plannerId, ctx, start) {
    const emit = ctx.onEvent ?? (() => {});
    const seen = new Map();
    const observe = () => {
      let t; try { t = this.taskPlanner.get(plannerId); } catch { return null; }
      for (const s of t.steps) {
        if (seen.get(s.id) === s.status) continue;
        seen.set(s.id, s.status);
        if (s.status === 'running') emit({ type: EngineEvent.TOOL_STARTED, tool: s.toolName, preview: JSON.stringify(s.input ?? {}).slice(0, 400), via: 'core' });
        else if (s.status === 'completed') emit({ type: EngineEvent.TOOL_COMPLETED, tool: s.toolName, via: 'core' });
        else if (s.status === 'failed') emit({ type: EngineEvent.TOOL_FAILED, tool: s.toolName, error: s.error ?? 'failed', via: 'core' });
      }
      return t;
    };

    const execution = start().catch((err) => ({ __error: err }));
    let outcome = null;
    execution.then((r) => { outcome = r; });
    for (;;) {
      if (ctx.signal?.aborted) { try { this.taskPlanner.cancel(plannerId); } catch { /* may be finished */ } return { status: 'cancelled', error: 'aborted' }; }
      const t = observe();
      if (t && ['completed', 'failed', 'cancelled', 'rolled_back', 'timed_out'].includes(t.status)) return this._result(t);
      if (t?.status === 'waiting_approval') emit({ type: EngineEvent.TASK_WAITING, reason: 'a step is waiting for approval in Xoft (see Approvals)' });
      else if (t?.status === 'running') emit({ type: EngineEvent.TASK_PROGRESS, step: seen.size, note: 'running' });
      if (outcome?.__error) return { status: 'failed', error: outcome.__error.message };
      await sleep(this.pollIntervalMs, ctx.signal);
    }
  }

  _result(t) {
    const done = t.steps.filter((s) => s.status === 'completed').length;
    const failedStep = t.steps.find((s) => s.status === 'failed');
    const text = t.steps.map((s) => (s.result && typeof s.result === 'object' ? JSON.stringify(s.result).slice(0, 600) : String(s.result ?? ''))).filter(Boolean).join('\n').slice(0, 8000);
    if (t.status === 'completed') return { status: 'completed', output: text, summary: `Completed ${done}/${t.steps.length} planned step(s).` };
    if (t.status === 'cancelled') return { status: 'cancelled', error: 'planner task was cancelled' };
    return { status: 'failed', error: failedStep?.error ?? t.error ?? `planner task ended as ${t.status}`, output: text };
  }

  async cancel(task) {
    const id = task?.engineRef?.plannerTaskId;
    if (id) { try { this.taskPlanner.cancel(id); } catch { /* already terminal */ } }
  }

  /** Core approvals are handled by Xoft's own ApprovalSystem + TaskPlanner.resumeAfterApproval; there is no engine-side channel. */
  async resolveApproval() { throw new EngineError(ErrorCode.NOT_SUPPORTED, 'Xoft Core approvals are resolved through the Approvals page'); }
}
