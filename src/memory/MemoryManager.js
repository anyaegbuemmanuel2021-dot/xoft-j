import { ShortTermMemory } from './ShortTermMemory.js';
import { LongTermMemory } from './LongTermMemory.js';
import { VectorMemory } from './VectorMemory.js';
import { EpisodicMemory } from './EpisodicMemory.js';
import { ProceduralMemory } from './ProceduralMemory.js';

/**
 * MemoryManager — single entry point the Orchestrator and agents use for
 * everything memory-related. Wraps:
 *   - ShortTermMemory: current conversation buffer
 *   - LongTermMemory:  structured, categorized facts (editable, deletable)
 *   - VectorMemory:    semantic search over past content
 *
 * Deletion is a first-class operation, not an afterthought: forget() removes
 * from both structured and vector stores so "forget that" / "delete
 * everything about John" actually clears what it claims to.
 */
export class MemoryManager {
  /**
   * @param {object} deps
   * @param {import('../providers/ProviderRouter.js').ProviderRouter} deps.router
   * @param {string} deps.dataDir
   */
  constructor({ router, dataDir = './data', sqliteStore = null }) {
    this.short = new ShortTermMemory();
    this.long = new LongTermMemory({ dataDir, sqliteStore });
    this.episodic = new EpisodicMemory({ dataDir, sqliteStore });
    this.procedural = new ProceduralMemory({ dataDir, sqliteStore });

    // Vector memory needs an embedding function; only wire it up if an
    // embedding-capable provider is actually configured. Otherwise semantic
    // recall is unavailable and callers get a clear error, not fake results.
    let embedProvider = null;
    try {
      embedProvider = router.selectEmbedding();
    } catch {
      embedProvider = null;
    }
    this.vectorEnabled = Boolean(embedProvider);
    if (this.vectorEnabled) {
      this.vector = new VectorMemory({
        dataDir,
        sqliteStore,
        embedFn: (text) => embedProvider.embed(text),
      });
    }
  }

  // --- conversation buffer ---
  addTurn(sessionId, role, content) {
    this.short.append(sessionId, role, content);
  }

  getConversation(sessionId) {
    return this.short.getMessages(sessionId);
  }

  // --- remembering ---
  /**
   * Stores a fact in structured memory, and in vector memory if available.
   * @param {object} [opts] provenance/confidence/tags/links — see LongTermMemory.remember.
   * @returns {Promise<{longTermId:string, vectorId:string|null}>}
   */
  async remember(category, content, metadata = {}, opts = {}) {
    const longTermId = this.long.remember(category, content, metadata, opts);
    let vectorId = null;
    if (this.vectorEnabled) {
      vectorId = await this.vector.add(content, { category, longTermId, ...metadata });
    }
    return { longTermId, vectorId };
  }

  // --- recalling ---
  /** Exact/structured lookup: by category, text, tag, and/or device. Pass markAccessed:true from genuine "recall" call sites (not passive listing) to update lastAccessedAt. */
  recallStructured({ category, textIncludes, tag, relatedDeviceId, includeExpired, markAccessed = false } = {}) {
    const results = this.long.query({ category, textIncludes, tag, relatedDeviceId, includeExpired });
    if (markAccessed) results.forEach((e) => this.long.getById(e.id, { markAccessed: true }));
    return results;
  }

  /**
   * Generic edit — content/metadata/tags/importance/links/TTL. Does not
   * touch provenance/history; use correct() for a user overriding content.
   * Vector memory is intentionally NOT re-embedded here — that would need a
   * real embedding call this method doesn't make. A corrected/updated
   * entry's *structured* content is authoritative immediately; its semantic
   * search twin (if any) reflects the old text until re-remembered. Known
   * limitation, not silently glossed over.
   */
  update(id, patch) {
    return this.long.update(id, patch);
  }

  /** First-class user correction — see LongTermMemory.correct for what this preserves. */
  correct(id, newContent, opts = {}) {
    return this.long.correct(id, newContent, opts);
  }

  /** Semantic lookup: "what do you remember about X" style queries. */
  async recallSemantic(query, topK = 5) {
    if (!this.vectorEnabled) {
      throw new Error(
        'MemoryManager: semantic recall requires an embedding provider (OPENAI_API_KEY). ' +
          'Structured recall via recallStructured() still works without it.'
      );
    }
    return this.vector.search(query, topK);
  }

  // --- episodic (narrative "what happened") ---
  recordEpisode(opts) { return this.episodic.record(opts); }
  recallEpisodes(opts) { return this.episodic.recall(opts); }
  episodeTimeline(opts) { return this.episodic.timeline(opts); }

  // --- procedural (learned "how to do X") ---
  learnProcedure(goalTag, task) { return this.procedural.learnFromTask(goalTag, task); }
  recallProcedures(goalTag, limit) { return this.procedural.recall(goalTag, limit); }

  // --- forgetting ---
  /** Forgets a single structured entry (and its vector twin, if any) by long-term id. */
  async forgetById(longTermId) {
    const entry = this.long.getById(longTermId);
    const removedStructured = this.long.forget(longTermId);
    if (this.vectorEnabled && entry) {
      // vector entries store longTermId in metadata; find and remove matches
      const matches = await this.vector.search(entry.content, 50);
      for (const m of matches) {
        if (m.metadata?.longTermId === longTermId) this.vector.remove(m.id);
      }
    }
    return removedStructured;
  }

  /**
   * Forgets everything matching a filter, e.g. forgetWhere({textIncludes:'John'}).
   * This is what "delete everything you remember about John" maps to.
   * @returns {Promise<number>} count of structured entries removed
   */
  async forgetWhere(filter) {
    const toRemove = this.long.query(filter);
    let removedCount = 0;
    for (const entry of toRemove) {
      const ok = await this.forgetById(entry.id);
      if (ok) removedCount += 1;
    }
    return removedCount;
  }
}
