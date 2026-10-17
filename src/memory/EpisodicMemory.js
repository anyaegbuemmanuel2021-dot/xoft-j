import crypto from 'node:crypto';
import { JsonStore } from '../persistence/JsonStore.js';

/**
 * EpisodicMemory — "what happened, when, in what context" as a narrative
 * timeline, distinct from the other two memory stores it sits alongside:
 *   - LongTermMemory: atomic structured FACTS ("user's dentist is Dr. Kim")
 *   - ExperienceStore: narrow tool-failure/recovery ledger, keyed by
 *     (toolName, failureCategory, recoveryStrategy)
 *
 * An episode is a bounded slice of real activity — a conversation turn, a
 * completed task, a mission run — recorded as it actually happened, with
 * real participants/outcome, not a paraphrase invented after the fact.
 * Nothing here is generated; every field is supplied by the caller from
 * data that already exists (task/mission records, chat turns).
 */
export class EpisodicMemory {
  constructor({ dataDir = './data', sqliteStore = null } = {}) {
    this._store = new JsonStore({ dataDir, fileName: 'episodes.json', kvKey: 'episodes', defaultValue: { episodes: [] }, sqliteStore });
  }

  _load() { return this._store.load(); }
  _save(data) { this._store.save(data); }

  /**
   * @param {object} ep
   * @param {string} ep.kind free-form category, e.g. 'conversation' | 'task' | 'mission' | 'device_action'
   * @param {string} ep.summary plain-text description of what happened (caller-supplied, not invented here)
   * @param {string} [ep.outcome] 'completed' | 'failed' | 'partial' | 'ongoing'
   * @param {object} [ep.participants] e.g. { deviceId, taskId, missionId }
   * @param {string[]} [ep.tags]
   */
  record({ kind, summary, outcome = null, participants = {}, tags = [] }) {
    if (!kind || !summary) throw new Error('EpisodicMemory.record requires kind and summary');
    const data = this._load();
    const episode = { id: crypto.randomUUID(), kind, summary, outcome, participants, tags, occurredAt: new Date().toISOString() };
    data.episodes.push(episode);
    // Bounded — this is a recall aid, not the audit trail (ActivityLog already serves that role durably).
    if (data.episodes.length > 5000) data.episodes = data.episodes.slice(-5000);
    this._save(data);
    return episode;
  }

  /** Recent episodes, optionally filtered by kind/tag/date range — real filtering, no invented relevance score. */
  recall({ kind, tag, since, limit = 20 } = {}) {
    let episodes = this._load().episodes;
    if (kind) episodes = episodes.filter((e) => e.kind === kind);
    if (tag) episodes = episodes.filter((e) => e.tags.includes(tag));
    if (since) { const t = new Date(since).getTime(); episodes = episodes.filter((e) => new Date(e.occurredAt).getTime() >= t); }
    return episodes.slice(-limit).reverse();
  }

  /** Plain-language recap for a window of time — concatenation, not an AI summary (callers wanting a narrated recap should feed this into router.complete themselves). */
  timeline({ since, limit = 50 } = {}) {
    return this.recall({ since, limit }).map((e) => `[${e.occurredAt}] (${e.kind}${e.outcome ? `/${e.outcome}` : ''}) ${e.summary}`);
  }

  forget(id) {
    const data = this._load();
    const before = data.episodes.length;
    data.episodes = data.episodes.filter((e) => e.id !== id);
    this._save(data);
    return data.episodes.length < before;
  }

  list() { return this._load().episodes; }
}
