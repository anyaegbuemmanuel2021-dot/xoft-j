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
  constructor({ taskPlanner, eventBus, activityLog, concurrency = 2, pollIntervalMs = 5000, maxPending = 250 }) {
    this.taskPlanner = taskPlanner;
    this.eventBus = eventBus;
    this.activityLog = activityLog;
    const requestedConcurrency = Number(concurrency);
    this.concurrency = Number.isFinite(requestedConcurrency)
      ? Math.max(1, Math.min(8, Math.floor(requestedConcurrency)))
      : 2;
    const requestedPollInterval = Number(pollIntervalMs);
    this.pollIntervalMs = Number.isFinite(requestedPollInterval)
      ? Math.max(250, Math.min(60_000, Math.floor(requestedPollInterval)))
      : 5000;
    const requestedMaxPending = Number(maxPending);
    this.maxPending = Number.isFinite(requestedMaxPending)
      ? Math.max(1, Math.min(5000, Math.floor(requestedMaxPending)))
      : 250;
    this._running = new Set(); // taskIds currently inside taskPlanner.execute()
    this._pending = []; // [{ taskId, priority }] waiting for a concurrency slot
    this._timer = null;
    this._recoveredOnStart = false;
    this._recoveredTaskIds = new Set();
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
    if (['blocked', 'completed', 'cancelled', 'rolled_back'].includes(task.status)) return task;
    if (this._pending.length >= this.maxPending) {
      throw new Error(`TaskQueue: pending queue is full (maximum ${this.maxPending}). Try again when a slot is available.`);
    }

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
    const task = this.taskPlanner.get(taskId);
    if (!['planned', 'waiting_approval', 'scheduled'].includes(task.status)) {
      throw new Error(`TaskQueue: cannot schedule a task in '${task.status}' state.`);
    }
    return this.taskPlanner.setStatus(taskId, 'scheduled', { scheduledFor: whenIso });
  }

  /** Moves any due 'scheduled' task into the pending queue. Safe to call manually (tests) or on a timer. */
  tick() {
    const now = Date.now();
    let tasks;
    try {
      tasks = this.taskPlanner.list();
    } catch (error) {
      try {
        this.activityLog?.log({ type: 'task_queue_scan_failed', detail: { error: error.message } });
      } catch { /* queue polling must remain alive when diagnostics fail */ }
      return [];
    }

    const enqueued = [];
    for (const task of tasks) {
      if (task.status !== 'scheduled' || !task.scheduledFor || new Date(task.scheduledFor).getTime() > now) continue;
      try {
        this.enqueue(task.id);
        enqueued.push(task.id);
      } catch (error) {
        try {
          this.activityLog?.log({
            type: 'task_schedule_enqueue_failed',
            taskId: task.id,
            detail: { error: error.message },
          });
        } catch { /* one bad task must not stop other due tasks */ }
      }
    }
    return enqueued;
  }

  /**
   * Re-queues work interrupted by a process restart. A task persisted as
   * running/queued/timed_out did not reach a terminal state; TaskPlanner's
   * execution ledger decides whether each interrupted side effect is safe
   * to retry or needs explicit approval because its outcome is ambiguous.
   * Planned tasks are intentionally left alone (they may be previews).
   */
  recoverOnStartup() {
    if (this._recoveredOnStart) return [];
    let tasks;
    try {
      tasks = this.taskPlanner.list();
    } catch (error) {
      try {
        this.activityLog?.log({
          type: 'task_recovery_scan_failed',
          detail: { error: error.message },
        });
      } catch { /* diagnostics must never prevent queue startup */ }
      return [];
    }
    const interrupted = tasks.filter((task) =>
      ['queued', 'running', 'timed_out'].includes(task.status) &&
      !this._recoveredTaskIds.has(task.id)
    );
    const recovered = [];
    let hadFailures = false;
    for (const task of interrupted) {
      try {
        this.activityLog?.log({
          type: 'task_recovered_after_restart',
          taskId: task.id,
          detail: { previousStatus: task.status },
        });
        this.enqueue(task.id);
        this._recoveredTaskIds.add(task.id);
        recovered.push({ taskId: task.id, previousStatus: task.status });
      } catch (error) {
        // One corrupt/unavailable task must not prevent healthy tasks from
        // recovering or stop the queue's polling loop from starting.
        hadFailures = true;
        try {
          this.activityLog?.log({
            type: 'task_recovery_failed',
            taskId: task.id,
            detail: { previousStatus: task.status, error: error.message },
          });
        } catch { /* diagnostics must never prevent other tasks from recovering */ }
      }
    }
    this._recoveredOnStart = !hadFailures;
    return recovered;
  }

  /** Starts the poll loop. Call once at server boot; the timer is unref'd so it never keeps the process alive by itself. */
  start() {
    if (this._timer) return;
    this.recoverOnStartup();
    this.tick(); // pick up anything already due, e.g. right after a restart
    this._timer = setInterval(() => {
      if (!this._recoveredOnStart) this.recoverOnStartup();
      this.tick();
    }, this.pollIntervalMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _drain() {
    while (this._running.size < this.concurrency && this._pending.length > 0) {
      const { taskId } = this._pending.shift();
      let task;
      try { task = this.taskPlanner.get(taskId); } catch { continue; }
      // Cancellation or another terminal transition may happen while this
      // task waits for a queue slot. Never execute stale pending entries.
      if (task.status !== 'queued') continue;
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
      maxPending: this.maxPending,
      running: [...this._running],
      pending: this._pending.filter((p) => {
        try { return this.taskPlanner.get(p.taskId).status === 'queued'; } catch { return false; }
      }).map((p) => ({ taskId: p.taskId, priority: p.priority })),
    };
  }
}
