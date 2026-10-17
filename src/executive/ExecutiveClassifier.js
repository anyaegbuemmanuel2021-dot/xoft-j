import { TaskType } from '../providers/ProviderRouter.js';

export const ExecutiveAction = {
  DELEGATE: 'delegate', // plain conversation or a remember/forget/recall — existing Orchestrator handles it as-is
  WORLD_STATE: 'world_state', // "what should I be doing right now", "what am I forgetting"
  GOAL: 'goal', // a multi-step actionable request that needs planning
  ADVISE: 'advise', // the user is describing a problem or asking for ideas, not asking XOFT to act
  CONFIRM: 'confirm', // "do it", "yes", "go ahead" — proceed with the last proposed plan
  CANCEL: 'cancel', // "never mind", "cancel that"
};

const SYSTEM_PROMPT = `You classify a message to a personal AI assistant into exactly one action:

- "world_state": the user is asking about their current situation/status — "what should I be doing", "what's pending", "what am I forgetting", "what needs my attention"
- "goal": the user wants something DONE that plausibly takes more than one step or tool call (e.g. "find a slot with John and schedule it", "clean up my inbox", "research X and remember the answer")
- "advise": the user is describing a problem or asking for ideas/opinions/recommendations — they want reasoning and options, not an action performed (e.g. "how should I structure this", "any ideas for X", "what's the best way to Y", "I'm stuck on Z")
- "confirm": the user is approving/proceeding with something already proposed ("do it", "yes", "go ahead", "sounds good")
- "cancel": the user is calling off something already proposed ("never mind", "cancel that", "don't")
- "delegate": anything else — plain conversation, a simple question, or a single memory operation (remember/forget/recall a fact). This is the default for ordinary chat.

Respond with ONLY JSON: {"action": "<one of the above>"}`;

export class ExecutiveClassifier {
  constructor(router) {
    this.router = router;
  }

  /** @returns {Promise<{action:string}>} */
  async classify(message) {
    const result = await this.router.complete(TaskType.SIMPLE, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
      maxTokens: 60,
    });

    try {
      const parsed = JSON.parse(result.text.trim().replace(/^```json\s*|\s*```$/g, ''));
      if (!Object.values(ExecutiveAction).includes(parsed.action)) {
        return { action: ExecutiveAction.DELEGATE };
      }
      return parsed;
    } catch {
      return { action: ExecutiveAction.DELEGATE };
    }
  }
}
