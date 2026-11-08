import { TaskType } from '../providers/ProviderRouter.js';
import { RiskLevel } from '../tools/Tool.js';
import { ExecutiveClassifier, ExecutiveAction } from './ExecutiveClassifier.js';

const CONFIDENCE_THRESHOLD = 55;

const WORLD_STATE_SYSTEM_PROMPT = `You are XOFT, a personal AI assistant. Answer the user's question about their
current situation using ONLY the WORLD STATE data below — don't invent tasks, approvals, or deadlines that
aren't listed. Be concise and direct, like a briefing, not a report.`;

const SUMMARY_SYSTEM_PROMPT = `You are XOFT. Summarize the outcome of a task in 1-3 sentences, plainly, the way
you'd tell a person what happened. State clearly whether it fully succeeded, partially succeeded, or failed —
never imply success if any step failed. Don't list internal step ids or JSON.`;

/**
 * ExecutiveBrain — spec section 2. Sits above the existing Orchestrator
 * rather than replacing it: plain conversation and single memory operations
 * still go straight to Orchestrator.handle() (preserves what already works).
 * This layer adds the parts that were missing — situational awareness,
 * confidence-gated planning, and genuine multi-step reasoning with an
 * explicit risk/approval checkpoint before anything executes.
 *
 * Pipeline: UNDERSTAND -> CONTEXT -> MEMORY -> REASON -> PLAN -> CONFIDENCE ->
 * RISK -> PERMISSION -> EXECUTE -> VERIFY -> RESPOND. Chain-of-thought stays
 * internal; only concise reasoning summaries and results are returned.
 */
export class ExecutiveBrain {
  /**
   * @param {object} deps
   * @param {import('../providers/ProviderRouter.js').ProviderRouter} deps.router
   * @param {import('../memory/MemoryManager.js').MemoryManager} deps.memory
   * @param {import('../orchestrator/Orchestrator.js').Orchestrator} deps.orchestrator
   * @param {import('../planner/TaskPlanner.js').TaskPlanner} deps.taskPlanner
   * @param {import('../approval/ApprovalSystem.js').ApprovalSystem} deps.approvalSystem
   * @param {import('./WorldState.js').WorldState} deps.worldState
   * @param {import('../activity/ActivityLog.js').ActivityLog} deps.activityLog
   * @param {import('../confidence/ConfidenceEngine.js').ConfidenceEngine} [deps.confidenceEngine]
   * @param {import('../personality/PersonalityEngine.js').PersonalityEngine} [deps.personality]
   * @param {import('../advisor/AdvisorAgent.js').AdvisorAgent} [deps.advisorAgent]
   * @param {import('../intelligence/IntelligenceDirector.js').IntelligenceDirector} [deps.intelligenceDirector]
   */
  constructor({ router, memory, orchestrator, taskPlanner, approvalSystem, worldState, activityLog, confidenceEngine, personality, advisorAgent, intelligenceDirector, address }) {
    this.address = address ?? null;
    this.router = router;
    this.memory = memory;
    this.orchestrator = orchestrator;
    this.taskPlanner = taskPlanner;
    this.approvalSystem = approvalSystem;
    this.worldState = worldState;
    this.activityLog = activityLog;
    this.confidenceEngine = confidenceEngine ?? null;
    this.personality = personality ?? null;
    this.advisorAgent = advisorAgent ?? null;
    this.intelligenceDirector = intelligenceDirector ?? null;
    this.classifier = new ExecutiveClassifier(router);
    /** @type {Map<string, {taskId:string, goal:string}>} last proposed-but-unconfirmed plan per session */
    this._pendingPlans = new Map();
  }

  _personalityFragment(context = {}, sessionId = null) {
    const base = this.personality ? `\n\n${this.personality.describeForPrompt(context)}` : '';
    const addr = this.address && sessionId ? `\n\n${this.address.describeForPrompt(sessionId)}` : '';
    return base + addr;
  }

