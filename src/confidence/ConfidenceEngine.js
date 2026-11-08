import { TaskType } from '../providers/ProviderRouter.js';

const SYSTEM_PROMPT = `Rate confidence (0-100) that a proposed interpretation/plan correctly matches what the user
actually wants, given the context provided. Be honest — low confidence is fine and expected when the request is
genuinely ambiguous (e.g. multiple people with the same name, an unclear reference, missing details for a
risky action). Respond with ONLY JSON: {"score": 0-100, "reasoning": "one short sentence"}`;

/**
 * ConfidenceEngine — spec section 30/14. Used before risky/irreversible
 * steps to decide "ask" vs "proceed" based on an honest score rather than
 * silently guessing. This is a real AI call, not a fixed heuristic — the
 * whole point is catching genuine ambiguity a keyword rule would miss.
 */
export class ConfidenceEngine {
  constructor(router) {
    this.router = router;
  }

  /**
   * @param {string} question e.g. "this plan correctly accomplishes the user's goal"
   * @param {string} context supporting detail (the goal text, the plan steps, candidate matches, etc.)
   * @returns {Promise<{score:number, reasoning:string}>}
   */
  async assess(question, context) {
    const result = await this.router.complete(TaskType.SIMPLE, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Question: ${question}\nContext: ${context}` }],
      maxTokens: 120,
    });
    try {
      const parsed = JSON.parse(result.text.trim().replace(/^```json\s*|\s*```$/g, ''));
      return { score: Math.max(0, Math.min(100, Number(parsed.score) || 0)), reasoning: parsed.reasoning ?? '' };
    } catch {
      // Fail closed: if we can't even parse a confidence score, treat that as low confidence.
      return { score: 0, reasoning: 'Could not evaluate confidence — treating as uncertain.' };
    }
  }
}
