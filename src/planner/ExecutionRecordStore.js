import crypto from 'node:crypto';
import { JsonStore } from '../persistence/JsonStore.js';

/**
 * ExecutionRecordStore — a durable, append-oriented ledger of every attempt
 * to run a tool for a task step.
 *
 * This is the real mechanism behind "idempotency" (spec: task engine
 * upgrade, idempotency section): each step gets a stable `idempotencyKey`
 * (see TaskPlanner) identifying "this logical action" independent of how
 * many times it's attempted. Before executing, TaskPlanner asks this store
 * whether that key already has a *succeeded* record — if so, the action is
 * known to have already happened and is not repeated.
 *
 * It also lets a crash/restart mid-execution be detected honestly: if a
 * record was left 'running' and the process restarts, there's a record with
 * a resolvable status of "unknown" rather than XOFT silently assuming
 * success or blindly re-running the exact same side effect with no memory
 * of the earlier attempt.
 *
 * Persists to <dataDir>/execution_records.json — the same flat-file model
 * every other subsystem here uses, so this doesn't invent a whole database
 * migration this project doesn't (yet) have.
 */
export class ExecutionRecordStore {
  constructor({ dataDir = './data', sqliteStore = null } = {}) {
    this._store = new JsonStore({ dataDir, fileName: 'execution_records.json', kvKey: 'execution_records', defaultValue: { records: [] }, sqliteStore });
  }

  _load() {
    return this._store.load();
  }

  _save(data) {
    this._store.save(data);
  }

  /** Deterministic key for "this logical action" — stable across retries of the same step. */
  static keyFor(taskId, stepId) {
    return `${taskId}:${stepId}`;
  }

  /** Called immediately before a tool is invoked. Returns the new record. */
  begin({ taskId, stepId, toolName, idempotencyKey, attemptNumber, input }) {
    const data = this._load();
    const record = {
      executionId: crypto.randomUUID(),
      taskId,
      stepId,
      toolName,
      idempotencyKey,
      attemptNumber,
      status: 'running', // running | succeeded | failed
      input,
      result: null,
      error: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    data.records.push(record);
    // Bounded growth — same reasoning as ExperienceStore (Phase 3D): once a
    // task is done, only the LATEST record per idempotencyKey has any
    // operational value (the dedup check in findLatestSucceeded only ever
    // needs the most recent one); older records are pure historical
    // clutter. On the target HDD-backed hardware, letting this file grow
    // unbounded means every write gets progressively more expensive
    // (JsonStore rewrites the whole file per save). Capped at the most
    // recent 5000 — larger than ExperienceStore's 2000 since this can see
    // more entries per task (one per attempt, not one per failure).
    if (data.records.length > 5000) data.records = data.records.slice(-5000);
    this._save(data);
    return record;
  }

  /** Called after the tool call settles, success or failure. */
  complete(executionId, { status, result = null, error = null, verification = null }) {
    const data = this._load();
    const idx = data.records.findIndex((r) => r.executionId === executionId);
    if (idx === -1) throw new Error(`ExecutionRecordStore: no record '${executionId}'`);
    data.records[idx] = { ...data.records[idx], status, result, error, verification, completedAt: new Date().toISOString() };
    this._save(data);
    return data.records[idx];
  }

  /** Most recent successful attempt for this logical action, if any — the actual dedup check. */
  findLatestSucceeded(idempotencyKey) {
    const records = this._load().records.filter((r) => r.idempotencyKey === idempotencyKey && r.status === 'succeeded');
    return records.length ? records[records.length - 1] : null;
  }

  /**
   * A prior attempt for this key that was left 'running' with no resolution —
   * e.g. the process crashed or lost network mid-call. Its outcome is
   * genuinely unknown; TaskPlanner surfaces this rather than pretending
   * either success or failure.
   */
  findDangling(idempotencyKey) {
    const records = this._load().records.filter((r) => r.idempotencyKey === idempotencyKey && r.status === 'running');
    return records.length ? records[records.length - 1] : null;
  }

  forTask(taskId) {
    return this._load().records.filter((r) => r.taskId === taskId);
  }

  get(executionId) {
    return this._load().records.find((r) => r.executionId === executionId) ?? null;
  }

  list() {
    return this._load().records;
  }
}
