import { TaskType } from '../providers/ProviderRouter.js';

/**
 * Intents the system currently recognizes. Deterministic patterns handle
 * explicit memory commands; the model is reserved for genuinely ambiguous
 * memory language.
 */
export const Intent = {
  REMEMBER: 'remember',
  FORGET: 'forget',
  RECALL: 'recall',
  CONVERSATION: 'conversation',
};

const SYSTEM_PROMPT = `You are an intent classifier for a personal AI assistant.
Classify the user's message into exactly one of: remember, forget, recall, conversation.

- "remember" = user is telling you a fact to store for later
- "forget" = user wants something deleted from memory
- "recall" = user is asking what you remember
- "conversation" = anything else — questions, requests, general chat

Respond with ONLY a JSON object, no markdown fences, no explanation:
{"intent": "<one of the four above>", "category": "<person|project|preference|rule|decision|task|fact|null>", "subject": "<short string the intent is about, or null>" }`;

const cleanSubject = (value) => {
  const subject = String(value ?? '').trim()
    .replace(/^[\s:,-]+|[\s?.!,;:]+$/g, '')
    .replace(/^(?:that|this)\s+/i, '')
    .trim();
  return subject || null;
};

/**
 * Fast path for explicit, unambiguous commands. These operations do not need
 * a language model and therefore remain available when every AI provider is
 * offline or rate-limited.
 */
function detectExplicitMemoryCommand(text) {
  let match = text.match(/^(?:(?:hey\s+)?xoft[,!]?\s*)?(?:please\s+|kindly\s+)?(?:remember|save|note)\s+(?:that\s+)?(.+)$/i);
  if (match) {
    return { intent: Intent.REMEMBER, category: 'fact', subject: cleanSubject(match[1]) };
  }

  match = text.match(/^(?:(?:hey\s+)?xoft[,!]?\s*)?(?:please\s+|kindly\s+)?(?:forget|delete from memory|remove from memory)\s+(.+)$/i);
  if (match) {
    let subject = cleanSubject(match[1]);
    subject = subject?.replace(/^(?:everything|all (?:the )?memories|all entries)\s+(?:about|for|related to)\s+/i, '') ?? null;
    return { intent: Intent.FORGET, category: null, subject };
  }

  match = text.match(/^(?:(?:hey\s+)?xoft[,!]?\s*)?(?:what do you remember about|what have i told you about|recall)\s+(.+)$/i);
  if (match) {
    return { intent: Intent.RECALL, category: null, subject: cleanSubject(match[1]) };
  }

  return null;
}

export class IntentDetector {
  /** @param {import('../providers/ProviderRouter.js').ProviderRouter} router */
  constructor(router) {
    this.router = router;
  }

  /**
   * @param {string} message
   * @returns {Promise<{intent:string, category:string|null, subject:string|null}>}
   */
  async detect(message) {
    const text = String(message ?? '').trim();
    const deterministic = detectExplicitMemoryCommand(text);
    if (deterministic) return deterministic;

    // Most messages are ordinary conversation. Only ambiguous messages that
    // plausibly concern memory reach the model-based classifier.
    const memoryRelated = /\b(remember|remind me|memor(?:y|ies)|forget|recall|save (?:this|that|it)|note that|what have i told you|what do you know about me)\b/i.test(text);
    if (!memoryRelated) {
      return { intent: Intent.CONVERSATION, category: null, subject: null };
    }

    const result = await this.router.complete(TaskType.SIMPLE, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
      maxTokens: 150,
    });

    try {
      const cleaned = result.text.trim().replace(/^```json\s*|\s*```$/g, '');
      const parsed = JSON.parse(cleaned);
      if (!Object.values(Intent).includes(parsed.intent)) {
        return { intent: Intent.CONVERSATION, category: null, subject: null };
      }
      return parsed;
    } catch {
      // Fail safe: malformed model output must never trigger a memory mutation.
      return { intent: Intent.CONVERSATION, category: null, subject: null };
    }
  }
}
