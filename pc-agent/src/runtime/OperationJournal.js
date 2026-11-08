'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * OperationJournal — append-only JSONL record of every significant mutation:
 * id, timestamp, action, target, previous state, new state, reason, mission, agent, result, rollback availability.
 * A `begin` record is written BEFORE the action and an `end` record after, so a crash mid-action leaves
 * evidence: operations with no `end` are reported as `interrupted` (the Watchdog can surface these).
 */
class OperationJournal {
  constructor({ stateDir } = {}) {
    if (!stateDir) throw new Error('OperationJournal: stateDir is required');
    this.dir = path.join(stateDir, 'journal');
    this.file = path.join(this.dir, 'operations.jsonl');
    fs.mkdirSync(this.dir, { recursive: true });
    this._ops = new Map();
    this._nextId = 1;
    this.corruptLines = 0;
    this._replay();
  }

  _replay() {
    if (!fs.existsSync(this.file)) return;
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { this.corruptLines++; continue; }
      if (rec.type === 'begin') { this._ops.set(rec.id, { ...rec, type: undefined, status: 'interrupted' }); this._nextId = Math.max(this._nextId, rec.id + 1); }
      else if (rec.type === 'end' && this._ops.has(rec.id)) Object.assign(this._ops.get(rec.id), rec.patch, { status: rec.patch.result?.success === false ? 'failed' : 'completed' });
      else if (rec.type === 'patch' && this._ops.has(rec.id)) Object.assign(this._ops.get(rec.id), rec.patch);
    }
  }

  _append(rec) { fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); }

  begin({ action, target, reason = null, missionId = null, agent = 'xoft', previousState = null }) {
    const id = this._nextId++;
    const op = { id, ts: new Date().toISOString(), action, target, reason, missionId, agent, previousState, newState: null, result: null, tests: null, rollback: { available: false }, status: 'pending' };
    this._ops.set(id, op);
    this._append({ type: 'begin', ...op });
    return id;
  }

  complete(id, { result, newState = null, tests = null, rollback = { available: false } }) {
    const patch = { result, newState, tests, rollback, completedAt: new Date().toISOString() };
    const op = this._ops.get(id);
    if (!op) throw new Error(`Journal: unknown operation ${id}`);
    Object.assign(op, patch, { status: result?.success === false ? 'failed' : 'completed' });
    this._append({ type: 'end', id, patch });
    return op;
  }

  patch(id, patch) {
    const op = this._ops.get(id);
    if (!op) throw new Error(`Journal: unknown operation ${id}`);
    Object.assign(op, patch);
    this._append({ type: 'patch', id, patch });
    return op;
  }

  get(id) { return this._ops.get(Number(id)) ?? null; }
  list({ limit = 50 } = {}) { return [...this._ops.values()].sort((a, b) => b.id - a.id).slice(0, limit); }
  interrupted() { return [...this._ops.values()].filter((o) => o.status === 'interrupted'); }
  /** Most recent completed operation that can still be rolled back. */
  latestRollbackable() { return [...this._ops.values()].sort((a, b) => b.id - a.id).find((o) => o.status === 'completed' && o.rollback?.available && !o.rolledBackBy) ?? null; }
}

module.exports = { OperationJournal };
