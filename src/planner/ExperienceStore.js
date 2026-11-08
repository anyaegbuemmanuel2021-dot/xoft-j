import crypto from 'node:crypto';
import { JsonStore } from '../persistence/JsonStore.js';

/**
 * ExperienceStore — persists what actually happened when a step failed and a
 * recovery strategy was tried (spec: "Experience Store" / "self-correction").
 *
 * Deliberate departure from the spec's literal example shape: it shows a
 * `confidence` number stored directly on each experience record. Storing an
 * invented per-event confidence would be exactly the "fake self-learning"
 * the same spec explicitly forbids ("No Fake Intelligence" — memory must be
 * represented in real state, not decorated with a number nobody computed).
 * So confidence here is never written to a record; it's *derived* on
 * retrieval from the real historical success rate for that
 * (toolName, failureCategory, recoveryStrategy) combination — an honest
 * number that changes as more real outcomes accumulate, not a guess.
 *
 * Persists to <dataDir>/experiences.json — same flat-file model as the rest
 * of this project's persistence.
 */
export class ExperienceStore {
  constructor({ dataDir = './data', sqliteStore = null } = {}) {
    this._store = new JsonStore({ dataDir, fileName: 'experiences.json', kvKey: 'experiences', defaultValue: { experiences: [] }, sqliteStore });
  }

  _load() {
    return this._store.load();
  }

  _save(data) {
    this._store.save(data);
  }

  /** A shape-only fingerprint of a tool input — which fields were present, not their values (avoids persisting arbitrary/sensitive content into a long-lived learning store). */
  static inputSignature(input) {
    return Object.keys(input ?? {}).sort().join(',') || '(no input)';
  }

  /**
   * Records one real observation: a failure, the strategy tried in response,
   * and what actually happened next. `taskType` uses toolName as a proxy —
   * this project doesn't yet have a separate task-type taxonomy, and
   * inventing one here would be exactly the kind of unused abstraction the
   * implementation rules warn against.
   */
  record({ toolName, failureCategory, errorMessage, recoveryStrategy, recoveryOutcome, inputSignature, environment = {} }) {
    const data = this._load();
    const entry = {
      id: crypto.randomUUID(),
      taskType: toolName,
      toolName,
      failureCategory: failureCategory ?? 'unknown',
      errorMessage: String(errorMessage ?? '').slice(0, 300),
      recoveryStrategy: recoveryStrategy ?? 'none',
      recoveryOutcome, // 'recovered' | 'failed' | 'aborted' | 'exhausted' | 'not_attempted'
      inputSignature: inputSignature ?? '(unknown)',
      environment,
      createdAt: new Date().toISOString(),
    };
    data.experiences.push(entry);
    // Bounded growth — keep the most recent 2000 observations. This is a
    // learning ledger, not an audit log (ActivityLog already serves that
    // role durably); old, low-value observations are the right thing to drop.
    if (data.experiences.length > 2000) data.experiences = data.experiences.slice(-2000);
    this._save(data);
    return entry;
  }

  /**
   * Past observations relevant to a new failure of the same tool/category —
   * for RecoveryEngine to consider, NOT to blindly repeat (spec: "memory is
   * evidence, not absolute truth; verify important actions").
   */
  relevantFor({ toolName, failureCategory }, limit = 10) {
    return this._load()
      .experiences.filter((e) => e.toolName === toolName && (!failureCategory || e.failureCategory === failureCategory))
      .slice(-limit)
      .reverse();
  }

  /**
   * Derived confidence for a specific (tool, failureCategory, strategy)
   * combination: real success rate over real past attempts, not a stored
   * guess. Returns null (not 0) when there's no history yet — "no data" and
   * "always fails" must never look the same to a caller.
   */
  confidenceFor({ toolName, failureCategory, recoveryStrategy }) {
    const matches = this._load().experiences.filter(
      (e) => e.toolName === toolName && e.failureCategory === failureCategory && e.recoveryStrategy === recoveryStrategy
    );
    if (matches.length === 0) return null;
    const successes = matches.filter((e) => e.recoveryOutcome === 'recovered').length;
    return { confidence: successes / matches.length, sampleSize: matches.length };
  }

  list() {
    return this._load().experiences;
  }
}
