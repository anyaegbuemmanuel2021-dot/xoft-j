import { TaskType } from '../providers/ProviderRouter.js';

const CONSOLIDATE_PROMPT = `These stored facts are near-duplicates or repeated mentions of the same thing.
Merge them into ONE consolidated fact that preserves everything genuinely useful and drops redundancy.
Respond with ONLY JSON: {"consolidated": "the merged fact text"}`;

/**
 * MemoryConsolidator — spec section 15. Merges a set of near-duplicate
 * stored facts into one, so repeated mentions of the same preference don't
 * pile up as separate entries over time.
 */
export class MemoryConsolidator {
  constructor(router) {
    this.router = router;
  }

  /** @param {string[]} facts near-duplicate fact texts @returns {Promise<string>} the merged text */
  async consolidate(facts) {
    if (facts.length < 2) return facts[0] ?? '';
    const result = await this.router.complete(TaskType.SIMPLE, {
      system: CONSOLIDATE_PROMPT,
      messages: [{ role: 'user', content: facts.map((f, i) => `${i + 1}. ${f}`).join('\n') }],
      maxTokens: 200,
    });
    try {
      const parsed = JSON.parse(result.text.trim().replace(/^```json\s*|\s*```$/g, ''));
      return parsed?.consolidated ?? facts[facts.length - 1];
    } catch {
      return facts[facts.length - 1]; // fall back to the most recent rather than losing everything
    }
  }
}
