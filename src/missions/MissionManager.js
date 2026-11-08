import crypto from 'node:crypto';
import { JsonStore } from '../persistence/JsonStore.js';

/**
 * MissionManager — goal -> plan -> execute, now with persisted usage, budgets,
 * pause/resume and stuck detection (master-prompt sections 5, 16, 19).
 *
 * Backward compatible: create/plan/run/cancel/get/list keep their signatures,
 * and missions saved by older versions (no budget/usage) get defaults on read.
 * When a budget is exhausted or the mission is stuck, run() PAUSES the mission
 * and throws; only an explicit resume() (a human decision, optionally
 * extending the budget) lets it run again. Nothing here bypasses the existing
 * approval system: TaskPlanner still gates every step.
 */
export const DEFAULT_BUDGET = { maxRuns: 5, maxFailures: 3, maxRuntimeMs: null };
const STUCK_REPEATS = 3; // identical failures in a row => stuck
const HISTORY_LIMIT = 20;
const FAILED = new Set(['failed', 'timed_out', 'blocked']);

export class MissionManager {
  constructor({ taskPlanner, activityLog, eventBus, dataDir = './data', emergencyStop, sqliteStore = null, now = () => Date.now() } = {}) {
    this.taskPlanner = taskPlanner;
    this.activityLog = activityLog;
    this.eventBus = eventBus;
    this.emergencyStop = emergencyStop;
    this.now = now;
    this._store = new JsonStore({ dataDir, fileName: 'missions.json', kvKey: 'missions', defaultValue: { missions: [] }, sqliteStore });
  }

  _load() { return this._store.load(); }
  _save(d) { this._store.save(d); }

  _norm(m) {
    return {
      ...m,
      budget: { ...DEFAULT_BUDGET, ...(m.budget ?? {}) },
      usage: { runs: 0, failures: 0, runtimeMs: 0, ...(m.usage ?? {}) },
      history: m.history ?? [],
      pausedReason: m.pausedReason ?? null,
    };
  }

  create(goal, { autonomyLevel = 2, deadline = null, budget = {}, priority = 3 } = {}) {
    const ts = new Date(this.now()).toISOString();
    const m = { id: crypto.randomUUID(), goal, autonomyLevel, deadline, priority: Math.min(5, Math.max(1, Number(priority) || 3)), status: 'created', taskId: null, createdAt: ts, updatedAt: ts,
      budget: { ...DEFAULT_BUDGET, ...budget }, usage: { runs: 0, failures: 0, runtimeMs: 0 }, history: [], pausedReason: null };
    const d = this._load(); d.missions.push(m); this._save(d);
    this.activityLog?.log({ type: 'mission_created', detail: { id: m.id, goal, budget: m.budget } });
    this.eventBus?.emitEvent('mission.created', { missionId: m.id, goal });
    return m;
  }

  async plan(id) {
    const m = this.get(id);
    if (m.status === 'cancelled') throw new Error('Mission is cancelled');
    const t = await this.taskPlanner.plan(m.goal);
    return this._patch(id, { taskId: t.id, status: 'planned' });
  }

  /** Returns {exhausted:string|null}. Pure read of persisted usage vs budget. */
  budgetState(m) {
    const { budget, usage } = this._norm(m);
    if (usage.runs >= budget.maxRuns) return { exhausted: `runs (${usage.runs}/${budget.maxRuns})` };
    if (usage.failures >= budget.maxFailures) return { exhausted: `failures (${usage.failures}/${budget.maxFailures})` };
    if (budget.maxRuntimeMs && usage.runtimeMs >= budget.maxRuntimeMs) return { exhausted: `runtime (${usage.runtimeMs}ms/${budget.maxRuntimeMs}ms)` };
    return { exhausted: null };
  }

  /** Same failure signature N times in a row => no progress, stop repeating it. */
  isStuck(m) {
    const h = this._norm(m).history.filter((e) => !e.acknowledged); // a human resume acknowledges earlier failures
    if (h.length < STUCK_REPEATS) return false;
    const tail = h.slice(-STUCK_REPEATS);
    return tail.every((e) => e.failed && e.signature === tail[0].signature);
  }

