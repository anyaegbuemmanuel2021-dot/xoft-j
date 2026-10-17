import { TaskType } from '../providers/ProviderRouter.js';

/**
 * Intents the system currently recognizes. This list grows as agents are
 * added (email, calendar, phone, etc. in later phases) — for now it covers
 * what Phase 1-3 (core + memory) can actually act on.
 */
export const Intent = {
  REMEMBER: 'remember', // "remember this", "note that..."
  FORGET: 'forget', // "forget that", "delete everything about X"
  RECALL: 'recall', // "what do you remember about..."
  CONVERSATION: 'conversation', // general chat / question answering
};

const SYSTEM_PROMPT = `You are an intent classifier for a personal AI assistant.
Classify the user's message into exactly one of: remember, forget, recall, conversation.

- "remember" = user is telling you a fact to store for later (e.g. "remember my flight is Friday", "John's birthday is March 3rd")
- "forget" = user wants something deleted from memory (e.g. "forget that", "delete everything about John")
- "recall" = user is asking what you remember (e.g. "what do you know about my project?")
- "conversation" = anything else — questions, requests, general chat

Respond with ONLY a JSON object, no markdown fences, no explanation:
{"intent": "<one of the four above>", "category": "<person|project|preference|rule|decision|task|fact|null>", "subject": "<short string the intent is about, or null>"}`;

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
    const result = await this.router.complete(TaskType.SIMPLE, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
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
      // If classification output isn't valid JSON, fail safe to plain
      // conversation rather than guessing at a destructive intent like forget.
      return { intent: Intent.CONVERSATION, category: null, subject: null };
    }
  }
}