  /**
   * @param {string} sessionId
   * @param {string} message
   * @returns {Promise<{action:string, reply:string, meta?:object}>}
   */
  async handle(sessionId, message) {
    // UNDERSTAND
    const classification = await this.classifier.classify(message);
    this.activityLog.log({ type: 'executive_classified', detail: { sessionId, action: classification.action } });

    switch (classification.action) {
      case ExecutiveAction.WORLD_STATE:
        return this._handleWorldState(sessionId, message);
      case ExecutiveAction.GOAL:
        return this._handleGoal(sessionId, message);
      case ExecutiveAction.ADVISE:
        return this._handleAdvise(sessionId, message);
      case ExecutiveAction.CONFIRM:
        return this._handleConfirm(sessionId);
      case ExecutiveAction.CANCEL:
        return this._handleCancel(sessionId);
      default:
        // DELEGATE — plain conversation or a single memory op. The existing
        // Orchestrator already implements this correctly; don't duplicate it.
        return this.orchestrator.handle(sessionId, message);
    }
  }

  // ADVISE — genuine problem-solving, grounded in real project context, no execution
  async _handleAdvise(sessionId, message) {
    this.memory.addTurn(sessionId, 'user', message);

    if (!this.advisorAgent) {
      const reply = "I don't have an advisor configured right now.";
      return { action: 'advise', reply };
    }

    const context = this.worldState.describe() + this._personalityFragment({}, sessionId);
    const reply = await this.advisorAgent.advise(message, context);

    this.memory.addTurn(sessionId, 'assistant', reply);
    this.activityLog.log({ type: 'advice_given', detail: { sessionId } });
    return { action: 'advise', reply };
  }

  // CONTEXT + REASON, for situational-awareness questions
  async _handleWorldState(sessionId, message) {
    this.memory.addTurn(sessionId, 'user', message);
    const worldStateText = this.worldState.describe();

    const result = await this.router.complete(TaskType.REASONING, {
      system: `${WORLD_STATE_SYSTEM_PROMPT}\n\nWORLD STATE:\n${worldStateText}${this._personalityFragment({}, sessionId)}`,
      messages: [{ role: 'user', content: message }],
      maxTokens: 400,
    });

    this.memory.addTurn(sessionId, 'assistant', result.text);
    return { action: 'world_state', reply: result.text, meta: { worldState: this.worldState.snapshot() } };
  }

  // PLAN + CONFIDENCE + RISK ASSESSMENT
  async _handleGoal(sessionId, message) {
    this.memory.addTurn(sessionId, 'user', message);

    const task = await this.taskPlanner.plan(message);

    if (task.status === 'blocked' || task.steps.length === 0) {
      const reply = `I can't put together a plan for that with the tools I have${task.blockedReason ? `: ${task.blockedReason}` : '.'}`;
      this.memory.addTurn(sessionId, 'assistant', reply);
      return { action: 'goal', reply, meta: { task } };
    }

    // DELIBERATION — recall relevant memory, decompose the goal, critique the
    // generated plan, identify material uncertainty, then score confidence.
    // This is the intelligence upgrade: planning is no longer the end of
    // reasoning; XOFT gets a second independent validation pass before acting.
    let intelligence = null;
    if (this.intelligenceDirector) {
      intelligence = await this.intelligenceDirector.preflight(message, task);
      const score = Math.min(intelligence.confidence.score, intelligence.critique.score);
      const blockingIssues = intelligence.critique.issues.filter(i => i.severity === 'high');
      const materialUncertainty = intelligence.uncertainty.uncertainties.length > 0;
      if (score < CONFIDENCE_THRESHOLD || blockingIssues.length > 0 || materialUncertainty) {
        const cancelled = this.taskPlanner.cancel(task.id);
        const why = blockingIssues[0]?.fix || intelligence.uncertainty.uncertainties[0]?.question || intelligence.confidence.reasoning;
        const reply = `I’m not ready to execute this yet (${score}% confidence). ${why} Please clarify or adjust the request.`;
        this.memory.addTurn(sessionId, 'assistant', reply);
        return { action: 'goal', reply, meta: { task: cancelled, intelligence, needsClarification: true } };
      }
    } else if (this.confidenceEngine) {
      const stepDescriptions = task.steps.map((s) => s.description).join('; ');
      const confidence = await this.confidenceEngine.assess(
        "this plan correctly accomplishes the user's request",
        `Request: "${message}"\nProposed plan: ${stepDescriptions}`
      );
      this.activityLog.log({ type: 'confidence_assessed', detail: { taskId: task.id, score: confidence.score } });
      if (confidence.score < CONFIDENCE_THRESHOLD) {
        const cancelled = this.taskPlanner.cancel(task.id);
        const reply = `I'm not confident I've got this right (${confidence.score}%) — ${confidence.reasoning} Can you clarify?`;
        this.memory.addTurn(sessionId, 'assistant', reply);
        return { action: 'goal', reply, meta: { task: cancelled, confidence, needsClarification: true } };
      }
    }

    const preview = this.taskPlanner.previewPlan(task.id);

    if (!preview.requiresApproval) {
      // PERMISSION check is implicit (all steps SAFE/LOW) — EXECUTE immediately.
      const executed = await this.taskPlanner.execute(task.id);
      await this.intelligenceDirector?.learn(message, executed);
      return this._verifyAndRespond(sessionId, executed);
    }

    // RISK is high enough to require explicit go-ahead before EXECUTE.
    this._pendingPlans.set(sessionId, { taskId: task.id, goal: message });
    const reply = `Here's the plan:\n${preview.text}\n\nThis includes at least one ${preview.maxRiskName}-risk step, so I'll wait for you to confirm before running it. Say "do it" to proceed.`;
    this.memory.addTurn(sessionId, 'assistant', reply);
    return { action: 'goal', reply, meta: { task, preview, intelligence, awaitingConfirmation: true } };
  }

