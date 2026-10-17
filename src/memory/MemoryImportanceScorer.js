import { TaskType } from '../providers/ProviderRouter.js';

const IMPORTANCE_PROMPT = `Score how important this fact is to remember long-term, on a 0-100 scale, for a
personal AI assistant. High: identity, ongoing preferences, active projects/goals, explicit instructions.
Low: one-off trivia, transient state, something already superseded. Respond with ONLY JSON:
{"score": 0-100, "reasoning": "one short phrase"}`;

/**
 * MemoryImportanceScorer — spec section 15. Real AI-scored importance,
 * stored as metadata on the entry (by the caller — this class just scores).
 * Used by MemoryRetentionManager to decide what's safe to consider pruning.
 */
export class MemoryImportanceScorer {
  constructor(router) {
    this.router = router;
  }

  /** @param {string} factText @returns {Promise<{score:number, reasoning:string}>} */
  async score(factText) {
    const result = await this.router.complete(TaskType.SIMPLE, {
      system: IMPORTANCE_PROMPT,
      messages: [{ role: 'user', content: factText }],
      maxTokens: 100,
    });
    try {
      const parsed = JSON.parse(result.text.trim().replace(/^```json\s*|\s*```$/g, ''));
      return { score: Math.max(0, Math.min(100, Number(parsed.score) || 50)), reasoning: parsed.reasoning ?? '' };
    } catch {
      return { score: 50, reasoning: 'Could not score — defaulted to neutral.' };
    }
  }
}
