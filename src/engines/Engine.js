import { Availability, EngineError, EngineStatus, ErrorCode, Capability } from './constants.js';

/** Tiny async queue so `stream()` can expose callback-style events as an async iterator. */
class AsyncQueue {
  constructor() { this.items = []; this.waiters = []; this.closed = false; }
  push(item) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false }); else this.items.push(item);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  next() {
    if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/**
 * Engine — the contract every execution engine implements (spec section 3).
 *
 *   id / name / status / capabilities
 *   initialize()  execute()  stream()  cancel()  pause()  resume()  healthCheck()  shutdown()
 *
 * plus three additions the task layer needs for long-running work: resolveApproval() (a paused engine run
 * waiting on a human), recover() (re-attach to a run after a Xoft restart) and describe().
 *
 * The rest of Xoft only ever talks to this interface — never to an engine's internals.
 *
 * `execute(task, ctx)` resolves with an ExecutionResult:
 *   { status: 'completed'|'failed'|'cancelled'|'paused'|'waiting', output?, summary?, error?, usage?, engineRef? }
 * and reports progress through `ctx.onEvent(event)` where `event` is `{ type, ... }` using EngineEvent names.
 * `ctx.signal` is an AbortSignal; aborting it is a request to stop (same effect as cancel()).
 */
export class Engine {
  /**
   * @param {{id:string, name:string, description?:string, capabilities?:string[], kind?:string}} def
   */
  constructor({ id, name, description = '', capabilities = [], kind = 'generic' }) {
    if (!id || !name) throw new Error('Engine requires an id and a name');
    this.id = id;
    this.name = name;
    this.description = description;
    this.kind = kind;
    this.capabilities = [...capabilities];
    this._status = EngineStatus.OFFLINE;
    this._statusReason = null;
    this._listeners = new Set();
  }

  get status() { return this._status; }
  get statusReason() { return this._statusReason; }

  /** Subscribe to status changes. Returns an unsubscribe function. */
  onStatusChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  setStatus(status, reason = null) {
    if (status === this._status && reason === this._statusReason) return;
    const previous = this._status;
    this._status = status;
    this._statusReason = reason;
    for (const fn of this._listeners) {
      try { fn({ engineId: this.id, status, previous, reason }); } catch { /* listeners must never break the engine */ }
    }
  }

  supports(capability) { return this.capabilities.includes(capability); }
  supportsAll(list = []) { return list.every((c) => this.supports(c)); }

  /**
   * Router hook: can this engine serve a task with these requirements right now? `health` is the engine's latest
   * healthCheck(). Engines override this to honour partial availability (e.g. "browser dependency is down").
   */
  canServe(analysis, health) {
    if (!health?.available) return false;
    return this.supportsAll(analysis?.requiredCapabilities ?? []);
  }

  /** Router hook: extra score (positive = better fit) for this task shape. Keep within roughly −40…+40. */
  // eslint-disable-next-line no-unused-vars
  routingWeight(analysis) { return 0; }

  /**
   * Limits and defaults the task manager applies to tasks on this engine. Engines override with their own settings.
   * @param {object} [analysis] the task analysis (some engines require a working directory only for certain tasks)
   */
  // eslint-disable-next-line no-unused-vars
  taskPolicy(analysis) {
    return { maxConcurrentTasks: 2, timeoutMs: 15 * 60 * 1000, maxToolCalls: 0, maxRetries: 2, allowedRoots: [], defaultWorkingDirectory: null, permissionProfile: 'standard', defaultAutonomy: 2, nativeToolPolicy: 'monitor', workspaceMode: 'in-place', requiresWorkingDirectory: () => false };
  }

  /** Called by the task manager before a recovery attempt (e.g. restart a managed process). Must not throw for "cannot". */
  // eslint-disable-next-line no-unused-vars
  async ensureAvailable(opts) { return this.status !== EngineStatus.OFFLINE; }

  /** The task manager reports how many tasks this engine is running so it can show BUSY. */
  setActiveTasks(count) {
    this._active = count;
    if (count > 0 && this.status === EngineStatus.ONLINE) this.setStatus(EngineStatus.BUSY, this.statusReason);
    else if (count === 0 && this.status === EngineStatus.BUSY) this.setStatus(EngineStatus.ONLINE, this.statusReason);
  }

  // ---- lifecycle ----------------------------------------------------------------------------------------

  /** Prepare the engine (connect, detect runtime, …). Must not throw for "not installed" — report it via healthCheck(). */
  async initialize() { return this.describe(); }

  /**
   * Returns the engine's current availability. Never throws.
   * @returns {Promise<{available:boolean, level:string, status:string, reason:string|null, dependencies:Record<string,boolean|null>, capabilities:string[], fallback?:string|null, checkedAt:string}>}
   */
  async healthCheck() {
    return {
      available: this.status === EngineStatus.ONLINE || this.status === EngineStatus.BUSY,
      level: Availability.READY,
      status: this.status,
      reason: this.statusReason,
      dependencies: {},
      capabilities: this.capabilities,
      checkedAt: new Date().toISOString(),
    };
  }

  async shutdown() { /* nothing to release by default */ }

  // ---- execution ----------------------------------------------------------------------------------------

  /** @returns {Promise<object>} ExecutionResult */
  // eslint-disable-next-line no-unused-vars
  async execute(task, ctx = {}) {
    throw new EngineError(ErrorCode.NOT_SUPPORTED, `Engine '${this.id}' does not implement execute()`);
  }

  /**
   * Async-iterator view of execute(): yields `{type, ...}` events as they happen and finally
   * `{type:'result', result}`. Built on execute() so engines only implement one code path.
   */
  async *stream(task, ctx = {}) {
    const queue = new AsyncQueue();
    const done = this.execute(task, { ...ctx, onEvent: (e) => { queue.push(e); ctx.onEvent?.(e); } })
      .then((result) => queue.push({ type: 'result', result }))
      .catch((error) => queue.push({ type: 'error', error }))
      .finally(() => queue.close());
    for (;;) {
      const { value, done: finished } = await queue.next();
      if (finished) break;
      yield value;
    }
    await done;
  }

  // eslint-disable-next-line no-unused-vars
  async cancel(task, ctx = {}) { throw new EngineError(ErrorCode.NOT_SUPPORTED, `Engine '${this.id}' cannot cancel running tasks`); }
  // eslint-disable-next-line no-unused-vars
  async pause(task, ctx = {}) { throw new EngineError(ErrorCode.NOT_SUPPORTED, `Engine '${this.id}' does not support pausing a running task`); }
  // eslint-disable-next-line no-unused-vars
  async resume(task, ctx = {}) { throw new EngineError(ErrorCode.NOT_SUPPORTED, `Engine '${this.id}' does not support resuming a task`); }
  // eslint-disable-next-line no-unused-vars
  async resolveApproval(task, approvalKey, decision, ctx = {}) { throw new EngineError(ErrorCode.NOT_SUPPORTED, `Engine '${this.id}' has no approval channel`); }
  /** Re-attach to work that was in flight when Xoft restarted. Resolve with an ExecutionResult or throw NOT_SUPPORTED. */
  // eslint-disable-next-line no-unused-vars
  async recover(task, ctx = {}) { throw new EngineError(ErrorCode.NOT_SUPPORTED, `Engine '${this.id}' cannot re-attach to in-flight tasks`); }

  /** Static description for registries / the UI. */
  describe() {
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      description: this.description,
      status: this.status,
      statusReason: this.statusReason,
      capabilities: [...this.capabilities],
    };
  }
}

export { Capability };