  async _handleConfirm(sessionId) {
    const pending = this._pendingPlans.get(sessionId);
    if (!pending) {
      const reply = "I don't have a plan waiting on your confirmation right now.";
      return { action: 'confirm', reply };
    }
    this._pendingPlans.delete(sessionId);

    let executed = await this.taskPlanner.execute(pending.taskId);

    // The plan-preview + "do it" exchange the user just went through IS their
    // approval for this task's steps. Don't make them approve a second time
    // through a separate queue — auto-approve any ApprovalSystem entries that
    // TaskPlanner just raised for this specific task, then resume.
    let guard = 0;
    while (executed.status === 'waiting_approval' && guard < 10) {
      const relevant = this.approvalSystem.listPending().filter((a) => a.taskId === pending.taskId);
      if (relevant.length === 0) break; // waiting on something not tied to this confirmed task — stop, don't auto-approve blindly
      for (const approval of relevant) this.approvalSystem.approve(approval.id);
      executed = await this.taskPlanner.resumeAfterApproval(pending.taskId);
      guard += 1;
    }

    await this.intelligenceDirector?.learn(pending.goal, executed);
    return this._verifyAndRespond(sessionId, executed);
  }

  async _handleCancel(sessionId) {
    const pending = this._pendingPlans.get(sessionId);
    if (!pending) {
      const reply = "There's nothing pending to cancel.";
      return { action: 'cancel', reply };
    }
    this._pendingPlans.delete(sessionId);
    this.taskPlanner.cancel(pending.taskId);
    const reply = 'Cancelled — I haven\'t run anything.';
    this.memory.addTurn(sessionId, 'assistant', reply);
    return { action: 'cancel', reply };
  }

  // VERIFY + RESPOND
  async _verifyAndRespond(sessionId, task) {
    const stepSummary = task.steps
      .map((s) => `${s.description}: ${s.status}${s.error ? ` (${s.error})` : ''}`)
      .join('\n');

    const result = await this.router.complete(TaskType.SIMPLE, {
      system: SUMMARY_SYSTEM_PROMPT + this._personalityFragment({}, sessionId),
      messages: [{ role: 'user', content: `Task: ${task.goal}\nOverall status: ${task.status}\nSteps:\n${stepSummary}` }],
      maxTokens: 200,
    });

    this.memory.addTurn(sessionId, 'assistant', result.text);
    this.activityLog.log({ type: 'executive_verified', detail: { taskId: task.id, status: task.status } });
    return { action: 'goal', reply: result.text, meta: { task } };
  }
}
