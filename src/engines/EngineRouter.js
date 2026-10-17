import { Availability, EngineError, EngineEvent, ErrorCode } from './constants.js';
import { analyzeTask } from './TaskAnalyzer.js';

/**
 * EngineRouter — picks which engine runs a task (spec section 4) and produces an *explained* decision, including
 * the fallback chain. It never executes anything and never mutates engine state.
 *
 *   analysis → candidates (capability match + availability + engine fit) → ordered chain → decision
 *
 * Fallback rules: the chain is ordered best-first; the task manager walks it only BEFORE side effects have started.
 */
export class EngineRouter {
  constructor({ registry, eventBus = null, activityLog = null } = {}) {
    this.registry = registry;
    this.eventBus = eventBus;
    this.activityLog = activityLog;
  }

  analyze(input) { return analyzeTask(input); }

  /**
   * @param {object} analysis  output of analyzeTask()
   * @param {{preferredEngine?:string|null, allowFallback?:boolean, exclude?:string[], refresh?:boolean}} [opts]
   * @returns {Promise<{engineId:string, chain:string[], fallbackFrom:string|null, reason:string, candidates:object[], analysis:object}>}
   */
  async route(analysis, { preferredEngine = null, allowFallback = true, exclude = [], refresh = false } = {}) {
    if (refresh) await this.registry.refreshAll();
    const candidates = [];
    for (const engine of this.registry.engines()) {
      if (exclude.includes(engine.id)) continue;
      const health = this.registry.health(engine.id) ?? (await this.registry.refresh(engine.id));
      const capable = engine.supportsAll(analysis.requiredCapabilities);
      const serveable = capable && engine.canServe(analysis, health);
      const reasons = [];
      let score = this.registry.priority(engine.id) / 10;
      if (!capable) reasons.push(`lacks capability: ${analysis.requiredCapabilities.filter((c) => !engine.supports(c)).join(', ')}`);
      else if (!health?.available) reasons.push(`unavailable (${health?.level ?? 'unknown'}${health?.reason ? `: ${health.reason}` : ''})`);
      else if (!serveable) reasons.push('required dependency unavailable for this task');
      if (serveable) {
        score += health.level === Availability.READY ? 20 : 5;
        const weight = engine.routingWeight(analysis);
        score += weight;
        if (weight) reasons.push(`fit ${weight > 0 ? '+' : ''}${weight}`);
        reasons.push(health.level === Availability.READY ? 'ready' : `partially available (${health.level})`);
      }
      candidates.push({ engineId: engine.id, serveable, available: Boolean(health?.available), level: health?.level ?? 'unknown', score: serveable ? score : -1, reasons });
    }

    const serveable = candidates.filter((c) => c.serveable).sort((a, b) => b.score - a.score);
    let chain = serveable.map((c) => c.engineId);
    let fallbackFrom = null;
    let reason;

    if (preferredEngine) {
      if (!this.registry.has(preferredEngine)) throw new EngineError(ErrorCode.NOT_FOUND, `Requested engine '${preferredEngine}' is not registered`);
      const preferredOk = chain.includes(preferredEngine);
      if (preferredOk) {
        chain = [preferredEngine, ...chain.filter((id) => id !== preferredEngine)];
        reason = `requested engine '${preferredEngine}' is available`;
      } else {
        const why = candidates.find((c) => c.engineId === preferredEngine)?.reasons.join('; ') || 'not available';
        if (!allowFallback || !chain.length) {
          throw new EngineError(ErrorCode.UNAVAILABLE, `Engine '${preferredEngine}' cannot run this task (${why})${chain.length ? '' : ' and no other engine is compatible'}.`, { details: { candidates } });
        }
        fallbackFrom = preferredEngine;
        reason = `requested engine '${preferredEngine}' is unavailable (${why}); falling back to '${chain[0]}'`;
      }
    } else if (chain.length) {
      reason = `'${chain[0]}' is the best available fit (${serveable[0].reasons.join(', ')})`;
    }

    if (!chain.length) {
      throw new EngineError(ErrorCode.UNAVAILABLE, `No available engine can run this task (required: ${analysis.requiredCapabilities.join(', ') || 'none'}).`, { details: { candidates } });
    }
    if (!allowFallback) chain = chain.slice(0, 1);

    const decision = { engineId: chain[0], chain, fallbackFrom, reason, candidates, analysis };
    if (fallbackFrom) {
      this.activityLog?.log({ type: 'engine_fallback', detail: { from: fallbackFrom, to: chain[0], reason } });
      this.eventBus?.emitEvent(EngineEvent.ENGINE_FALLBACK, { from: fallbackFrom, to: chain[0], reason });
    }
    return decision;
  }

  /** Convenience: analyze + route in one call. */
  async select(input, opts) {
    return this.route(this.analyze(input), opts);
  }
}
