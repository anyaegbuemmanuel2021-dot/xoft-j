import { TaskType } from '../providers/ProviderRouter.js';

const DECOMPOSE_PROMPT = `Break a goal or problem into its real constituent sub-problems — only as many as
genuinely exist, don't pad. For each, note what's needed to resolve it and whether it depends on another
sub-problem. Respond with ONLY JSON:
{"subproblems": [{"id": "sp1", "description": "...", "dependsOn": [], "whatIsNeeded": "..."}]}`;

const COMPARE_PROMPT = `Compare the given options against the given criteria honestly. Don't force a winner if
the options are genuinely close or the criteria conflict — say so. Respond with ONLY JSON:
{"comparison": [{"option": "...", "scoresByCriterion": {"criterion": "how it does, one phrase"}, "notes": "..."}],
"recommendation": "option name or null if genuinely too close to call", "reasoning": "one or two sentences"}`;

const CONTRADICTION_PROMPT = `Given a list of statements (e.g. stored facts, user preferences, plan steps), identify
any that genuinely contradict each other. Don't flag things that are merely different, only things that can't
both be true/intended at once. Respond with ONLY JSON:
{"contradictions": [{"statementA": "...", "statementB": "...", "explanation": "..."}]}`;

const UNCERTAINTY_PROMPT = `Identify what's genuinely uncertain or ambiguous in the given request/context that
would materially change the right course of action if resolved differently. Don't invent uncertainty that
doesn't affect the outcome. Respond with ONLY JSON:
{"uncertainties": [{"question": "...", "whyItMatters": "..."}]}`;

function parseJSON(text, fallback) {
  try {
    return JSON.parse(text.trim().replace(/^```json\s*|\s*```$/g, ''));
  } catch {
    return fallback;
  }
}

/**
 * ReasoningEngine — spec section 8. Structured reasoning primitives used by
 * ExecutiveBrain, TaskPlanner, and AdvisorAgent instead of each rolling
 * their own ad-hoc prompt for "break this down" / "compare these options".
 * Every method is a real AI call with a constrained JSON output — chain-of-
 * thought stays internal to the call, callers get the concise structured
 * result, matching spec section 8's "expose concise reasoning summaries."
 */
export class ReasoningEngine {
  constructor(router) {
    this.router = router;
  }

  /** @param {string} goal @returns {Promise<{subproblems: Array}>} */
  async decompose(goal) {
    const result = await this.router.complete(TaskType.REASONING, {
      system: DECOMPOSE_PROMPT,
      messages: [{ role: 'user', content: goal }],
      maxTokens: 600,
    });
    return parseJSON(result.text, { subproblems: [] });
  }

  /**
   * @param {string[]} options
   * @param {string[]} criteria
   * @returns {Promise<{comparison: Array, recommendation: string|null, reasoning: string}>}
   */
  async compareOptions(options, criteria) {
    const result = await this.router.complete(TaskType.REASONING, {
      system: COMPARE_PROMPT,
      messages: [{ role: 'user', content: `Options: ${options.join(', ')}\nCriteria: ${criteria.join(', ')}` }],
      maxTokens: 700,
    });
    return parseJSON(result.text, { comparison: [], recommendation: null, reasoning: 'Could not evaluate.' });
  }

  /** @param {string[]} statements @returns {Promise<{contradictions: Array}>} */
  async detectContradictions(statements) {
    if (statements.length < 2) return { contradictions: [] };
    const result = await this.router.complete(TaskType.SIMPLE, {
      system: CONTRADICTION_PROMPT,
      messages: [{ role: 'user', content: statements.map((s, i) => `${i + 1}. ${s}`).join('\n') }],
      maxTokens: 400,
    });
    return parseJSON(result.text, { contradictions: [] });
  }

  /** @param {string} requestOrContext @returns {Promise<{uncertainties: Array}>} */
  async detectUncertainty(requestOrContext) {
    const result = await this.router.complete(TaskType.SIMPLE, {
      system: UNCERTAINTY_PROMPT,
      messages: [{ role: 'user', content: requestOrContext }],
      maxTokens: 400,
    });
    return parseJSON(result.text, { uncertainties: [] });
  }
}
