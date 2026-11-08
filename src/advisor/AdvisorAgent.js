import { TaskType } from '../providers/ProviderRouter.js';

const ADVISOR_SYSTEM_PROMPT = `You are XOFT acting as a technical advisor, not a task executor. The user is
describing a problem or asking for ideas — they don't want you to immediately plan and run actions.

Structure your answer:
1. Restate the core problem in one line, so they know you understood it.
2. Give 2-4 concrete options or ideas, each with a one-line tradeoff — specific to the context given, not
   generic platitudes.
3. Recommend the one you'd pick and say why, given the actual context.
4. Name any real risk or unknown honestly, including if the context given isn't enough to recommend
   something specific — in that case say what's missing instead of guessing broadly.

Don't propose executing anything — this is advice, not a plan. If they want you to act on it after, they'll
say so.`;

/**
 * AdvisorAgent — the "problem-solving system" half of this request. Used
 * when ExecutiveClassifier detects the user wants ideas/reasoning about a
 * problem rather than an action performed. Real reasoning call grounded in
 * whatever project context is passed in (world state, goals) — not fixed
 * canned advice.
 */
export class AdvisorAgent {
  /**
   * @param {import('../providers/ProviderRouter.js').ProviderRouter} router
   * @param {import('../security/PromptInjectionGuard.js').PromptInjectionGuard} [injectionGuard]
   */
  constructor(router, injectionGuard) {
    this.router = router;
    this.injectionGuard = injectionGuard ?? null;
  }

  /**
   * @param {string} problem
   * @param {string} [context] plain-text project context (world state, goals, recent activity)
   * @param {{isExternal?: boolean}} [options] set isExternal when context wasn't generated internally
   *   (e.g. pasted in via the API) — it then gets wrapped as untrusted data instead of trusted as-is.
   */
  async advise(problem, context = '', { isExternal = false } = {}) {
    const contextBlock = !context
      ? ''
      : isExternal && this.injectionGuard
        ? this.injectionGuard.process(context, 'externally supplied context').wrapped
        : context;

    const result = await this.router.complete(TaskType.REASONING, {
      system: ADVISOR_SYSTEM_PROMPT + (contextBlock ? `\n\nPROJECT CONTEXT:\n${contextBlock}` : ''),
      messages: [{ role: 'user', content: problem }],
      maxTokens: 900,
    });
    return result.text;
  }
}
