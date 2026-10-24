import { TaskType } from '../providers/ProviderRouter.js';

export const ExecutiveAction = {
  DELEGATE: 'delegate',
  WORLD_STATE: 'world_state',
  GOAL: 'goal',
  ADVISE: 'advise',
  CONFIRM: 'confirm',
  CANCEL: 'cancel',
};

const SYSTEM_PROMPT = [
  'Classify a message to a personal AI assistant into exactly one action:',
  '- "world_state": asking about current situation, status, pending work, or what needs attention.',
  '- "goal": wants something done that plausibly takes more than one step or tool call.',
  '- "advise": describes a problem or asks for ideas, opinions, recommendations, or options.',
  '- "confirm": approves a previously proposed action (do it, yes, go ahead).',
  '- "cancel": calls off a previously proposed action (never mind, cancel that).',
  '- "delegate": plain conversation, a simple question, or one memory operation. Default for ordinary chat.',
  'Respond with ONLY JSON: {"action": "<one of the above>"}',
].join('\\n');

const CANCEL_RE = /^(?:no[, ]+)?(?:never ?mind|cancel(?: that| it)?|forget it|scrap that|don'?t do (?:it|that)|abort)[.! ]*$/i;
const CONFIRM_RE = /^(?:yes|go ahead|do it|proceed|confirm(?:ed)?|go for it|approved?)(?:[ ,]+(?:please|do it|go ahead))?[.! ]*$|^please (?:do it|go ahead|proceed)[.! ]*$/i;
const AMBIGUOUS_ACK_RE = /^(?:ok(?:ay)?|sure|yeah|yep|yup|alright|all right|fine|sounds good|good|great|cool|k|do that|that works)(?:[ ,]+(?:thanks?|thank you|please|then))?[.! ]*$/i;
const WORLD_STATE_RE = /\b(?:what should i (?:be )?doing|what(?:'s| is) pending|what am i forgetting|what needs my attention|what(?:'s| is) on my plate)\b/i;
const ACTION_OR_ADVICE_RE = new RegExp('\\b(?:' + [
  'send', 'e-?mail', 'schedule', 'book', 'calendar', 'meeting', 'call', 'phone', 'text', 'whats ?app', 'message', 'find', 'search', 'look up', 'research',
  'create', 'make', 'build', 'clean', 'organi[sz]e', 'delete', 'remove', 'download', 'upload', 'open', 'launch', 'install', 'set ?up', 'post', 'publish',
  'tweet', 'buy', 'order', 'pay', 'transfer', 'remind', 'monitor', 'watch', 'automate', 'write', 'draft', 'generate', 'plan', 'fix', 'deploy', 'run', 'start', 'stop',
  'how (?:should|do|can|would)', 'ideas?', 'best way', 'should i', 'what do you think', 'advice', 'recommend', 'suggest', 'stuck', 'help me', 'problem',
  'struggling', 'brainstorm', 'opinion', 'pros and cons', 'compare', 'which (?:one|is better)',
].join('|') + ')\\b', 'i');
const FAST_PATH_MAX_CHARS = 240;

export function fastClassify(message) {
  const text = String(message ?? '').trim();
  if (!text) return null;
  if (text.length <= 60 && CANCEL_RE.test(text)) return { action: ExecutiveAction.CANCEL, fast: true };
  if (text.length <= 60 && CONFIRM_RE.test(text)) return { action: ExecutiveAction.CONFIRM, fast: true };
  if (WORLD_STATE_RE.test(text)) return { action: ExecutiveAction.WORLD_STATE, fast: true };
  if (AMBIGUOUS_ACK_RE.test(text)) return null;
  if (text.length <= FAST_PATH_MAX_CHARS && !ACTION_OR_ADVICE_RE.test(text)) return { action: ExecutiveAction.DELEGATE, fast: true };
  return null;
}

export class ExecutiveClassifier {
  constructor(router) {
    this.router = router;
  }

  async classify(message) {
    const fast = fastClassify(message);
    if (fast) return fast;
    const result = await this.router.complete(TaskType.SIMPLE, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
      maxTokens: 60,
    });
    try {
      const fence = new RegExp('^\\x60\\x60\\x60json\\s*|\\s*\\x60\\x60\\x60$', 'g');
      const parsed = JSON.parse(result.text.trim().replace(fence, ''));
      if (!Object.values(ExecutiveAction).includes(parsed.action)) return { action: ExecutiveAction.DELEGATE };
      return parsed;
    } catch {
      return { action: ExecutiveAction.DELEGATE };
    }
  }
}
