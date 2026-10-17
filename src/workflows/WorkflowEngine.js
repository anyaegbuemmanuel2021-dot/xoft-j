import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { JsonStore } from '../persistence/JsonStore.js';

/**
 * WorkflowEngine — spec section 28. Distinct from TaskPlanner (which has
 * the AI dynamically plan an arbitrary goal on the spot) and RulesEngine
 * (natural-language trigger/condition/action). A workflow is a FIXED,
 * user-defined chain of tool calls, triggered by a real EventBus event,
 * where later steps can reference earlier steps' results — e.g. "when
 * EMAIL_RECEIVED fires, extract info, then create a calendar event using
 * that info." No AI planning involved in execution — the chain is exactly
 * what was defined; only step inputs get filled in from prior results.
 */
export class WorkflowEngine {
  constructor({ toolRegistry, activityLog, eventBus, memory, dataDir = './data', sqliteStore = null }) {
    this.toolRegistry = toolRegistry;
    this.activityLog = activityLog;
    this.eventBus = eventBus;
    this.memory = memory;
    this._store = new JsonStore({ dataDir, fileName: 'workflows.json', kvKey: 'workflows', defaultValue: { workflows: [], runs: [] }, sqliteStore });
    /** @type {Map<string, Function>} in-memory event-listener handles, keyed by workflow id — lost on restart, rebuilt by reattachListeners() */
    this._listeners = new Map();
  }

  _load() {
    return this._store.load();
  }

  _save(data) {
    this._store.save(data);
  }

  /**
   * @param {{name:string, triggerEventType:string, steps:Array<{toolName:string, input:object}>}} def
   *   Each step's `input` values may contain "{{steps.N.result.field}}" placeholders
   *   referencing an earlier step's result (0-indexed) — filled in at run time.
   */
  define({ name, triggerEventType, steps }) {
    for (const step of steps) {
      if (!this.toolRegistry.has(step.toolName)) {
        throw new Error(`WorkflowEngine: workflow '${name}' references unknown tool '${step.toolName}'`);
      }
    }
    const workflow = { id: crypto.randomUUID(), name, triggerEventType, steps, enabled: true, createdAt: new Date().toISOString() };
    const data = this._load();
    data.workflows.push(workflow);
    this._save(data);
    this.activityLog.log({ type: 'workflow_defined', detail: { workflowId: workflow.id, name, triggerEventType } });

    if (this.eventBus && triggerEventType) {
      const listener = (payload) => this.run(workflow.id, payload).catch((err) =>
        this.activityLog.log({ type: 'workflow_run_failed', detail: { workflowId: workflow.id, error: err.message } })
      );
      this.eventBus.on(triggerEventType, listener);
      this._listeners.set(workflow.id, listener);
    }
    return workflow;
  }

  /**
   * Re-attaches event listeners for enabled, event-triggered workflows
   * already in the file — call once at startup. define() attaches a
   * listener when a workflow is first created, but that listener is
   * in-memory only; without this, a restart would leave persisted
   * workflows enabled on paper but silently un-triggerable.
   */
  reattachListeners() {
    if (!this.eventBus) return;
    for (const wf of this._load().workflows) {
      if (!wf.enabled || !wf.triggerEventType || this._listeners.has(wf.id)) continue;
      const listener = (payload) => this.run(wf.id, payload).catch((err) =>
        this.activityLog.log({ type: 'workflow_run_failed', detail: { workflowId: wf.id, error: err.message } })
      );
      this.eventBus.on(wf.triggerEventType, listener);
      this._listeners.set(wf.id, listener);
    }
  }

  disable(workflowId) {
    const data = this._load();
    const wf = data.workflows.find((w) => w.id === workflowId);
    if (!wf) throw new Error(`WorkflowEngine: no workflow '${workflowId}'`);
    wf.enabled = false;
    this._save(data);
    const listener = this._listeners.get(workflowId);
    if (listener && this.eventBus) {
      this.eventBus.off(wf.triggerEventType, listener);
      this._listeners.delete(workflowId);
    }
    return wf;
  }

  /** Substitutes "{{steps.N.result.path.to.field}}" placeholders in a step's input using prior step results. */
  _resolveInput(input, priorResults) {
    const resolved = {};
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string' && value.startsWith('{{') && value.endsWith('}}')) {
        const pathExpr = value.slice(2, -2).trim(); // e.g. "steps.0.result.eventId"
        resolved[key] = this._getByPath({ steps: priorResults }, pathExpr);
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  _getByPath(obj, pathExpr) {
    return pathExpr.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
  }

  /**
   * Executes a workflow's steps in fixed order (sequential — this is a
   * chain, not a dependency graph like TaskPlanner). Runs through
   * ToolRegistry.execute(), so permission/emergency-stop enforcement
   * applies exactly as it does everywhere else.
   * @param {string} workflowId
   * @param {object} [triggerPayload] the event payload that fired this run, available as {{trigger.field}}
   */
  async run(workflowId, triggerPayload = {}) {
    const workflow = this._load().workflows.find((w) => w.id === workflowId);
    if (!workflow) throw new Error(`WorkflowEngine: no workflow '${workflowId}'`);
    if (!workflow.enabled) return { workflowId, status: 'skipped', reason: 'workflow disabled' };

    const runId = crypto.randomUUID();
    const stepResults = [];
    let status = 'completed';
    let failedAt = null;

    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      const context = { trigger: triggerPayload };
      // resolve {{trigger.X}} first, then {{steps.N.result.X}}
      const inputWithTrigger = {};
      for (const [k, v] of Object.entries(step.input)) {
        if (typeof v === 'string' && v.startsWith('{{trigger.')) {
          inputWithTrigger[k] = this._getByPath(context, v.slice(2, -2).trim());
        } else {
          inputWithTrigger[k] = v;
        }
      }
      const resolvedInput = this._resolveInput(inputWithTrigger, stepResults);

      try {
        const result = await this.toolRegistry.execute(step.toolName, resolvedInput, { memory: this.memory });
        stepResults.push({ toolName: step.toolName, status: 'completed', result });
        this.activityLog.log({ type: 'workflow_step_executed', detail: { workflowId, runId, stepIndex: i, toolName: step.toolName } });
      } catch (err) {
        stepResults.push({ toolName: step.toolName, status: 'failed', error: err.message });
        this.activityLog.log({ type: 'workflow_step_failed', detail: { workflowId, runId, stepIndex: i, toolName: step.toolName, error: err.message } });
        status = 'failed';
        failedAt = i;
        break; // sequential chain — stop at the first failure rather than continuing on broken assumptions
      }
    }

    const run = { id: runId, workflowId, status, failedAt, stepResults, triggerPayload, ranAt: new Date().toISOString() };
    const data = this._load();
    data.runs.push(run);
    this._save(data);
    return run;
  }

  list() {
    return this._load().workflows;
  }

  listRuns(workflowId) {
    const data = this._load();
    return workflowId ? data.runs.filter((r) => r.workflowId === workflowId) : data.runs;
  }
}
