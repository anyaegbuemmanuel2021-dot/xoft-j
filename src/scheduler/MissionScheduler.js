/**
 * MissionScheduler — decides WHAT to work on next, and runs independent
 * missions concurrently. It ranks; it does not bypass anything: every run still
 * goes through MissionManager.run (budgets, stuck detection, emergency stop)
 * and TaskPlanner (approvals/permissions).
 *
 * Factors used (all real, from persisted mission data or live health):
 * priority, deadline urgency, prior failures, budget/stuck state, provider
 * availability. Not implemented (no data source exists): energy, per-mission
 * token cost, device availability.
 */
const RUNNABLE = new Set(['created', 'planned']);

export class MissionScheduler {
  constructor({ manager, isProviderAvailable = () => true, now = () => Date.now() } = {}) {
    this.manager = manager;
    this.isProviderAvailable = isProviderAvailable;
    this.now = now;
  }

  score(m) {
    const reasons = [];
    const priority = Math.min(5, Math.max(1, Number(m.priority ?? 3)));
    let s = priority * 20; reasons.push(`priority ${priority}`);
    if (m.deadline) {
      const hours = (Date.parse(m.deadline) - this.now()) / 3_600_000;
      if (!Number.isNaN(hours)) {
        const u = hours < 0 ? 50 : hours < 1 ? 40 : hours < 24 ? 25 : hours < 72 ? 10 : 0;
        if (u) { s += u; reasons.push(hours < 0 ? 'overdue' : `deadline in ${Math.round(hours)}h`); }
      }
    }
    if ((m.usage?.runs ?? 0) === 0) { s += 5; reasons.push('not started'); }
    const failures = m.usage?.failures ?? 0;
    if (failures) { s -= failures * 10; reasons.push(`${failures} prior failure(s)`); }
    return { score: s, reasons };
  }

  /** Ranked runnable missions + a reason for every mission that was skipped. */
  rank({ emergency = false } = {}) {
    const ranked = []; const skipped = [];
    const providersOk = this.isProviderAvailable();
    for (const m of this.manager.list()) {
      let why = null;
      if (emergency) why = 'emergency stop active';
      else if (!RUNNABLE.has(m.status)) why = `status is ${m.status}`;
      else if (this.manager.budgetState(m).exhausted) why = 'budget exhausted';
      else if (this.manager.isStuck(m)) why = 'stuck — needs review';
      else if (!providersOk) why = 'no healthy AI provider';
      if (why) { skipped.push({ id: m.id, goal: m.goal, reason: why }); continue; }
      const { score, reasons } = this.score(m);
      ranked.push({ id: m.id, goal: m.goal, score, reasons });
    }
    ranked.sort((a, b) => b.score - a.score);
    return { ranked, skipped };
  }

  next(opts) { return this.rank(opts).ranked[0] ?? null; }

  /** Bounded worker pool: independent missions run concurrently, results merged in input order. */
  async runBatch(ids, { concurrency = 3 } = {}) {
    const limit = Math.max(1, Math.min(Number(concurrency) || 1, 8));
    const results = new Array(ids.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const i = cursor; cursor += 1;
        try {
          const m = await this.manager.run(ids[i]);
          results[i] = { id: ids[i], ok: true, status: m.status };
        } catch (err) {
          results[i] = { id: ids[i], ok: false, error: err.message };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, worker));
    return results;
  }
}
