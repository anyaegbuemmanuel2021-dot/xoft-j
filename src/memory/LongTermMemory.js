import crypto from 'node:crypto';
import { JsonStore } from '../persistence/JsonStore.js';

/** Provenance values a memory entry's `source` may take (spec: memory provenance). AI_INFERRED is never equivalent to a user-stated fact — callers must not upgrade one into the other. */
export const MemorySource = {
  USER_STATED: 'USER_STATED',
  SYSTEM_OBSERVED: 'SYSTEM_OBSERVED',
  API_RETURNED: 'API_RETURNED',
  AI_INFERRED: 'AI_INFERRED',
  USER_CORRECTED: 'USER_CORRECTED',
};

/**
 * LongTermMemory — structured, editable facts store.
 *
 * Persistence goes through JsonStore (Phase 3G): a flat JSON file by
 * default, or the shared SqliteStore `kv` table when one is supplied —
 * either way behind the same get/put/delete/query interface, so swapping
 * storage later means changing JsonStore's caller, not this file's logic.
 *
 * Categories are open-ended strings and double as the memory "type" the
 * spec asks for: 'preference', 'fact', 'execution_failure' (a lesson),
 * 'workflow', 'device', 'integration', etc. — nothing enforces a closed
 * enum, callers choose a category that fits.
 */
export class LongTermMemory {
  constructor({ dataDir = './data', sqliteStore = null } = {}) {
    this._store = new JsonStore({ dataDir, fileName: 'long_term_memory.json', kvKey: 'long_term_memory', defaultValue: { entries: [] }, sqliteStore });
  }

  _load() {
    return this._store.load();
  }

  _save(data) {
    this._store.save(data);
  }

  /**
   * @param {string} category
   * @param {string} content human-readable fact
   * @param {object} [metadata] arbitrary extra fields (e.g. {name:'John', relation:'colleague'})
   * @param {object} [opts]
   * @param {string|null} [opts.source] one of MemorySource — who/what is claiming this is true.
   *   Left as `null` ("unspecified") rather than defaulted to something
   *   reassuring-sounding when a caller doesn't say — an unlabeled fact
   *   should never masquerade as USER_STATED.
   * @param {number|null} [opts.confidence] 0..1 evidence strength. Never fabricated by this class.
   * @param {number|null} [opts.importance] 0..100. Kept alongside (not instead of) the
   *   pre-existing `metadata.importanceScore` some callers already set, for compatibility.
   * @param {string[]} [opts.tags]
   * @param {string|null} [opts.relatedTaskId] links to an existing TaskPlanner task — memory does not duplicate task data.
   * @param {string|null} [opts.relatedDeviceId] links to a device; used for per-device access scoping at the API layer.
   * @param {string|null} [opts.expiresAt] ISO timestamp; an expired entry is excluded from query() by default.
   * @returns {string} id of the new entry
   */
  remember(category, content, metadata = {}, opts = {}) {
    const { source = null, confidence = null, importance = null, tags = [], relatedTaskId = null, relatedDeviceId = null, expiresAt = null } = opts;
    const data = this._load();
    const now = new Date().toISOString();
    const entry = {
      id: crypto.randomUUID(),
      category,
      content,
      metadata,
      source,
      confidence,
      importance,
      tags,
      relatedTaskId,
      relatedDeviceId,
      expiresAt,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: null,
      history: [],
    };
    data.entries.push(entry);
    this._save(data);
    return entry.id;
  }

  /** @returns {Array<object>} */
  query({ category, textIncludes, tag, relatedDeviceId, includeExpired = false } = {}) {
    const data = this._load();
    const now = Date.now();
    return data.entries.filter((e) => {
      if (category && e.category !== category) return false;
      if (textIncludes && !e.content.toLowerCase().includes(textIncludes.toLowerCase())) return false;
      if (tag && !(e.tags ?? []).includes(tag)) return false;
      if (relatedDeviceId !== undefined && e.relatedDeviceId !== relatedDeviceId) return false;
      // An expired entry is never resurfaced by default — same principle as
      // a deleted one not silently reappearing (spec: memory retrieval).
      if (!includeExpired && e.expiresAt && new Date(e.expiresAt).getTime() < now) return false;
      return true;
    });
  }

  getById(id, { markAccessed = false } = {}) {
    const data = this._load();
    const entry = data.entries.find((e) => e.id === id) ?? null;
    if (entry && markAccessed) {
      entry.lastAccessedAt = new Date().toISOString();
      // Mirrors into the pre-existing metadata.lastRecalledAt field too —
      // MemoryRetentionManager (Phase before 3H) reads that field, and
      // changing what it reads is out of this phase's scope. Both stay in
      // sync from this one call site rather than drifting.
      entry.metadata = { ...(entry.metadata ?? {}), lastRecalledAt: entry.lastAccessedAt };
      this._save(data);
    }
    return entry;
  }

  /**
   * Generic field update — content, metadata, tags, importance, links, TTL.
   * NOT a correction: does not touch provenance/history. Use correct() when
   * the user is overriding previously-stated content, not just editing metadata.
   */
  update(id, patch = {}) {
    const data = this._load();
    const idx = data.entries.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    const forbidden = ['id', 'createdAt', 'history']; // structural fields — never overwritten by a plain patch
    const safePatch = Object.fromEntries(Object.entries(patch).filter(([k]) => !forbidden.includes(k)));
    data.entries[idx] = { ...data.entries[idx], ...safePatch, updatedAt: new Date().toISOString() };
    this._save(data);
    return data.entries[idx];
  }

  /**
   * First-class user correction (spec: "memory correction"). Unlike update(),
   * this preserves what the entry used to say — a correction is meaningful
   * audit history, not just an edit — and marks the new content's source as
   * USER_CORRECTED, which itself is a *stronger* signal than a plain
   * USER_STATED entry that was never challenged.
   */
  correct(id, newContent, { reason = null, confidence = null, metadata = null } = {}) {
    const data = this._load();
    const idx = data.entries.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    const prior = data.entries[idx];
    const now = new Date().toISOString();
    data.entries[idx] = {
      ...prior,
      content: newContent,
      source: MemorySource.USER_CORRECTED,
      confidence: confidence ?? prior.confidence,
      metadata: metadata ? { ...prior.metadata, ...metadata } : prior.metadata,
      updatedAt: now,
      history: [...(prior.history ?? []), { content: prior.content, source: prior.source, confidence: prior.confidence, reason, changedAt: now }],
    };
    this._save(data);
    return data.entries[idx];
  }

  /** Deletes a single entry by id. Returns true if something was removed. */
  forget(id) {
    const data = this._load();
    const before = data.entries.length;
    data.entries = data.entries.filter((e) => e.id !== id);
    this._save(data);
    return data.entries.length < before;
  }

  /**
   * Deletes every entry matching a filter — e.g. "delete everything about John".
   * Returns the number of entries removed.
   */
  forgetWhere({ category, textIncludes } = {}) {
    const data = this._load();
    const before = data.entries.length;
    data.entries = data.entries.filter((e) => {
      const matchesCategory = category ? e.category === category : true;
      const matchesText = textIncludes
        ? e.content.toLowerCase().includes(textIncludes.toLowerCase())
        : true;
      // Keep entries that do NOT match both filters
      return !(matchesCategory && matchesText);
    });
    this._save(data);
    return before - data.entries.length;
  }

  all() {
    return this._load().entries;
  }
}
