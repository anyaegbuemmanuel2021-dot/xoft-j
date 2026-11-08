import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * ActivityLog — append-only record of what the system did. Per spec section
 * 24/30: the user should always be able to answer "what did you do and why."
 * File-backed JSON for now; swap for a real DB table (activity_logs) later
 * without changing the log()/query() interface.
 */
export class ActivityLog {
  constructor({ dataDir = './data' } = {}) {
    this.filePath = path.join(dataDir, 'activity_log.json');
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({ entries: [] }, null, 2));
    }
  }

  _load() {
    return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
  }

  _save(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  /**
   * @param {object} event
   * @param {string} event.type e.g. 'task_created' | 'tool_executed' | 'approval_requested' | 'approval_granted' | 'approval_denied' | 'task_failed' | 'task_completed'
   * @param {string} [event.taskId]
   * @param {string} [event.toolName]
   * @param {object} [event.detail]
   */
  log(event) {
    const data = this._load();
    const entry = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      ...event,
    };
    data.entries.push(entry);
    this._save(data);
    return entry.id;
  }

  query({ taskId } = {}) {
    const data = this._load();
    return taskId ? data.entries.filter((e) => e.taskId === taskId) : data.entries;
  }

  all() {
    return this._load().entries;
  }
}
