import { EventType } from '../events/EventBus.js';

/**
 * TaskQueue — bounded-concurrency execution queue and scheduler for
 * TaskPlanner (Phase 3, Step 2: "task queue + scheduler improvements").
 *
 * Deliberately reuses TaskPlanner's own persisted task records as the
 * source of truth instead of inventing a second queue-state file — a
 * restart just re-scans tasks.json for anything left 'scheduled' or
 * 'queued' rather than needing its own durable queue. That also means a
 * queued/scheduled task surviving a crash isn't a separate recovery path;
 * it's the same task record TaskPlanner already persists.
 *
 * Concurrency defaults low on purpose: this targets the same old-hardware
 * constraint noted elsewhere in the project (single low-end core, HDD),
 * not a server farm, so bounded, non-aggressive concurrency and a
 * multi-second poll interval (not per-task setTimeout / busy-polling) are
 * the point, not an oversight.
 */
export class TaskQueue {
  constructor({ taskPlanner, eventBus, activityLog, concurrency = 2, pollIntervalMs = 5000 }) {
    this.taskPlanner = taskPlanner;
    this.eventBus = eventBus;
    this.activityLog = activityLog;
    this.concurrency = concurrency;
    this.pollIntervalMs = pollIntervalMs;
    this._running = new Set(); // taskIds currently inside taskPlanner.execute()
    this._pending = []; // [{ taskId, priority }] waiting for a concurrency slot
    this._timer = null;
  }

  _priorityRank(p) {
    return { high: 0, normal: 1, low: 2 }[p] ?? 1;
  }

  /**
   * Enqueue a task for execution, subject to the concurrency cap.
   * Idempotent — re-enqueueing an already queued/running/terminal task is a no-op.
   */
  enqueue(taskId) {
    const task = this.taskPlanner.get(taskId);
    if (this._running.has(taskId) || this._pending.some((p) => p.taskId === taskId)) return task;
    if (['completed', 'cancelled', 'rolled_back'].includes(task.status)) return task;

    const patched = this.taskPlanner.setStatus(taskId, 'queued');
    this._pending.push({ taskId, priority: patched.priority ?? 'normal' });
    this._pending.sort((a, b) => this._priorityRank(a.priority) - this._priorityRank(b.priority));
    this.eventBus?.emitEvent(EventType.TASK_QUEUED, { taskId });
    this._drain();
    return this.taskPlanner.get(taskId);
  }

  /**
   * Schedule a task to run at/after a future time. Restart-safe by
   * construction: this just persists `scheduledFor` on the task record via
   * TaskPlanner — there's no in-memory timer to lose on restart, `tick()`
   * re-checks every due task on every poll instead.
   */
  scheduleAt(taskId, whenIso) {
    if (Number.isNaN(new Date(whenIso).getTime())) throw new Error(`TaskQueue: invalid schedule time '${whenIso}'`);
    return this.taskPlanner.setStatus(taskId, 'scheduled', { scheduledFor: whenIso });
  }

  /** Moves any due 'scheduled' task into the pending queue. Safe to call manually (tests) or on a timer. */
  tick() {
    const now = Date.now();
    for (const task of this.taskPlanner.list()) {
      if (task.status === 'scheduled' && task.scheduledFor && new Date(task.scheduledFor).getTime() <= now) {
        this.enqueue(task.id);
      }
    }
  }

  /** Starts the poll loop. Call once at server boot; the timer is unref'd so it never keeps the process alive by itself. */
  start() {
    if (this._timer) return;
    this.tick(); // pick up anything already due, e.g. right after a restart
    this._timer = setInterval(() => this.tick(), this.pollIntervalMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _drain() {
    while (this._running.size < this.concurrency && this._pending.length > 0) {
      const { taskId } = this._pending.shift();
      this._running.add(taskId);
      this.taskPlanner
        .execute(taskId)
        .catch((err) => {
          this.activityLog?.log({ type: 'task_queue_execution_error', taskId, detail: { error: err.message } });
        })
        .finally(() => {
          this._running.delete(taskId);
          this._drain();
        });
    }
  }

  /** Observability — what's running right now vs. waiting for a slot. */
  status() {
    return {
      concurrency: this.concurrency,
      running: [...this._running],
      pending: this._pending.map((p) => ({ taskId: p.taskId, priority: p.priority })),
    };
  }
}
