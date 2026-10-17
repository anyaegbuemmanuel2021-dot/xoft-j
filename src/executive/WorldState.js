/**
 * WorldState — spec section 12. A live, queryable snapshot of what's
 * actually going on, assembled from the real stores that already exist
 * (TaskPlanner, ApprovalSystem, RulesEngine, ActivityLog, MemoryManager) —
 * nothing here is synthesized or cached-and-stale. Every call reads current
 * state at call time.
 *
 * This deliberately does NOT reach into Gmail/Calendar on every snapshot —
 * that would mean a live API call (and API costs) on every single chat
 * turn. Email/calendar facts enter the world state the same way everything
 * else does: via a task/tool run (e.g. a rule that polls email) whose
 * result gets logged, so "important emails" shows up through activity/task
 * history rather than a hidden background poll nobody asked for.
 */
export class WorldState {
  /**
   * @param {object} deps
   * @param {import('../planner/TaskPlanner.js').TaskPlanner} deps.taskPlanner
   * @param {import('../approval/ApprovalSystem.js').ApprovalSystem} deps.approvalSystem
   * @param {import('../automation/RulesEngine.js').RulesEngine} deps.rulesEngine
   * @param {import('../activity/ActivityLog.js').ActivityLog} deps.activityLog
   * @param {import('../memory/MemoryManager.js').MemoryManager} deps.memory
   * @param {import('../devices/DeviceManager.js').DeviceManager} [deps.deviceManager]
   */
  constructor({ taskPlanner, approvalSystem, rulesEngine, activityLog, memory, deviceManager }) {
    this.taskPlanner = taskPlanner;
    this.approvalSystem = approvalSystem;
    this.rulesEngine = rulesEngine;
    this.activityLog = activityLog;
    this.memory = memory;
    this.deviceManager = deviceManager ?? null;
  }

  /** @returns {object} a structured snapshot — cheap, no external API calls */
  snapshot() {
    const tasks = this.taskPlanner.list();
    const activeTasks = tasks.filter((t) => ['planned', 'running', 'waiting_approval'].includes(t.status));
    const failedTasks = tasks.filter((t) => t.status === 'failed');
    const completedTasks = tasks.filter((t) => t.status === 'completed');

    const pendingApprovals = this.approvalSystem.listPending();
    const activeRules = this.rulesEngine.list().filter((r) => r.enabled);
    const recentActivity = this.activityLog.all().slice(-10).reverse();

    // Deadlines: goals mentioning a task planner status of waiting_approval or
    // running for more than a while are surfaced as "needs attention" — real
    // derivation from real task ages, not invented urgency.
    const now = Date.now();
    const stale = activeTasks.filter((t) => now - new Date(t.createdAt).getTime() > 24 * 60 * 60 * 1000);

    // Device Operating Layer — real connected-device facts only (spec
    // section 12): no synthesized "everything is fine" defaults.
    const devices = this.deviceManager ? this.deviceManager.listDevices() : [];
    const nonServerDevices = devices.filter((d) => d.platform !== 'server');

    return {
      now: new Date().toISOString(),
      tasks: {
        active: activeTasks.map((t) => ({ id: t.id, goal: t.goal, status: t.status })),
        failed: failedTasks.map((t) => ({ id: t.id, goal: t.goal })),
        completedCount: completedTasks.length,
        staleCount: stale.length,
      },
      pendingApprovals: pendingApprovals.map((a) => ({ id: a.id, toolName: a.toolName, riskLevel: a.riskLevel, createdAt: a.createdAt })),
      activeAutomations: activeRules.map((r) => ({ id: r.id, description: r.actionDescription, trigger: r.trigger })),
      recentActivity: recentActivity.map((a) => ({ ts: a.ts, type: a.type, toolName: a.toolName })),
      devices: nonServerDevices.map((d) => ({
        id: d.id, name: d.name, platform: d.platform, trust: d.trust, online: d.online, capabilities: d.capabilities, state: d.state,
      })),
    };
  }

  /** Plain-text rendering of snapshot() for injecting into a model prompt. */
  describe() {
    const s = this.snapshot();
    const lines = [`Current time: ${s.now}`];

    lines.push(
      s.tasks.active.length
        ? `Active tasks (${s.tasks.active.length}): ${s.tasks.active.map((t) => `"${t.goal}" [${t.status}]`).join('; ')}`
        : 'No active tasks.'
    );
    if (s.tasks.staleCount > 0) lines.push(`${s.tasks.staleCount} active task(s) have been open over 24h.`);
    if (s.tasks.failed.length) lines.push(`Failed tasks: ${s.tasks.failed.map((t) => `"${t.goal}"`).join('; ')}`);

    lines.push(
      s.pendingApprovals.length
        ? `Pending approvals (${s.pendingApprovals.length}): ${s.pendingApprovals.map((a) => a.toolName).join(', ')}`
        : 'No pending approvals.'
    );

    lines.push(
      s.activeAutomations.length
        ? `Active automations (${s.activeAutomations.length}): ${s.activeAutomations.map((r) => r.description).join('; ')}`
        : 'No active automations.'
    );

    if (s.devices.length) {
      lines.push(
        `Connected devices (${s.devices.length}): ${s.devices
          .map((d) => `${d.name} [${d.platform}, ${d.online ? 'online' : 'offline'}, ${d.trust}]`)
          .join('; ')}`
      );
    }

    return lines.join('\n');
  }
}
