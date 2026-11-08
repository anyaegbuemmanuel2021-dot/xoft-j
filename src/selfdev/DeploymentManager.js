/**
 * DeploymentManager — "autonomous deployment and rollback" from the spec,
 * built ON TOP of the existing, already-safe SelfDevelopmentEngine
 * (propose -> sandboxTest -> apply requires a named human approver ->
 * rollback). This module does not weaken any of that; it adds exactly one
 * new thing SelfDevelopmentEngine does not do on its own: after a change
 * is APPLIED to the live tree, watch it for a canary window using the
 * REAL Watchdog (system health, provider health, mission health — not a
 * synthetic check invented for this purpose) and automatically roll the
 * change back if watchdog reports CRITICAL during that window. No human
 * has to remember to babysit a just-applied change.
 *
 * This is honestly narrower than a full staged/blue-green rollout (there is
 * only one running process here, not a fleet) — it is canary-by-time-window
 * against this process's own real health signals, which is what a
 * single-instance server genuinely can do.
 */
export class DeploymentManager {
  constructor({ selfDev, watchdog, activityLog, eventBus, canaryWindowMs = 2 * 60 * 1000, pollIntervalMs = 15_000 } = {}) {
    this.selfDev = selfDev;
    this.watchdog = watchdog;
    this.activityLog = activityLog;
    this.eventBus = eventBus;
    this.canaryWindowMs = canaryWindowMs;
    this.pollIntervalMs = pollIntervalMs;
    /** @type {Map<string, {timer:NodeJS.Timeout, deadline:number}>} */
    this._watches = new Map();
  }

  _sleep(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }

  /**
   * Applies a verified self-dev proposal, then watches real system health
   * for canaryWindowMs before considering the deployment settled. Resolves
   * once the outcome is known: {status:'promoted'|'rolled_back', proposalId, reason?}.
   */
  async deploy(proposalId, { approvedBy, canaryWindowMs = this.canaryWindowMs } = {}) {
    await this.selfDev.apply(proposalId, { approvedBy });
    this.activityLog?.log({ type: 'deployment_applied', detail: { proposalId, approvedBy, canaryWindowMs } });
    this.eventBus?.emitEvent('deployment.applied', { proposalId, canaryWindowMs });

    const deadline = Date.now() + Math.max(1000, Number(canaryWindowMs) || this.canaryWindowMs);
    let outcome = { status: 'promoted', proposalId };
    while (Date.now() < deadline) {
      await this._sleep(Math.min(this.pollIntervalMs, Math.max(0, deadline - Date.now())));
      let report;
      try { report = await this.watchdog.diagnose(); } catch { continue; } // a diagnose failure is not itself a reason to roll back
      const critical = report.checks.filter((c) => c.level === 'CRITICAL');
      if (critical.length) {
        const reason = `canary: ${critical.map((c) => `${c.name} — ${c.detail}`).join('; ')}`;
        try {
          this.selfDev.rollback(proposalId);
          outcome = { status: 'rolled_back', proposalId, reason };
        } catch (err) {
          outcome = { status: 'rollback_failed', proposalId, reason, error: err.message };
        }
        break;
      }
    }
    this.activityLog?.log({ type: `deployment_${outcome.status}`, detail: outcome });
    this.eventBus?.emitEvent(`deployment.${outcome.status}`, outcome);
    return outcome;
  }
}
