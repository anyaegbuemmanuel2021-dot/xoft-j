/**
 * Deterministic executive intent classification.
 *
 * This layer deliberately uses explicit phrase/verb rules rather than an AI
 * model. Unknown or ambiguous messages are delegated safely; they are never
 * interpreted as approval for a risky action.
 */
export const ExecutiveAction = {
  DELEGATE: 'delegate',
  WORLD_STATE: 'world_state',
  GOAL: 'goal',
  ADVISE: 'advise',
  CONFIRM: 'confirm',
  CANCEL: 'cancel',
};

const CANCEL_RE = /^(?:no[, ]+)?(?:never ?mind|cancel(?: that| it)?|forget it|scrap that|don't do (?:it|that)|abort)[.! ]*$/i;
const CONFIRM_RE = /^(?:yes|go ahead|do it|proceed|confirm(?:ed)?|go for it|approved?)(?:[ ,]+(?:please|do it|go ahead))?[.! ]*$|^please (?:do it|go ahead|proceed)[.! ]*$/i;
const WORLD_STATE_RE = /\b(?:what should i (?:be )?doing|what(?:'s| is) pending|what am i forgetting|what needs my attention|what(?:'s| is) on my plate|show (?:my )?(?:status|pending tasks|tasks))\b/i;
const ADVICE_RE = /\b(?:how should i|what do you think|any ideas|give me ideas|recommend(?:ation)?s?|suggest(?:ion)?s?|advice|what would you do|i(?:'m| am) (?:stuck|struggling)|i have a problem|help me understand|pros and cons|which (?:one|option) is better|should i)\b/i;
const ACTION_RE = /\b(?:send|email|schedule|book|create|make|build|clean|organize|organise|delete|remove|download|upload|open|launch|install|set up|post|publish|buy|order|pay|transfer|remind|monitor|watch|automate|write|draft|generate|plan|fix|deploy|run|start|stop|calculate|search|find|look up|research|call|message|text|whatsapp)\b/i;

export function fastClassify(message) {
  const text = String(message ?? '').trim();
  if (!text) return { action: ExecutiveAction.DELEGATE, fast: true };
  if (text.length <= 80 && CANCEL_RE.test(text)) return { action: ExecutiveAction.CANCEL, fast: true };
  if (text.length <= 80 && CONFIRM_RE.test(text)) return { action: ExecutiveAction.CONFIRM, fast: true };
  if (WORLD_STATE_RE.test(text)) return { action: ExecutiveAction.WORLD_STATE, fast: true };
  if (ADVICE_RE.test(text)) return { action: ExecutiveAction.ADVISE, fast: true };
  if (ACTION_RE.test(text)) return { action: ExecutiveAction.GOAL, fast: true };
  return { action: ExecutiveAction.DELEGATE, fast: true };
}

export class ExecutiveClassifier {
  constructor() {}

  async classify(message) {
    return fastClassify(message);
  }
}
