import crypto from 'node:crypto';
import { TaskType } from '../providers/ProviderRouter.js';
import { EventType } from '../events/EventBus.js';
import { ExecutionRecordStore } from './ExecutionRecordStore.js';
import { ExperienceStore } from './ExperienceStore.js';
import { JsonStore } from '../persistence/JsonStore.js';
import { config } from '../config/index.js';
import { RiskLevel } from '../tools/Tool.js';

const PLANNING_SYSTEM_PROMPT = `You are a task planner for a personal AI assistant.
Given a goal and a list of available tools, break the goal into the smallest number of
concrete steps needed, each using exactly one available tool. Respect dependencies —
a step that needs another step's output must list that step's id in "dependsOn".

Only use tools from the provided list. If the goal cannot be accomplished with the
available tools, return an empty "steps" array and explain why in "blockedReason".

If a step targets a device (a tool with a "deviceId" input), you MUST use the real
device id from the KNOWN DEVICES list below — never invent one, and never use a device
name as if it were an id. If the goal names a device that isn't in the list, or the list
is empty, leave steps empty and explain that in "blockedReason" instead of guessing.

Respond with ONLY JSON, no markdown fences:
{
  "steps": [
    {"id": "step1", "toolName": "...", "input": {...}, "dependsOn": [], "description": "..."}
  ],
  "blockedReason": null
}`;

const MAX_RETRIES_PER_STEP = 2;
// Agent loop limit (spec: "every autonomous task should have a maximum
// number of steps... prevent infinite/runaway plans"). This is a ceiling on
// a single plan(), not a limit on how many tasks can exist — a legitimate
// large goal should be broken into multiple tasks/subgoals by the caller
// (see GoalSystem) rather than one single-task mega-plan.
const MAX_PLAN_STEPS = 40;

/**
 * TaskPlanner — implements spec sections 11 (autonomous task engine) and
 * 17 (error recovery): goal -> plan -> dependency-ordered execution ->
 * per-step verification -> bounded retry -> completion/failure report.
 *
 * Tasks and their step results persist to disk so `GET /api/tasks/:id`
 * reflects real state even after a restart.
 */
export class TaskPlanner {
  /**
   * @param {object} deps
   * @param {import('../providers/ProviderRouter.js').ProviderRouter} deps.router
   * @param {import('../tools/ToolRegistry.js').ToolRegistry} deps.toolRegistry
   * @param {import('../approval/ApprovalSystem.js').ApprovalSystem} deps.approvalSystem
   * @param {import('../activity/ActivityLog.js').ActivityLog} deps.activityLog
   * @param {import('../memory/MemoryManager.js').MemoryManager} deps.memory
   * @param {import('../devices/DeviceManager.js').DeviceManager} [deps.deviceManager]
   * @param {string} deps.dataDir
   */
  constructor({ router, toolRegistry, approvalSystem, activityLog, memory, eventBus, deviceManager, recoveryEngine, executionRecordStore, experienceStore, sqliteStore = null, dataDir = './data', maxDurationMs = config.task?.maxDurationMs }) {
    this.router = router;
    this.toolRegistry = toolRegistry;
    this.approvalSystem = approvalSystem;
    this.activityLog = activityLog;
    this.memory = memory;
    this.eventBus = eventBus;
    this.deviceManager = deviceManager ?? null;
    this.recoveryEngine = recoveryEngine ?? null;
    // Idempotency ledger — defaults to one backed by the same dataDir/sqliteStore so
    // existing callers/tests that don't pass one explicitly keep working.
    this.executionRecordStore = executionRecordStore ?? new ExecutionRecordStore({ dataDir, sqliteStore });
    this.experienceStore = experienceStore ?? new ExperienceStore({ dataDir, sqliteStore });
    this.maxDurationMs = Math.max(1000, Number(maxDurationMs ?? 15 * 60 * 1000));
    this._store = new JsonStore({ dataDir, fileName: 'tasks.json', kvKey: 'tasks', defaultValue: { tasks: [] }, sqliteStore });
  }

  _load() {
    return this._store.load();
  }

  _save(data) {
    this._store.save(data);
  }

