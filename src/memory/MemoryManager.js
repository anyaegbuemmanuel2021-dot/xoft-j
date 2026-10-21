import { ShortTermMemory } from './ShortTermMemory.js';
import { LongTermMemory } from './LongTermMemory.js';
import { VectorMemory } from './VectorMemory.js';
import { EpisodicMemory } from './EpisodicMemory.js';
import { ProceduralMemory } from './ProceduralMemory.js';

// Keep the local fallback useful without treating common grammatical words as
// meaningful matches. Negations (not/no/never) deliberately remain searchable.
const MEMORY_STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an',
  'and', 'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before',
  'being', 'below', 'between', 'both', 'but', 'by', 'can', 'could', 'did',
  'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from',
  'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers',
  'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is',
  'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my', 'myself',
  'of', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves',
  'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such',
  'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then',
  'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under',
  'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'you', 'your',
  'yours', 'yourself', 'yourselves',
]);

function memoryTokens(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

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
      try {
        vectorId = await this.vector.add(content, { category, longTermId, ...metadata });
      } catch (error) {
        // Structured memory is authoritative. Stop repeated provider calls for
        // this process after quota/network/storage failure; local recall remains.
        this.vectorEnabled = false;
        const code = error?.status ?? error?.statusCode ?? error?.code;
        console.warn(
          '[XOFT memory] Embeddings unavailable; structured memory was saved and local recall remains active.',
          code ? `code=${String(code).slice(0, 40)}` : ''
        );
      }
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

  /**
   * Semantic lookup prefers provider-backed vectors while available. When the
   * provider is absent or fails, transparently fall back to a deterministic
   * local lexical ranking over non-expired structured memory.
   */
  async recallSemantic(query, topK = 5) {
    const limit = Number.isFinite(Number(topK)) ? Math.max(0, Math.floor(Number(topK))) : 5;
    if (limit === 0) return [];

    if (this.vectorEnabled) {
      try {
        return await this.vector.search(String(query ?? ''), limit);
      } catch (error) {
        this.vectorEnabled = false;
        const code = error?.status ?? error?.statusCode ?? error?.code;
        console.warn(
          '[XOFT memory] Semantic provider unavailable; using local lexical recall.',
          code ? `code=${String(code).slice(0, 40)}` : ''
        );
      }
    }

    const terms = [...new Set(memoryTokens(query))]
      .filter((term) => term.length > 1 && !MEMORY_STOP_WORDS.has(term));
    if (terms.length === 0) return [];

    return this.recallStructured()
      .map((entry) => {
        const indexedText = [
          entry.content ?? '',
          entry.category ?? '',
          ...(Array.isArray(entry.tags) ? entry.tags : []),
          JSON.stringify(entry.metadata ?? {}),
        ].join(' ');
        const indexedTerms = new Set(memoryTokens(indexedText));
        const matchedTerms = terms.filter((term) => indexedTerms.has(term));
        const score = matchedTerms.length / terms.length;
        return {
          id: entry.id,
          content: entry.content,
          metadata: {
            category: entry.category,
            ...(entry.metadata ?? {}),
            tags: entry.tags ?? [],
            longTermId: entry.id,
            relatedDeviceId: entry.relatedDeviceId ?? null,
          },
          score,
          createdAt: entry.createdAt,
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
      .slice(0, limit);
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
  /**
   * Structured memory is authoritative. Remove its vector twin by exact stored
   * metadata, not semantic search; this works offline, costs no API calls, and
   * prevents forgotten content from resurfacing after a restart.
   */
  async forgetById(longTermId) {
    const entry = this.long.getById(longTermId);
    const removedStructured = this.long.forget(longTermId);
    if (this.vector && entry) {
      try {
        this.vector.removeByMetadata('longTermId', longTermId);
      } catch (error) {
        this.vectorEnabled = false;
        const code = error?.status ?? error?.statusCode ?? error?.code;
        console.warn(
          '[XOFT memory] Vector cleanup failed; structured deletion succeeded.',
          code ? `code=${String(code).slice(0, 40)}` : ''
        );
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
