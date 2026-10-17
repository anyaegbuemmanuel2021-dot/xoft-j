import crypto from 'node:crypto';
import { JsonStore } from '../persistence/JsonStore.js';

/**
 * ProceduralMemory — "how to do X", learned from real completed task plans,
 * as a reusable named procedure (an ordered list of {toolName, input}
 * templates). Distinct from:
 *   - ExperienceStore: what happened when a SINGLE STEP failed and a
 *     recovery was tried (per-step, failure-triggered)
 *   - EpisodicMemory: a narrative record that something happened
 *
 * ProceduralMemory instead captures a whole successful MULTI-STEP sequence
 * so a future similar goal can be planned faster / more reliably by
 * recalling how it was actually done last time — evidence to inform
 * TaskPlanner.plan(), never a substitute for it (spec: "memory is evidence,
 * not absolute truth"). No confidence number is stored per procedure; like
 * ExperienceStore, success rate is derived on read from real recorded runs.
 */
export class ProceduralMemory {
  constructor({ dataDir = './data', sqliteStore = null } = {}) {
    this._store = new JsonStore({ dataDir, fileName: 'procedures.json', kvKey: 'procedures', defaultValue: { procedures: [] }, sqliteStore });
  }

  _load() { return this._store.load(); }
  _save(data) { this._store.save(data); }

  static templateSteps(steps) {
    // Strip run-specific values (results, timestamps, attempts) — keep only
    // the reusable shape: which tool, in what order, with what input keys.
    return steps.map((s) => ({ toolName: s.toolName, inputKeys: Object.keys(s.input ?? {}), description: s.description ?? null }));
  }

  /**
   * Learn a procedure from a task that actually completed. Idempotent by
   * (goalTag, step-shape signature): a repeat of the same real sequence
   * increments runCount/successCount on the existing entry rather than
   * duplicating it, so success rate reflects genuine accumulated history.
   */
  learnFromTask(goalTag, task) {
    if (!goalTag || !task?.steps?.length) return null;
    const templated = ProceduralMemory.templateSteps(task.steps);
    const signature = templated.map((s) => `${s.toolName}(${s.inputKeys.join(',')})`).join('->');
    const data = this._load();
    const success = task.status === 'completed';
    let proc = data.procedures.find((p) => p.goalTag === goalTag && p.signature === signature);
    if (!proc) {
      proc = { id: crypto.randomUUID(), goalTag, signature, steps: templated, runCount: 0, successCount: 0, createdAt: new Date().toISOString(), lastRunAt: null };
      data.procedures.push(proc);
    }
    proc.runCount += 1;
    if (success) proc.successCount += 1;
    proc.lastRunAt = new Date().toISOString();
    this._save(data);
    return proc;
  }

  /** Best-known procedures for a goal tag, ranked by real (successCount/runCount), highest first. No entry with zero runs is possible — learnFromTask always increments runCount on creation. */
  recall(goalTag, limit = 3) {
    return this._load().procedures
      .filter((p) => p.goalTag === goalTag)
      .map((p) => ({ ...p, successRate: p.successCount / p.runCount }))
      .sort((a, b) => b.successRate - a.successRate || b.runCount - a.runCount)
      .slice(0, limit);
  }

  list() { return this._load().procedures; }

  forget(id) {
    const data = this._load();
    const before = data.procedures.length;
    data.procedures = data.procedures.filter((p) => p.id !== id);
    this._save(data);
    return data.procedures.length < before;
  }
}
