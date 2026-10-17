import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JsonStore } from '../persistence/JsonStore.js';
import { TERMINAL_STATES } from './constants.js';
import { redactDeep } from './redact.js';

const MAX_TASKS = 500; // oldest *terminal* tasks are pruned beyond this
const MAX_EVENT_BYTES_PER_TASK = 4 * 1024 * 1024;

/**
 * EngineTaskStore — durable state for engine tasks (spec sections 9, 10, 23, 24).
 *
 *  • Task records live in a JsonStore (`engine-tasks`), so they follow the project's STORAGE_MODE (JSON files or SQLite)
 *    exactly like tasks.json / approvals.json do, and survive restarts.
 *  • The event log is append-only JSON-lines, one file per task (data/engines/events/<id>.jsonl). Tool events arrive far
 *    faster than a whole-file JSON rewrite can keep up with, so they deliberately do not go through JsonStore/ActivityLog.
 *    Every event is passed through redactDeep() before it touches disk — secrets are never logged.
 */
export class EngineTaskStore {
  constructor({ dataDir = './data', sqliteStore = null } = {}) {
    this.dataDir = dataDir;
    this.eventsDir = path.join(dataDir, 'engines', 'events');
    fs.mkdirSync(this.eventsDir, { recursive: true });
    this._store = new JsonStore({ dataDir, fileName: 'engine-tasks.json', kvKey: 'engine_tasks', defaultValue: { tasks: [] }, sqliteStore });
    this._seq = new Map();
  }

  _load() { return this._store.load(); }
  _save(data) { this._store.save(data); }

  create(record) {
    const data = this._load();
    const task = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...record };
    data.tasks.push(task);
    if (data.tasks.length > MAX_TASKS) {
      const keep = [];
      let excess = data.tasks.length - MAX_TASKS;
      for (const t of data.tasks) { if (excess > 0 && TERMINAL_STATES.has(t.state)) { excess--; this._removeEvents(t.id); } else keep.push(t); }
      data.tasks = keep;
    }
    this._save(data);
    return task;
  }

  get(id) { return this._load().tasks.find((t) => t.id === id) ?? null; }
  list({ state, engine, limit } = {}) {
    let tasks = this._load().tasks;
    if (state) tasks = tasks.filter((t) => (Array.isArray(state) ? state.includes(t.state) : t.state === state));
    if (engine) tasks = tasks.filter((t) => t.engine === engine);
    tasks = tasks.slice().reverse();
    return limit ? tasks.slice(0, limit) : tasks;
  }

  /** Applies `patch` (object or fn(task)→object) to a task and returns the updated record, or null if it vanished. */
  update(id, patch) {
    const data = this._load();
    const i = data.tasks.findIndex((t) => t.id === id);
    if (i === -1) return null;
    const delta = typeof patch === 'function' ? patch(data.tasks[i]) : patch;
    data.tasks[i] = { ...data.tasks[i], ...delta, updatedAt: new Date().toISOString() };
    this._save(data);
    return data.tasks[i];
  }

  // ---- event log ----------------------------------------------------------------------------------------

  _eventFile(id) { return path.join(this.eventsDir, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.jsonl`); }
  _removeEvents(id) { try { fs.unlinkSync(this._eventFile(id)); } catch { /* none */ } }

  _nextSeq(id) {
    if (!this._seq.has(id)) {
      let n = 0;
      try { const text = fs.readFileSync(this._eventFile(id), 'utf8'); n = text ? text.split('\n').filter(Boolean).length : 0; } catch { /* new file */ }
      this._seq.set(id, n);
    }
    const next = this._seq.get(id) + 1;
    this._seq.set(id, next);
    return next;
  }

  /** Appends one event (redacted). Returns the stored envelope, or null if the per-task size cap was reached. */
  appendEvent(id, event) {
    const file = this._eventFile(id);
    try { if (fs.existsSync(file) && fs.statSync(file).size > MAX_EVENT_BYTES_PER_TASK) return null; } catch { /* ignore */ }
    const envelope = { seq: this._nextSeq(id), ts: new Date().toISOString(), ...redactDeep(event, { maxString: 2000 }) };
    fs.appendFileSync(file, `${JSON.stringify(envelope)}\n`);
    return envelope;
  }

  /** @param {{after?:number, limit?:number, types?:string[]}} [q] */
  events(id, { after = 0, limit = 500, types = null } = {}) {
    let text = '';
    try { text = fs.readFileSync(this._eventFile(id), 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.seq <= after) continue;
      if (types && !types.includes(e.type)) continue;
      out.push(e);
    }
    return limit ? out.slice(-limit) : out;
  }
}
