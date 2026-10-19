import { ShortTermMemory } from './ShortTermMemory.js';
import { LongTermMemory } from './LongTermMemory.js';
import { VectorMemory } from './VectorMemory.js';
import { EpisodicMemory } from './EpisodicMemory.js';
import { ProceduralMemory } from './ProceduralMemory.js';

/**
 * MemoryManager — single entry point for XOFT memory.
 *
 * Structured memory is the source of truth. Embeddings are an optional
 * enhancement only: a provider quota/network error must never undo or block
 * a successful structured-memory write.
 */
export class MemoryManager {
  constructor({ router, dataDir = './data', sqliteStore = null }) {
    this.short = new ShortTermMemory();
    this.long = new LongTermMemory({ dataDir, sqliteStore });
    this.episodic = new EpisodicMemory({ dataDir, sqliteStore });
    this.procedural = new ProceduralMemory({ dataDir, sqliteStore });

    let embedProvider = null;
    try {
      embedProvider = router?.selectEmbedding?.() ?? null;
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

  addTurn(sessionId, role, content) {
    this.short.append(sessionId, role, content);
  }

  getConversation(sessionId) {
    return this.short.getMessages(sessionId);
  }

  /**
   * Always persist the structured fact first. Embeddings are best-effort;
   * quota exhaustion (including OpenAI 429 insufficient_quota) must not turn
   * a successful memory write into a failed user request.
   */
  async remember(category, content, metadata = {}, opts = {}) {
    const longTermId = this.long.remember(category, content, metadata, opts);
    let vectorId = null;
    if (this.vectorEnabled) {
      try {
        vectorId = await this.vector.add(content, { category, longTermId, ...metadata });
      } catch (error) {
        // Disable repeated failing calls for this process. Structured memory
        // remains available and is authoritative; restart may retry embeddings.
        this.vectorEnabled = false;
        console.warn('[XOFT memory] Embeddings unavailable; saved structured memory only:', error?.message ?? error);
      }
    }
    return { longTermId, vectorId };
  }

  recallStructured({ category, textIncludes, tag, relatedDeviceId, includeExpired, markAccessed = false } = {}) {
    const results = this.long.query({ category, textIncludes, tag, relatedDeviceId, includeExpired });
    if (markAccessed) results.forEach((e) => this.long.getById(e.id, { markAccessed: true }));
    return results;
  }

  update(id, patch) {
    return this.long.update(id, patch);
  }

  correct(id, newContent, opts = {}) {
    return this.long.correct(id, newContent, opts);
  }

  /**
   * Semantic lookup prefers vectors when available. If embeddings are missing
   * or fail, use a transparent local lexical ranking over structured memory.
   * This is not vector semantics, but it provides useful offline recall without
   * claiming embeddings succeeded or making a paid API request.
   */
  async recallSemantic(query, topK = 5) {
    if (this.vectorEnabled) {
      try {
        return await this.vector.search(query, topK);
      } catch (error) {
        this.vectorEnabled = false;
        console.warn('[XOFT memory] Semantic embeddings unavailable; using local text search:', error?.message ?? error);
      }
    }

    const terms = [...new Set(String(query ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
      .filter((term) => term.length > 1);
    if (!terms.length) return [];

    return this.recallStructured()
      .map((entry) => {
        const text = `${entry.content ?? ''} ${entry.category ?? ''} ${(entry.tags ?? []).join(' ')}`.toLowerCase();
        const matched = terms.filter((term) => text.includes(term)).length;
        return {
          id: entry.id,
          content: entry.content,
          metadata: { category: entry.category, ...(entry.metadata ?? {}), longTermId: entry.id },
          score: matched / terms.length,
          createdAt: entry.createdAt,
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, topK));
  }

  recordEpisode(opts) { return this.episodic.record(opts); }
  recallEpisodes(opts) { return this.episodic.recall(opts); }
  episodeTimeline(opts) { return this.episodic.timeline(opts); }

  learnProcedure(goalTag, task) { return this.procedural.learnFromTask(goalTag, task); }
  recallProcedures(goalTag, limit) { return this.procedural.recall(goalTag, limit); }

  /** Structured memory is authoritative; vector cleanup is best-effort. */
  async forgetById(longTermId) {
    const entry = this.long.getById(longTermId);
    const removedStructured = this.long.forget(longTermId);
    if (this.vectorEnabled && entry) {
      try {
        const matches = await this.vector.search(entry.content, 50);
        for (const match of matches) {
          if (match.metadata?.longTermId === longTermId) this.vector.remove(match.id);
        }
      } catch (error) {
        this.vectorEnabled = false;
        console.warn('[XOFT memory] Could not clean up vector entry; structured deletion succeeded:', error?.message ?? error);
      }
    }
    return removedStructured;
  }

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