  async run(id) {
    if (this.emergencyStop?.isActive?.()) throw new Error('Emergency stop is active');
    let m = this._norm(this.get(id));
    if (m.status === 'cancelled') throw new Error('Mission is cancelled');
    if (m.status === 'paused') throw new Error(`Mission is paused (${m.pausedReason ?? 'no reason'}); resume it first`);

    const b = this.budgetState(m);
    if (b.exhausted) { this._pause(id, `budget_exhausted: ${b.exhausted}`); throw new Error(`Mission budget exhausted — ${b.exhausted}. Resume with an extended budget to continue.`); }
    if (this.isStuck(m)) { this._pause(id, 'stuck: same failure repeated'); throw new Error('Mission is stuck (same failure repeated). Paused for review/replan.'); }

    if (!m.taskId) m = this._norm(await this.plan(id));
    const started = this.now();
    let status; let error = null;
    try {
      const t = await this.taskPlanner.execute(m.taskId);
      status = t.status;
      error = t.error ?? t.blockedReason ?? (FAILED.has(t.status) ? t.status : null);
    } catch (err) {
      status = 'failed'; error = err.message;
    }
    const failed = FAILED.has(status);
    const fresh = this._norm(this.get(id));
    const entry = { ts: new Date(this.now()).toISOString(), status, failed, signature: failed ? `${status}:${String(error ?? '').slice(0, 120)}` : null, error: failed ? String(error ?? '').slice(0, 200) : null };
    const out = this._patch(id, {
      status,
      usage: { runs: fresh.usage.runs + 1, failures: fresh.usage.failures + (failed ? 1 : 0), runtimeMs: fresh.usage.runtimeMs + (this.now() - started) },
      history: [...fresh.history, entry].slice(-HISTORY_LIMIT),
    });
    this.eventBus?.emitEvent('mission.run', { missionId: id, status, failed });
    return this._norm(out);
  }

  _pause(id, reason) {
    const m = this._patch(id, { status: 'paused', pausedReason: reason });
    this.activityLog?.log({ type: 'mission_paused', detail: { id, reason } });
    this.eventBus?.emitEvent('mission.paused', { missionId: id, reason });
    return m;
  }

  pause(id, reason = 'paused by user') {
    const m = this.get(id);
    if (['cancelled', 'completed'].includes(m.status)) throw new Error(`Cannot pause a ${m.status} mission`);
    return this._norm(this._pause(id, reason));
  }

  /** Human decision. If the budget is exhausted, resume requires extending it (otherwise it would just re-pause). */
  resume(id, { extendBudget = {} } = {}) {
    const m = this._norm(this.get(id));
    if (m.status !== 'paused') throw new Error('Mission is not paused');
    const budget = { ...m.budget };
    for (const k of ['maxRuns', 'maxFailures', 'maxRuntimeMs']) if (extendBudget[k] !== undefined) budget[k] = extendBudget[k];
    const probe = this.budgetState({ ...m, budget });
    if (probe.exhausted) throw new Error(`Budget still exhausted — ${probe.exhausted}. Provide extendBudget to authorize more work.`);
    // Resuming acknowledges past failures so the next run is a genuine human-approved retry, not an instant re-pause.
    const history = m.history.map((e) => ({ ...e, acknowledged: true }));
    const out = this._patch(id, { status: m.taskId ? 'planned' : 'created', pausedReason: null, budget, history });
    this.activityLog?.log({ type: 'mission_resumed', detail: { id, extendBudget } });
    this.eventBus?.emitEvent('mission.resumed', { missionId: id });
    return this._norm(out);
  }

  cancel(id) { return this._patch(id, { status: 'cancelled' }); }
  get(id) { const m = this._load().missions.find((x) => x.id === id); if (!m) throw new Error(`Mission '${id}' not found`); return m; }
  list() { return this._load().missions.map((m) => this._norm(m)); }

  _patch(id, patch) {
    const d = this._load(); const m = d.missions.find((x) => x.id === id);
    if (!m) throw new Error(`Mission '${id}' not found`);
    Object.assign(m, patch, { updatedAt: new Date(this.now()).toISOString() });
    this._save(d);
    return m;
  }
}
