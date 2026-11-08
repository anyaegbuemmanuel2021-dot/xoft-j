/**
 * MemoryRetentionManager — spec section 15. Decides what's SAFE TO REVIEW
 * for pruning based on real signals already on each entry (age, importance
 * score if one was computed, whether it's ever been recalled). Never
 * deletes anything on its own — returns candidates for the caller (or the
 * user, via a confirmation step) to actually remove via LongTermMemory.
 */
export class MemoryRetentionManager {
  /**
   * @param {Array<object>} entries LongTermMemory entries (need createdAt;
   *   optionally metadata.importanceScore, metadata.lastRecalledAt)
   * @param {{maxAgeDays?: number, importanceThreshold?: number}} [options]
   * @returns {Array<object>} candidate entries — old AND (low-importance or never recalled)
   */
  findPruneCandidates(entries, { maxAgeDays = 180, importanceThreshold = 30 } = {}) {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    return entries.filter((e) => {
      const isOld = new Date(e.createdAt).getTime() < cutoff;
      if (!isOld) return false;
      const hasImportanceScore = typeof e.metadata?.importanceScore === 'number';
      // If we've actually scored this entry, that score is the real signal
      // — a high-importance entry is never a candidate just because it
      // hasn't been recalled yet. Only fall back to "never recalled" when
      // there's no importance signal to go on at all.
      if (hasImportanceScore) return e.metadata.importanceScore < importanceThreshold;
      return !e.metadata?.lastRecalledAt;
    });
  }
}