  _getTask(taskId) {
    const task = this._load().tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`TaskPlanner: no task '${taskId}'`);
    return task;
  }

  _updateTask(taskId, updater) {
    const data = this._load();
    const idx = data.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) throw new Error(`TaskPlanner: no task '${taskId}'`);
    data.tasks[idx] = updater(data.tasks[idx]);
    this._save(data);
    return data.tasks[idx];
  }

  /**
   * Creates a plan for a goal using available tools, but does not execute it.
   * @param {string} goal
   * @returns {Promise<object>} the created task record
   */
  async plan(goal) {
    const toolSchemas = this.toolRegistry.schemasForAI();
    const toolList = toolSchemas
      .map((t) => `- ${t.name}: ${t.description} | input: ${JSON.stringify(t.inputSchema)}`)
      .join('\n');

    // KNOWN DEVICES — real ids only, so the planner can never invent one for
    // a device-targeting tool (spec section 11 ExecutiveBrain integration).
    // Only trusted devices are listed; untrusted ones can't receive commands
    // anyway (DeviceManager.execute enforces that independently as a second gate).
    const devices = this.deviceManager?.listDevices().filter((d) => d.platform !== 'server' && d.trust === 'trusted') ?? [];
    const deviceList = devices.length
      ? devices.map((d) => `- id: ${d.id} | name: "${d.name}" | platform: ${d.platform} | online: ${d.online} | capabilities: [${d.capabilities.join(', ')}]`).join('\n')
      : 'No trusted devices are currently registered.';

    const result = await this.router.complete(TaskType.REASONING, {
      system: `${PLANNING_SYSTEM_PROMPT}\n\nAVAILABLE TOOLS:\n${toolList}\n\nKNOWN DEVICES:\n${deviceList}`,
      messages: [{ role: 'user', content: `Goal: ${goal}` }],
      maxTokens: 1500,
    });

    let parsed;
    try {
      const cleaned = result.text.trim().replace(/^```json\s*|\s*```$/g, '');
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(`TaskPlanner: planner model returned non-JSON output: ${result.text.slice(0, 200)}`);
    }

    const taskId = crypto.randomUUID();
    const rawSteps = parsed.steps ?? [];
    // Guard against a runaway/malformed plan (spec section 67, "agent loop
    // limits" — a plan is rejected outright rather than silently truncated,
    // since executing an arbitrary prefix of an oversized plan could leave a
    // multi-step goal half-done with no coherent stopping point).
    if (rawSteps.length > MAX_PLAN_STEPS) {
      const task = {
        id: taskId,
        goal,
        status: 'blocked',
        blockedReason: `Planner returned ${rawSteps.length} steps, which exceeds the safety limit of ${MAX_PLAN_STEPS} steps for a single task. Break this goal into smaller tasks or a multi-task goal instead.`,
        steps: [],
        priority: 'normal',
        createdBy: 'user',
        createdAt: new Date().toISOString(),
        scheduledFor: null,
        startedAt: null,
        completedAt: null,
      };
      const data = this._load();
      data.tasks.push(task);
      this._save(data);
      this.activityLog.log({ type: 'task_blocked_oversized_plan', taskId, detail: { goal, stepCount: rawSteps.length, limit: MAX_PLAN_STEPS } });
      return task;
    }
    const steps = rawSteps.map((s) => ({
      ...s,
      status: 'pending', // pending | waiting_approval | running | completed | failed | blocked | rolled_back | cancelled
      result: null,
      error: null,
      attempts: 0,
      maxAttempts: MAX_RETRIES_PER_STEP + 1,
      // Stable identity of "this logical action" — used by ExecutionRecordStore
      // to detect and skip a duplicate re-execution (see idempotency section).
      idempotencyKey: ExecutionRecordStore.keyFor(taskId, s.id),
      undo: null,
    }));

    const task = {
      id: taskId,
      goal,
      status: steps.length ? 'planned' : 'blocked',
      blockedReason: parsed.blockedReason ?? null,
      steps,
      priority: 'normal',
      createdBy: 'user',
      createdAt: new Date().toISOString(),
      scheduledFor: null,
      startedAt: null,
      completedAt: null,
    };

    const data = this._load();
    data.tasks.push(task);
    this._save(data);

    this.activityLog.log({ type: 'task_created', taskId, detail: { goal, stepCount: steps.length } });
    this.eventBus?.emitEvent(EventType.TASK_CREATED, { taskId, goal, stepCount: steps.length });
    return task;
  }

  /**
   * Executes as much of a planned task's step graph as currently possible,
   * stopping cleanly at the first step that needs approval or has
   * exhausted its retries.
   * @param {string} taskId
   */
  async execute(taskId) {
    const timeoutMs = this.maxDurationMs;
    let timer;
    const work = this._executeTask(taskId);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`TaskPlanner: task '${taskId}' exceeded the maximum duration of ${timeoutMs}ms.`)), timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } catch (err) {
      if (String(err?.message).includes('exceeded the maximum duration')) {
        const task = this._getTask(taskId);
        this._updateTask(taskId, (t) => ({ ...t, status: 'timed_out', timedOutAt: new Date().toISOString(), timeoutMs, error: err.message }));
        this.activityLog.log({ type: 'task_timed_out', taskId, detail: { timeoutMs } });
        this.eventBus?.emitEvent(EventType.TASK_FAILED, { taskId, goal: task.goal, reason: 'timeout' });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async _executeTask(taskId) {
    let task = this._getTask(taskId);
    if (task.status === 'blocked') return task;

    const alreadyStarted = Boolean(task.startedAt);
    task = this._updateTask(taskId, (t) => ({ ...t, status: 'running', startedAt: t.startedAt ?? new Date().toISOString() }));
    if (!alreadyStarted) this.eventBus?.emitEvent(EventType.TASK_STARTED, { taskId, goal: task.goal });

    for (const step of task.steps) {
      if (step.status === 'completed') continue;

      const dependenciesDone = step.dependsOn.every(
        (depId) => task.steps.find((s) => s.id === depId)?.status === 'completed'
      );
      if (!dependenciesDone) {
        task = this._updateTask(taskId, (t) => ({ ...t, status: 'blocked' }));
        break;
      }

      const stepResult = await this._runStep(taskId, step);
      task = this._getTask(taskId);

      if (stepResult.status === 'waiting_approval') {
        task = this._updateTask(taskId, (t) => ({ ...t, status: 'waiting_approval' }));
        break;
      }
      if (stepResult.status === 'failed') {
        task = this._updateTask(taskId, (t) => ({ ...t, status: 'failed', completedAt: new Date().toISOString() }));
        this.eventBus?.emitEvent(EventType.TASK_FAILED, { taskId, goal: task.goal });
        break;
      }
    }

    task = this._getTask(taskId);
    if (task.steps.every((s) => s.status === 'completed')) {
      task = this._updateTask(taskId, (t) => ({ ...t, status: 'completed', completedAt: new Date().toISOString() }));
      this.activityLog.log({ type: 'task_completed', taskId });
      this.eventBus?.emitEvent(EventType.TASK_COMPLETED, { taskId, goal: task.goal });
    }
    return task;
  }

  /** Runs a single step: approval check -> execute -> verify -> retry-on-failure. */
  /**
   * Runs a single step: checks a previously-issued approval before
   * re-evaluating risk, so resuming after approval doesn't mint a fresh
   * approval request and chase its own tail. Only evaluates risk fresh
   * for a step that hasn't been through approval before.
   */
  async _runStep(taskId, step) {
    const tool = this.toolRegistry.get(step.toolName);

    if (step.status === 'waiting_approval' && step.approvalId) {
      const record = this.approvalSystem.get(step.approvalId);
      if (record?.status === 'approved') {
        return this._executeStep(taskId, { ...step, forceRetryAfterAmbiguous: Boolean(record.reason === 'ambiguous_prior_execution') }, tool);
      }
      if (record?.status === 'rejected') {
        this._patchStep(taskId, step.id, { status: 'failed', error: 'approval rejected' });
        this.activityLog.log({ type: 'task_failed', taskId, toolName: tool.name, detail: { error: 'approval rejected' } });
        return { status: 'failed', error: 'approval rejected' };
      }
      return { status: 'waiting_approval' }; // still pending, nothing new to do
    }

    // Ambiguity check MUST come before the normal risk-based approval gate
    // below, not after it. Checking risk first would (a) ask for a generic
    // approval that carries no `reason`, meaning the caller-visible
    // approvalId wouldn't be the ambiguity-specific one the UI needs to
    // explain *why* it's asking again, and (b) for an autonomy-configured
    // EXTERNAL tool that would normally auto-execute, skip asking
    // altogether — silently retrying a step whose real-world outcome is
    // unknown. An ambiguous EXTERNAL/HIGH_IMPACT step must always get a
    // fresh, explicit, reason-tagged approval (via requestApproval, which
    // bypasses autonomy auto-approval by design), regardless of what the
    // normal risk gate would have decided.
    const idempotencyKey = step.idempotencyKey ?? ExecutionRecordStore.keyFor(taskId, step.id);
    const dangling = this.executionRecordStore.findDangling(idempotencyKey);
    if (dangling && !step.forceRetryAfterAmbiguous && tool.riskLevel >= RiskLevel.EXTERNAL) {
      this.activityLog.log({ type: 'ambiguous_prior_execution', taskId, toolName: tool.name, detail: { idempotencyKey, danglingExecutionId: dangling.executionId, note: 'previous attempt outcome unknown — fresh approval required before retrying an EXTERNAL/HIGH_IMPACT action' } });
      this.eventBus?.emitEvent(EventType.EXECUTION_AMBIGUOUS, { taskId, stepId: step.id, toolName: tool.name, idempotencyKey });
      const decision = this.approvalSystem.requestApproval({
        tool, input: step.input, taskId, reason: 'ambiguous_prior_execution',
        metadata: { danglingExecutionId: dangling.executionId, idempotencyKey },
      });
      this._patchStep(taskId, step.id, { status: 'waiting_approval', approvalId: decision.approvalId, ambiguousExecution: true });
      return { status: 'waiting_approval', approvalId: decision.approvalId };
    }

    const decision = this.approvalSystem.evaluate({ tool, input: step.input, taskId });

    if (decision.decision === 'requires_approval') {
      this._patchStep(taskId, step.id, { status: 'waiting_approval', approvalId: decision.approvalId });
      return { status: 'waiting_approval' };
    }

    // A SAFE/LOW-risk tool with a dangling record is safe to auto-retry
    // (that's the whole point of the risk split above), but the ambiguity
    // is still worth an honest audit-log entry rather than a silent retry.
    if (dangling && !step.forceRetryAfterAmbiguous) {
      this.activityLog.log({ type: 'ambiguous_prior_execution', taskId, toolName: tool.name, detail: { idempotencyKey, danglingExecutionId: dangling.executionId, note: 'previous attempt outcome unknown for a SAFE/LOW-risk tool — auto-retrying without approval' } });
      this.eventBus?.emitEvent(EventType.EXECUTION_AMBIGUOUS, { taskId, stepId: step.id, toolName: tool.name, idempotencyKey });
    }

    return this._executeStep(taskId, step, tool);
  }

  async _executeStep(taskId, step, tool) {
    const idempotencyKey = step.idempotencyKey ?? ExecutionRecordStore.keyFor(taskId, step.id);

    // Idempotency check — the actual duplicate-execution guard. If this exact
    // logical action already has a *succeeded* record (e.g. the process
    // restarted right after a network drop that happened just after the tool
    // call itself succeeded), reuse that result instead of resending it.
    const priorSuccess = this.executionRecordStore.findLatestSucceeded(idempotencyKey);
    if (priorSuccess) {
      this.activityLog.log({ type: 'duplicate_execution_prevented', taskId, toolName: tool.name, detail: { idempotencyKey, reusedExecutionId: priorSuccess.executionId } });
      this.eventBus?.emitEvent(EventType.EXECUTION_DUPLICATE_PREVENTED, { taskId, stepId: step.id, toolName: tool.name, idempotencyKey });
      const undo = tool.computeUndo ? tool.computeUndo(step.input, priorSuccess.result) : null;
      const verification = priorSuccess.verification ?? { verified: null, note: 'reused from a previous successful attempt; not re-verified' };
      this._patchStep(taskId, step.id, { status: 'completed', result: priorSuccess.result, error: null, undo, verification });
      return { status: 'completed', result: priorSuccess.result };
    }

    this._patchStep(taskId, step.id, { status: 'running', forceRetryAfterAmbiguous: false });
    const attemptNumber = (step.attempts ?? 0) + 1;
    const record = this.executionRecordStore.begin({ taskId, stepId: step.id, toolName: tool.name, idempotencyKey, attemptNumber, input: step.input });
    try {
      const result = await this.toolRegistry.execute(tool.name, step.input, { memory: this.memory, providerRouter: this.router, deviceManager: this.deviceManager });
      this.eventBus?.emitEvent(EventType.TASK_VERIFYING, { taskId, stepId: step.id, toolName: tool.name });
      const verification = await this._verifyResult(tool, step, result);
      this.executionRecordStore.complete(record.executionId, { status: 'succeeded', result, verification });
      this.activityLog.log({ type: 'tool_executed', taskId, toolName: tool.name, detail: { input: step.input, result, verification } });
      const undo = tool.computeUndo ? tool.computeUndo(step.input, result) : null;
      this._patchStep(taskId, step.id, { status: 'completed', result, error: null, undo, verification });
      return { status: 'completed', result };
    } catch (err) {
      this.executionRecordStore.complete(record.executionId, { status: 'failed', error: err.message });
      const attempts = (step.attempts ?? 0) + 1;
      this.activityLog.log({ type: 'tool_failed', taskId, toolName: tool.name, detail: { attempt: attempts, error: err.message } });

      if (attempts <= MAX_RETRIES_PER_STEP) {
        this.eventBus?.emitEvent(EventType.TASK_RETRYING, { taskId, stepId: step.id, toolName: tool.name, attempt: attempts });
        // Adaptive recovery: diagnose the failure and choose a bounded strategy.
        // Device restart remains the first safe recovery for app-specific failures;
        // otherwise the planner may choose an existing equal/lower-risk tool.
        let recovery = null;
        if (this.recoveryEngine) {
          try {
            this.eventBus?.emitEvent(EventType.TASK_RECOVERING, { taskId, stepId: step.id, toolName: tool.name, attempt: attempts });
            recovery = await this.recoveryEngine.chooseStrategy({ goal: this._getTask(taskId).goal, step, error: err, experienceStore: this.experienceStore });
            this._patchStep(taskId, step.id, { lastRecovery: recovery });
            if (recovery.strategy === 'abort') {
              this._patchStep(taskId, step.id, { status: 'failed', attempts, error: err.message, recoveryDecision: recovery.reason });
              this._recordExperience({ toolName: tool.name, step, err, failureCategory: recovery.diagnosis, recoveryStrategy: 'abort', recoveryOutcome: 'aborted' });
              return { status: 'failed', error: err.message };
            }
            if (recovery.strategy === 'restart_app' && step.input?.deviceId && step.input?.application) {
              const deviceRecovery = await this.recoveryEngine.recoverDeviceStep({ deviceManager: this.deviceManager, deviceId: step.input.deviceId, application: step.input.application, toolName: tool.name, error: err, attempt: attempts });
              this._patchStep(taskId, step.id, { recovery: deviceRecovery.actions ?? [], lastRecovery: { ...recovery, deviceRecovery } });
            } else if (recovery.strategy === 'retry_with_adjusted_input') {
              step.input = { ...step.input, ...recovery.inputPatch };
              this._patchStep(taskId, step.id, { input: step.input });
            } else if (recovery.strategy === 'alternative_tool' && recovery.toolName) {
              const alternative = this.toolRegistry.get(recovery.toolName);
              if (alternative.riskLevel <= tool.riskLevel) {
                tool = alternative;
                step.toolName = alternative.name;
                step.input = { ...step.input, ...recovery.inputPatch };
                this._patchStep(taskId, step.id, { toolName: alternative.name, input: step.input });
              } else {
                recovery.strategy = 'abort';
                recovery.reason = 'alternative tool would increase risk';
                this._patchStep(taskId, step.id, { status: 'failed', attempts, error: err.message, recoveryDecision: recovery.reason });
                this._recordExperience({ toolName: tool.name, step, err, failureCategory: recovery.diagnosis, recoveryStrategy: 'abort', recoveryOutcome: 'aborted' });
                return { status: 'failed', error: err.message };
              }
            }
          } catch (recoveryErr) {
            this.activityLog.log({ type: 'recovery_failed', taskId, toolName: tool.name, detail: { error: recoveryErr.message } });
          }
        }
        try {
          await this.memory?.remember?.('execution_failure', `Task ${taskId}, tool ${tool.name} failed on attempt ${attempts}: ${err.message}`, { taskId, toolName: tool.name, error: err.message, attempt: attempts }, { source: 'SYSTEM_OBSERVED', confidence: 1, relatedTaskId: taskId });
        } catch { /* learning must never break execution */ }
        this._patchStep(taskId, step.id, { status: 'pending', attempts, error: err.message });
        const retryResult = await this._executeStep(taskId, { ...step, attempts }, tool);
        if (recovery && recovery.strategy !== 'abort') {
          this._recordExperience({
            toolName: tool.name,
            step,
            err,
            failureCategory: recovery.diagnosis,
            recoveryStrategy: recovery.strategy,
            recoveryOutcome: retryResult.status === 'completed' ? 'recovered' : 'failed',
          });
        }
        return retryResult;
      }

      try {
        await this.memory?.remember?.('execution_failure', `Task ${taskId}, tool ${tool.name} exhausted retries: ${err.message}`, { taskId, toolName: tool.name, error: err.message, attempts }, { source: 'SYSTEM_OBSERVED', confidence: 1, relatedTaskId: taskId });
      } catch { /* learning must never break execution */ }
      this._patchStep(taskId, step.id, { status: 'failed', attempts, error: err.message });
      this.activityLog.log({ type: 'task_failed', taskId, toolName: tool.name, detail: { error: err.message } });
      this._recordExperience({ toolName: tool.name, step, err, failureCategory: 'unknown', recoveryStrategy: 'none', recoveryOutcome: 'exhausted' });
      return { status: 'failed', error: err.message };
    }
  }

  _patchStep(taskId, stepId, patch) {
    this._updateTask(taskId, (t) => ({
      ...t,
      steps: t.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
    }));
  }

  /**
   * Self-verification (spec: "no false completion"). A tool's own
   * `.verify()` handler, if it has one, is the real check. Absent that, a
   * tool that nested its own verification directly onto the result object
   * (one existing tool does this) is still honored. Otherwise the step is
   * marked explicitly *unverified* rather than silently treated as
   * confirmed just because the call didn't throw.
   */
  async _verifyResult(tool, step, result) {
    if (result?.verification) return result.verification;
    if (tool.verify) {
      try {
        return await tool.verify(step.input, result, { memory: this.memory, deviceManager: this.deviceManager });
      } catch (verifyErr) {
        return { verified: false, note: `verification check itself failed: ${verifyErr.message}` };
      }
    }
    return { verified: null, note: 'no verify() handler for this tool — success is assumed from the call completing without error, not independently confirmed' };
  }

  /** Records a real recovery observation to the experience store. Never allowed to break execution. */
  _recordExperience({ toolName, step, err, failureCategory, recoveryStrategy, recoveryOutcome }) {
    try {
      this.experienceStore.record({
        toolName,
        failureCategory,
        errorMessage: err?.message,
        recoveryStrategy,
        recoveryOutcome,
        inputSignature: ExperienceStore.inputSignature(step.input),
        environment: step.input?.deviceId ? { deviceId: step.input.deviceId } : {},
      });
    } catch { /* learning must never break execution */ }
  }

  /** Call after an approval is granted to resume execution from where it stopped. */
  async resumeAfterApproval(taskId) {
    return this.execute(taskId);
  }

  /**
   * Dry-run — spec section 23. Builds a human-readable plan preview and risk
   * summary WITHOUT executing anything. Shared by ExecutiveBrain's
   * confirmation flow and the standalone preview API so there's one source
   * of truth for what "the plan" means.
   */
  previewPlan(taskId) {
    const task = this._getTask(taskId);
    const RiskNames = { 0: 'SAFE', 1: 'LOW', 2: 'EXTERNAL', 3: 'HIGH_IMPACT' };
    const stepPreviews = task.steps.map((s) => {
      const tool = this.toolRegistry.get(s.toolName);
      return { description: s.description, toolName: s.toolName, riskLevel: tool.riskLevel, riskName: RiskNames[tool.riskLevel] };
    });
    const maxRisk = stepPreviews.length ? Math.max(...stepPreviews.map((s) => s.riskLevel)) : 0;
    return {
      taskId,
      goal: task.goal,
      steps: stepPreviews,
      maxRisk,
      maxRiskName: RiskNames[maxRisk],
      requiresApproval: maxRisk >= 2, // EXTERNAL or HIGH_IMPACT
      text: stepPreviews.map((s, i) => `${i + 1}. ${s.description} (${s.riskName})`).join('\n'),
    };
  }

  /**
   * Rollback — spec section 25. Reverses completed steps in reverse order,
   * for whichever ones actually have undo info (recorded at execution time
   * from the tool's own computeUndo). Steps without a computeUndo are
   * skipped and reported as not-reversible rather than silently ignored.
   */
  async undoTask(taskId) {
    const task = this._getTask(taskId);
    const completedWithUndo = [...task.steps].reverse().filter((s) => s.status === 'completed');
    const results = [];

    for (const step of completedWithUndo) {
      if (!step.undo) {
        results.push({ stepId: step.id, description: step.description, reversed: false, reason: 'not reversible' });
        continue;
      }
      try {
        await this.toolRegistry.execute(step.undo.toolName, step.undo.input, { memory: this.memory });
        this._patchStep(taskId, step.id, { status: 'rolled_back' });
        this.activityLog.log({ type: 'step_rolled_back', taskId, toolName: step.toolName, detail: { undoTool: step.undo.toolName } });
        results.push({ stepId: step.id, description: step.description, reversed: true });
      } catch (err) {
        this.activityLog.log({ type: 'rollback_failed', taskId, toolName: step.toolName, detail: { error: err.message } });
        results.push({ stepId: step.id, description: step.description, reversed: false, reason: err.message });
      }
    }

    const allReversedOrSkippedCleanly = results.every((r) => r.reversed || r.reason === 'not reversible');
    this._updateTask(taskId, (t) => ({ ...t, status: allReversedOrSkippedCleanly ? 'rolled_back' : 'rollback_partial' }));
    return { taskId, results };
  }

  get(taskId) {
    return this._getTask(taskId);
  }

  list() {
    return this._load().tasks;
  }

  cancel(taskId) {
    const task = this._updateTask(taskId, (t) => ({
      ...t,
      status: 'cancelled',
      completedAt: t.completedAt ?? new Date().toISOString(),
      steps: t.steps.map((s) => (s.status === 'pending' || s.status === 'waiting_approval' ? { ...s, status: 'cancelled' } : s)),
    }));
    this.activityLog.log({ type: 'task_cancelled', taskId });
    this.eventBus?.emitEvent(EventType.TASK_CANCELLED, { taskId, goal: task.goal });
    return task;
  }

  /** Execution ledger for a task — every attempt, per step, with idempotency keys. Spec: task engine / idempotency observability. */
  executions(taskId) {
    return this.executionRecordStore.forTask(taskId);
  }

  /** Full experience ledger, or filtered to one tool/failure category. Spec: experience store observability. */
  experiences({ toolName, failureCategory } = {}) {
    if (!toolName) return this.experienceStore.list();
    return this.experienceStore.relevantFor({ toolName, failureCategory }, 200);
  }

  /** Sets a task's status (+ optional extra fields) directly — used by TaskQueue for queued/scheduled transitions so it never touches tasks.json itself. */
  setStatus(taskId, status, extra = {}) {
    return this._updateTask(taskId, (t) => ({ ...t, status, ...extra }));
  }
}
