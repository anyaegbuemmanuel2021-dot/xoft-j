import fs from 'node:fs';
import { JsonStore } from '../persistence/JsonStore.js';
import path from 'node:path';
import { TaskType } from '../providers/ProviderRouter.js';

const DEFAULT_TRAITS = {
  casualness: 55,
  professionalism: 65,
  humor: 30,
  directness: 75,
  technicalDepth: 60,
  verbosity: 45,
  proactivity: 65,
  formality: 45,
};

const ADJUST_PROMPT = `You adjust a personal assistant's communication trait sliders (0-100 each) based on a
plain-language instruction. Current traits are given as JSON. Apply a modest, sensible change (typically
10-25 points) to only the trait(s) the instruction actually refers to — leave everything else unchanged.

Respond with ONLY the complete updated JSON object, same keys as given, all values 0-100 integers.`;

const MODE_GUIDANCE = {
  casual: 'Casual mode: talk like a sharp, relaxed person, not a customer service bot. Short sentences. No "Certainly, I can assist you with that" style filler.',
  professional: 'Professional mode: this is going to an email, client, or official context. Formal but not stiff.',
  technical: 'Technical mode: this is coding/architecture/engineering. Be precise and technical, skip the small talk.',
  emergency: 'Emergency mode: this is urgent. Be extremely concise, direct, action-oriented. No hedging.',
};

/**
 * PersonalityEngine — spec sections 3, 4, 6. Traits are explicit, stored,
 * user-adjustable numbers — not a hidden vibe baked into a prompt string
 * that only the model author can see. `describeForPrompt()` turns the
 * current traits + detected mode into a system-prompt fragment; callers
 * (Orchestrator, ExecutiveBrain) append it to their own prompts.
 */
export class PersonalityEngine {
  constructor({ router, dataDir = './data', sqliteStore = null }) {
    this.router = router;
    this._store = new JsonStore({ dataDir, fileName: 'personality.json', kvKey: 'personality', defaultValue: { traits: DEFAULT_TRAITS }, sqliteStore });
  }

  _load() {
    return this._store.load();
  }

  _save(data) {
    this._store.save(data);
  }

  getTraits() {
    return this._load().traits;
  }

  /** Direct slider set — clamps to 0-100, merges with existing traits. */
  setTraits(partial) {
    const data = this._load();
    for (const [key, value] of Object.entries(partial)) {
      if (key in DEFAULT_TRAITS) {
        data.traits[key] = Math.max(0, Math.min(100, Number(value)));
      }
    }
    this._save(data);
    return data.traits;
  }

  /** Natural-language adjustment, e.g. "talk more casually", "stop giving long answers". */
  async adjustFromInstruction(instruction) {
    const current = this.getTraits();
    const result = await this.router.complete(TaskType.SIMPLE, {
      system: ADJUST_PROMPT,
      messages: [{ role: 'user', content: `Current traits: ${JSON.stringify(current)}\nInstruction: ${instruction}` }],
      maxTokens: 200,
    });
    try {
      const parsed = JSON.parse(result.text.trim().replace(/^```json\s*|\s*```$/g, ''));
      return this.setTraits(parsed);
    } catch {
      throw new Error(`PersonalityEngine: could not parse trait adjustment from: ${result.text.slice(0, 200)}`);
    }
  }

  /**
   * Simple heuristic mode detection — spec section 9. Real signal-based
   * detection (channel/tool involved), not an extra AI call for every
   * message; callers can override by passing an explicit mode.
   * @param {{toolName?:string, urgent?:boolean}} [context]
   */
  detectMode(context = {}) {
    if (context.urgent) return 'emergency';
    if (context.toolName && /email|calendar/.test(context.toolName)) return 'professional';
    if (context.toolName && /code|coding/.test(context.toolName)) return 'technical';
    return 'casual';
  }

  /** @param {string} [mode] explicit mode, or auto-detected from context if omitted */
  describeForPrompt(context = {}) {
    const traits = this.getTraits();
    const mode = context.mode ?? this.detectMode(context);
    const traitLine = Object.entries(traits).map(([k, v]) => `${k}: ${v}%`).join(', ');
    return `PERSONALITY (adapt tone to these, don't announce them): ${traitLine}\n${MODE_GUIDANCE[mode] ?? MODE_GUIDANCE.casual}\nStay direct and honest regardless of tone — personality never overrides accuracy, safety, or "I don't know."`;
  }
}
