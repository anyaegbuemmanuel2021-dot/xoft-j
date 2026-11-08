/**
 * ShortTermMemory — in-process sliding window of recent conversation turns,
 * keyed by session id. This is intentionally NOT persisted to disk; it's
 * working memory for the current conversation only. Long-lived facts get
 * promoted to LongTermMemory/VectorMemory by the MemoryManager, not here.
 */
export class ShortTermMemory {
  constructor({ maxTurns = 20 } = {}) {
    this.maxTurns = maxTurns;
    /** @type {Map<string, Array<{role:string, content:string, ts:number}>>} */
    this.sessions = new Map();
  }

  append(sessionId, role, content) {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, []);
    const turns = this.sessions.get(sessionId);
    turns.push({ role, content, ts: Date.now() });
    if (turns.length > this.maxTurns) turns.shift();
  }

  getMessages(sessionId) {
    return (this.sessions.get(sessionId) ?? []).map(({ role, content }) => ({ role, content }));
  }

  clear(sessionId) {
    this.sessions.delete(sessionId);
  }
}
