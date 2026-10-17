import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

/**
 * VectorMemory — semantic recall over past facts/conversation snippets.
 *
 * Uses real embeddings (via the injected embedding provider — currently
 * OpenAI's embeddings endpoint) and does the similarity search in-process
 * with cosine similarity. This is honest about its limits: it's O(n) per
 * query and fine for thousands of memories, not millions. If this ever
 * needs to scale past that, swap the storage for a real vector DB (pgvector,
 * Pinecone, etc.) behind this same add()/search() interface.
 *
 * REQUIRES: an embedding-capable provider. Without one configured, add()
 * and search() throw clearly rather than silently storing un-embedded text.
 */
export class VectorMemory {
  constructor({ dataDir = './data', embedFn, sqliteStore = null }) {
    this.filePath = path.join(dataDir, 'vector_memory.json');
    this.sqliteStore = sqliteStore;
    this.kvKey = 'vector_memory';
    if (!this.sqliteStore) {
      fs.mkdirSync(dataDir, { recursive: true });
      if (!fs.existsSync(this.filePath)) {
        fs.writeFileSync(this.filePath, JSON.stringify({ entries: [] }, null, 2));
      }
    }
    if (typeof embedFn !== 'function') {
      throw new Error('VectorMemory requires an embedFn(text) => Promise<number[]>');
    }
    this.embedFn = embedFn;
  }

  _load() {
    if (this.sqliteStore) return this.sqliteStore.get(this.kvKey) || { entries: [] };
    return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
  }

  _save(data) {
    if (this.sqliteStore) {
      this.sqliteStore.set(this.kvKey, data);
      return;
    }
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  async add(content, metadata = {}) {
    const vector = await this.embedFn(content);
    const data = this._load();
    const entry = {
      id: crypto.randomUUID(),
      content,
      metadata,
      vector,
      createdAt: new Date().toISOString(),
    };
    data.entries.push(entry);
    this._save(data);
    return entry.id;
  }

  /**
   * @param {string} query
   * @param {number} topK
   * @returns {Promise<Array<{id:string, content:string, metadata:object, score:number}>>}
   */
  async search(query, topK = 5) {
    const data = this._load();
    if (data.entries.length === 0) return [];
    const queryVector = await this.embedFn(query);
    return data.entries
      .map((e) => ({
        id: e.id,
        content: e.content,
        metadata: e.metadata,
        score: cosineSimilarity(queryVector, e.vector),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  remove(id) {
    const data = this._load();
    const before = data.entries.length;
    data.entries = data.entries.filter((e) => e.id !== id);
    this._save(data);
    return data.entries.length < before;
  }
}
