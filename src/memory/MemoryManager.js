import { ShortTermMemory } from './ShortTermMemory.js';
import { LongTermMemory } from './LongTermMemory.js';
import { VectorMemory } from './VectorMemory.js';
import { EpisodicMemory } from './EpisodicMemory.js';
import { AsyncLocalStorage } from 'node:async_hooks';
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
    this.requestScope = new AsyncLocalStorage();
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

  /**
   * Run a request under a device memory scope. AsyncLocalStorage makes the
   * scope follow awaited calls through the executive brain, planner, tools,
   * and recovery code without relying on every internal caller to remember
   * to forward a device id.
   */
  withScope(deviceId, operation) {
    return this.requestScope.run({ deviceId: deviceId || null }, operation);
  }

  getScopeDeviceId() {
    return this.requestScope.getStore()?.deviceId ?? null;
  }

  _canReadEntry(entry, scopeDeviceId = this.getScopeDeviceId()) {
    return !scopeDeviceId || !entry.relatedDeviceId || entry.relatedDeviceId === scopeDeviceId;
  }

  _assertScopedMutation(id, patch = null) {
    const scopeDeviceId = this.getScopeDeviceId();
    if (!scopeDeviceId) return;
    const entry = this.long.getById(id);
    if (!entry) return; // Preserve the standard not-found return behavior.
    if (entry.relatedDeviceId !== scopeDeviceId) {
      throw new Error('A device token may only modify memory scoped to that same device.');
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'relatedDeviceId')
      && patch.relatedDeviceId !== scopeDeviceId) {
      throw new Error('A device token cannot move its memory into a different or shared scope.');
    }
  }

  _lexicalRecall(query, limit) {
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
          score: matchedTerms.length / terms.length,
          createdAt: entry.createdAt,
          matchType: 'lexical',
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
      .slice(0, limit);
  }

  _refreshVectorEntry(entry) {
    if (!this.vector || !entry) return;
    try {
      this.vector.removeByMetadata('longTermId', entry.id);
    } catch (error) {
      this.vectorEnabled = false;
      console.warn('[XOFT memory] Cannot invalidate the old vector index after a memory edit:', String(error?.message ?? error).slice(0, 200));
      return;
    }
    if (!this.vectorEnabled) return;

    const version = entry.updatedAt;
    const content = entry.content;
    const metadata = {
      ...(entry.metadata ?? {}),
      category: entry.category,
      longTermId: entry.id,
      relatedDeviceId: entry.relatedDeviceId ?? null,
      tags: entry.tags ?? [],
      source: entry.source ?? null,
    };
    this.vector.add(content, metadata, {
      shouldCommit: () => {
        const current = this.long.getById(entry.id);
        return Boolean(current && current.updatedAt === version && current.content === content);
      },
    }).catch((error) => {
      this.vectorEnabled = false;
      const code = error?.status ?? error?.statusCode ?? error?.code;
      console.warn('[XOFT memory] Memory was saved, but its semantic index could not be refreshed.', code ? `code=${String(code).slice(0, 40)}` : '');
    });
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
    const scopeDeviceId = this.getScopeDeviceId();
    let effectiveOpts = opts;
    if (scopeDeviceId) {
      if (opts.relatedDeviceId && opts.relatedDeviceId !== scopeDeviceId) {
        throw new Error('A device token may only create memory scoped to that same device.');
      }
      effectiveOpts = { ...opts, relatedDeviceId: opts.relatedDeviceId ?? scopeDeviceId };
    }

    const longTermId = this.long.remember(category, content, metadata, effectiveOpts);
    let vectorId = null;
    if (this.vectorEnabled) {
      const savedEntry = this.long.getById(longTermId);
      const vectorMetadata = {
        ...(metadata ?? {}),
        category,
        longTermId,
        relatedDeviceId: savedEntry?.relatedDeviceId ?? effectiveOpts.relatedDeviceId ?? null,
        tags: savedEntry?.tags ?? effectiveOpts.tags ?? [],
        source: savedEntry?.source ?? effectiveOpts.source ?? null,
      };
      try {
        vectorId = await this.vector.add(content, vectorMetadata, {
          // If a concurrent forget/correction wins while embeddings are in
          // flight, never write an orphan/stale vector back into the index.
          shouldCommit: () => {
            const current = this.long.getById(longTermId);
            return Boolean(current && current.updatedAt === savedEntry?.updatedAt && current.content === content);
          },
        });
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

  recallStructured({ category, textIncludes, tag, relatedDeviceId, scopeDeviceId, includeExpired, markAccessed = false } = {}) {
    const results = this.long.query({ category, textIncludes, tag, relatedDeviceId, includeExpired });
    const scope = scopeDeviceId ?? this.getScopeDeviceId();
    const visible = results.filter((entry) => this._canReadEntry(entry, scope));
    if (markAccessed) visible.forEach((entry) => this.long.getById(entry.id, { markAccessed: true }));
    return visible;
  }
  update(id, patch = {}) {
    this._assertScopedMutation(id, patch);
    const updated = this.long.update(id, patch);
    if (updated) this._refreshVectorEntry(updated);
    return updated;
  }
  correct(id, newContent, opts = {}) {
    this._assertScopedMutation(id);
    const updated = this.long.correct(id, newContent, opts);
    if (updated) this._refreshVectorEntry(updated);
    return updated;
  }

  /**
   * Prefer real semantic vectors, but validate every result against the
   * authoritative structured record before returning it. This prevents
   * deleted, corrected, or cross-device records from leaking through a stale
   * vector index. A local lexical pass fills gaps and remains usable offline.
   */
  async recallSemantic(query, topK = 5) {
    const limit = Number.isFinite(Number(topK)) ? Math.max(0, Math.floor(Number(topK))) : 5;
    if (limit === 0) return [];

    const scopeDeviceId = this.getScopeDeviceId();
    const results = [];
    const seen = new Set();
    if (this.vectorEnabled) {
      try {
        const candidates = await this.vector.search(String(query ?? ''), Math.max(20, limit * 4));
        for (const candidate of candidates) {
          const longTermId = candidate.metadata?.longTermId;
          if (!longTermId || seen.has(longTermId)) continue;
          const current = this.long.getById(longTermId);
          if (!current || candidate.content !== current.content) continue;
          if (scopeDeviceId && current.relatedDeviceId && current.relatedDeviceId !== scopeDeviceId) continue;
          seen.add(longTermId);
          results.push({
            ...candidate,
            id: current.id,
            content: current.content,
            metadata: {
              ...(candidate.metadata ?? {}),
              category: current.category,
              tags: current.tags ?? [],
              longTermId: current.id,
              relatedDeviceId: current.relatedDeviceId ?? null,
            },
            matchType: 'semantic',
          });
          if (results.length >= limit) break;
        }
      } catch (error) {
        this.vectorEnabled = false;
        const code = error?.status ?? error?.statusCode ?? error?.code;
        console.warn(
          '[XOFT memory] Semantic provider unavailable; using local lexical recall.',
          code ? `code=${String(code).slice(0, 40)}` : ''
        );
      }
    }

    // Hybrid fill recovers newly edited or not-yet-indexed records without
    // replacing semantic results or pretending local keyword scores are vectors.
    if (results.length < limit) {
      for (const candidate of this._lexicalRecall(query, limit)) {
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        results.push(candidate);
        if (results.length >= limit) break;
      }
    }
    return results;
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
    const scopeDeviceId = this.getScopeDeviceId();
    if (scopeDeviceId && entry && entry.relatedDeviceId !== scopeDeviceId) {
      throw new Error('A device token may only delete memory scoped to that same device.');
    }
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
    const scopeDeviceId = this.getScopeDeviceId();
    // Shared memory is readable by devices but only an admin may delete it.
    const toRemove = this.long.query(filter)
      .filter((entry) => !scopeDeviceId || entry.relatedDeviceId === scopeDeviceId);
    let removedCount = 0;
    for (const entry of toRemove) {
      const ok = await this.forgetById(entry.id);
      if (ok) removedCount += 1;
    }
    return removedCount;
  }
}
