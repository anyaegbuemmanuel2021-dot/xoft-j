import { TaskType } from '../providers/ProviderRouter.js';
import { IntentDetector, Intent } from './IntentDetector.js';

const ASSISTANT_SYSTEM_PROMPT = `You are XOFT, a personal AI assistant. Be direct and useful.
Use the MEMORY CONTEXT below if it's relevant to the user's message; ignore it if it isn't.
Never claim to have taken a real-world action (sent an email, made a call, etc.) — this build only
has conversation and memory. If asked to do something requiring a tool that doesn't exist yet, say so.`;

/**
 * Orchestrator — implements: understand -> plan -> memory/tools -> respond.
 *
 * This phase wires up intent detection, provider routing, and the full
 * memory system. Tool execution, task planning for multi-step goals, and the
 * approval system are separate later phases (12-14) that plug into the same
 * `handle()` entry point without changing this class's public shape.
 */
export class Orchestrator {
  /**
   * @param {object} deps
   * @param {import('../providers/ProviderRouter.js').ProviderRouter} deps.router
   * @param {import('../memory/MemoryManager.js').MemoryManager} deps.memory
   * @param {import('../personality/PersonalityEngine.js').PersonalityEngine} [deps.personality]
   * @param {import('../personality/UserStyleModel.js').UserStyleModel} [deps.userStyle]
   */
  constructor({ router, memory, personality, userStyle, address }) {
    this.address = address ?? null;
    this.router = router;
    this.memory = memory;
    this.personality = personality ?? null;
    this.userStyle = userStyle ?? null;
    this.intentDetector = new IntentDetector(router);
  }

  /**
   * @param {string} sessionId
   * @param {string} message
   * @returns {Promise<{intent:string, reply:string, meta?:object}>}
   */
  async handle(sessionId, message) {
    this.userStyle?.recordSample(message);
    this.memory.addTurn(sessionId, 'user', message);

    const classification = await this.intentDetector.detect(message);
    let result;

    switch (classification.intent) {
      case Intent.REMEMBER:
        result = await this._handleRemember(message, classification);
        break;
      case Intent.FORGET:
        result = await this._handleForget(classification);
        break;
      case Intent.RECALL:
        result = await this._handleRecall(message, classification);
        break;
      default:
        result = await this._handleConversation(sessionId, message);
    }

    this.memory.addTurn(sessionId, 'assistant', result.reply);
    return { intent: classification.intent, ...result };
  }

  async _handleRemember(message, classification) {
    const category = classification.category || 'fact';
    // The user directly asked XOFT to remember this — the strongest
    // provenance a memory entry can have (spec: memory provenance).
    const { longTermId, vectorId } = await this.memory.remember(category, message, {
      subject: classification.subject,
    }, { source: 'USER_STATED', confidence: 1 });
    return {
      reply: `Noted — stored under "${category}"${classification.subject ? ` (${classification.subject})` : ''}.`,
      meta: { longTermId, vectorId },
    };
  }

  async _handleForget(classification) {
    const filter = {};
    if (classification.category) filter.category = classification.category;
    if (classification.subject) filter.textIncludes = classification.subject;

    if (!filter.category && !filter.textIncludes) {
      return {
        reply: "I need to know what to forget — a name, project, or topic to search for.",
      };
    }

    const removed = await this.memory.forgetWhere(filter);
    return {
      reply:
        removed > 0
          ? `Removed ${removed} ${removed === 1 ? 'entry' : 'entries'} from memory.`
          : "I didn't find anything matching that to forget.",
      meta: { removed },
    };
  }

  async _handleRecall(message, classification) {
    const structured = this.memory.recallStructured({
      category: classification.category ?? undefined,
      textIncludes: classification.subject ?? undefined,
    });

    let semantic = [];
    if (this.memory.vectorEnabled) {
      semantic = await this.memory.recallSemantic(message, 5);
    }

    const merged = new Map();
    for (const s of structured) merged.set(s.id, s.content);
    for (const s of semantic) if (s.score > 0.75) merged.set(s.id, s.content);

    if (merged.size === 0) {
      return { reply: "I don't have anything stored on that." };
    }

    const bulletList = [...merged.values()].map((c) => `- ${c}`).join('\n');
    return { reply: `Here's what I have:\n${bulletList}` };
  }

  async _handleConversation(sessionId, message) {
    const conversation = this.memory.getConversation(sessionId);

    let memoryContext = '';
    if (this.memory.vectorEnabled) {
      try {
        const relevant = await this.memory.recallSemantic(message, 3);
        const useful = relevant.filter((r) => r.score > 0.75);
        if (useful.length) {
          memoryContext = `\n\nMEMORY CONTEXT:\n${useful.map((r) => `- ${r.content}`).join('\n')}`;
        }
      } catch {
        // Semantic recall unavailable — proceed without it, don't block the reply.
      }
    }

    const personalityFragment = this.personality ? `\n\n${this.personality.describeForPrompt()}` : '';
    const addressFragment = this.address ? `\n\n${this.address.describeForPrompt(sessionId)}` : '';
    const styleFragment = this.userStyle ? (() => { const d = this.userStyle.describeForPrompt(); return d ? `\n\n${d}` : ''; })() : '';

    const result = await this.router.complete(TaskType.REASONING, {
      system: ASSISTANT_SYSTEM_PROMPT + memoryContext + personalityFragment + addressFragment + styleFragment,
      messages: conversation,
      maxTokens: 1024,
    });

    return { reply: result.text, meta: { usage: result.usage, provider: result.raw } };
  }
}
