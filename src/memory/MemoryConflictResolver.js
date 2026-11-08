import { TaskType } from '../providers/ProviderRouter.js';

const CONFLICT_PROMPT = `Does the NEW fact contradict the EXISTING fact (not just add detail — genuinely
conflict, like opposite preferences or incompatible statements)? Respond with ONLY JSON:
{"conflicts": true|false, "explanation": "one short phrase"}`;

/**
 * MemoryConflictResolver — spec section 15. Detects when a new fact
 * genuinely contradicts an existing one (not just adds detail), so the
 * caller can prefer the newer explicit user statement instead of silently
 * accumulating contradictions in long-term memory.
 */
export class MemoryConflictResolver {
  constructor(router) {
    this.router = router;
  }

  /**
   * @param {string} newFact
   * @param {Array<{id:string, content:string}>} existingFacts candidates to check against (e.g. same category)
   * @returns {Promise<Array<{id:string, content:string, explanation:string}>>} the ones that genuinely conflict
   */
  async findConflicts(newFact, existingFacts) {
    const conflicts = [];
    for (const existing of existingFacts) {
      const result = await this.router.complete(TaskType.SIMPLE, {
        system: CONFLICT_PROMPT,
        messages: [{ role: 'user', content: `NEW: ${newFact}\nEXISTING: ${existing.content}` }],
        maxTokens: 80,
      });
      let parsed;
      try {
        parsed = JSON.parse(result.text.trim().replace(/^```json\s*|\s*```$/g, ''));
      } catch {
        parsed = { conflicts: false, explanation: '' };
      }
      if (parsed.conflicts) conflicts.push({ id: existing.id, content: existing.content, explanation: parsed.explanation });
    }
    return conflicts;
  }
}
