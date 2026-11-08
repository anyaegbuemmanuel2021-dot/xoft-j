import { TaskType } from '../../providers/ProviderRouter.js';
import { Specialist, SPECIALIST_DEFS } from './Specialist.js';

const ROUTE_PROMPT = (domains) => `Pick which specialist should handle this question.
Available domains: ${domains.join(', ')}.
Respond with ONLY JSON: {"domain":"one of the domains above","reason":"one short sentence"}`;

function parseJSON(text, fallback) {
  try { return JSON.parse(text.trim().replace(/^```json\s*|\s*```$/g, '')); }
  catch { return fallback; }
}

/**
 * SpecialistDirector — holds the registry of Specialist agents and routes a
 * question to one, either because the caller named a domain explicitly or
 * via a real (cheap) classification call. Falls back to the general
 * AdvisorAgent territory is NOT this director's job — callers who want
 * open-ended advice with no domain fit should use AdvisorAgent directly;
 * this director always returns a named specialist's answer.
 */
export class SpecialistDirector {
  constructor({ router, injectionGuard, activityLog } = {}) {
    this.router = router;
    this.activityLog = activityLog;
    this.specialists = new Map(SPECIALIST_DEFS.map((def) => [def.domain, new Specialist(def, router, injectionGuard)]));
  }

  list() {
    return [...this.specialists.values()].map((s) => ({ name: s.name, domain: s.domain }));
  }

  async _route(question) {
    const domains = [...this.specialists.keys()];
    const result = await this.router.complete(TaskType.SIMPLE, {
      system: ROUTE_PROMPT(domains),
      messages: [{ role: 'user', content: question }],
      maxTokens: 100,
    });
    const parsed = parseJSON(result.text, null);
    return domains.includes(parsed?.domain) ? parsed.domain : domains[0];
  }

  /**
   * @param {string} question
   * @param {object} [opts]
   * @param {string} [opts.domain] explicit domain — skips the routing call entirely
   * @param {string} [opts.context]
   * @param {boolean} [opts.isExternal]
   */
  async consult(question, { domain, context = '', isExternal = false } = {}) {
    let chosenDomain = domain;
    let routeReason = 'explicit domain';
    if (!chosenDomain || !this.specialists.has(chosenDomain)) {
      chosenDomain = await this._route(question);
      routeReason = 'auto-routed';
    }
    const specialist = this.specialists.get(chosenDomain);
    const result = await specialist.consult(question, context, { isExternal });
    this.activityLog?.log({ type: 'specialist_consulted', detail: { domain: chosenDomain, routeReason, question: question.slice(0, 200) } });
    return { ...result, routeReason };
  }
}
