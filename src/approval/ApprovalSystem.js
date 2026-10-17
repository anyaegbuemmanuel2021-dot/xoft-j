import crypto from 'node:crypto';
import { RiskLevel } from '../tools/Tool.js';
import { EventType } from '../events/EventBus.js';
import { JsonStore } from '../persistence/JsonStore.js';
import { domainForTool } from '../autonomy/DomainAutonomy.js';

/**
 * ApprovalSystem — implements spec sections 14-16.
 *
 * Decision rule:
 *   SAFE (0)          -> always auto-executes
 *   LOW (1)           -> auto-executes unless user config sets autoApproveLow=false
 *   EXTERNAL (2)      -> requires approval unless user config explicitly allowlists it
 *   HIGH_IMPACT (3)   -> ALWAYS requires approval, no config can override this
 *
 * This never asks "should I do this?" for level 0/1 — see spec section 15
 * ("ask only when necessary"). It only interrupts for level 2/3.
 *
 * Persistence (fixed — was previously an in-memory-only Map): a task can sit
 * in 'waiting_approval' for any length of time — it's persisted task state,
 * not a short-lived in-request thing — so a process restart must not lose
 * track of what it's actually waiting on. Every pending/approved/rejected
 * approval record is written to disk (or SQLite, matching every other
 * planner store's dataDir/sqliteStore pattern) so `GET/POST /api/approvals`
 * and `TaskPlanner.resumeAfterApproval` keep working across a restart,
 * exactly like tasks.json already does for the task itself (spec section 58,
 * "restart resumption must not silently strand persisted state").
 */
export class ApprovalSystem {
  /**
   * @param {object} opts
   * @param {import('../activity/ActivityLog.js').ActivityLog} opts.activityLog
   * @param {{autoApproveLow?:boolean, autoApproveExternalTools?:string[]}} [opts.userSettings]
   * @param {string} [opts.dataDir]
   * @param {import('../persistence/SqliteStore.js').SqliteStore|null} [opts.sqliteStore]
   */
  constructor({ activityLog, eventBus, userSettings = {}, autonomyManager, domainAutonomy, deviceManager, dataDir = './data', sqliteStore = null } = {}) {
    this.activityLog = activityLog;
    this.eventBus = eventBus;
    this.autonomyManager = autonomyManager ?? null;
    this.domainAutonomy = domainAutonomy ?? null;
    this.deviceManager = deviceManager ?? null;
    this.userSettings = {
      autoApproveLow: userSettings.autoApproveLow ?? true,
      autoApproveExternalTools: new Set(userSettings.autoApproveExternalTools ?? []),
    };
    this._store = new JsonStore({ dataDir, fileName: 'approvals.json', kvKey: 'approvals', defaultValue: { approvals: [] }, sqliteStore });
  }

  _load() {
    return this._store.load();
  }

  _save(data) {
    this._store.save(data);
  }

  /**
   * Pure decision: can this tool call run without a human? Creates and records NOTHING. This is the single place the
   * risk/autonomy rules live — evaluate() (TaskPlanner) and the engine Tool Gateway both use it.
   * @returns {'auto'|'requires_approval'}
   */
  decide({ tool, input }) {
    const level = tool.riskLevel;
    // Per-domain autonomy override (spec: "per-domain autonomy — files/browser/finance/…"):
    // if the tool's domain has an explicit level set, use it in place of the global level for
    // the autonomyManager checks below. No override anywhere here can move HIGH_IMPACT out of
    // the unconditional approval branch further down — that floor isn't reachable from this value.
    const domain = domainForTool(tool.name);
    const domainLevel = this.domainAutonomy && this.autonomyManager
      ? this.domainAutonomy.effectiveLevel(domain, this.autonomyManager.get().level)
      : undefined;

    if (level === RiskLevel.SAFE) return 'auto';

    if (level === RiskLevel.LOW) {
      if (this.userSettings.autoApproveLow) return 'auto';
      if (this.autonomyManager?.canAutoExecute({ riskLevel: level, level: domainLevel })) return 'auto';
    }

    if (level === RiskLevel.EXTERNAL) {
      if (this.userSettings.autoApproveExternalTools.has(tool.name)) return 'auto';
      const targetDeviceId = input?.deviceId ?? input?.targetDeviceId ?? input?.sourceDeviceId;
      const trusted = Boolean(targetDeviceId && (input?.deviceTrusted === true || this.deviceManager?.getDevice?.(targetDeviceId)?.trust === 'trusted'));
      if (this.autonomyManager?.canAutoExecute({ riskLevel: level, trusted, mission: Boolean(input?.missionId), level: domainLevel })) return 'auto';
    }

    // LOW (with autoApprove off), EXTERNAL (not allowlisted), and HIGH_IMPACT (always) all land here.
    return 'requires_approval';
  }

  /**
   * Decides whether a given tool call can proceed immediately or must wait
   * for approval. Does NOT execute anything — pure decision.
   * @returns {{decision:'auto'|'requires_approval', approvalId?:string}}
   */
  evaluate({ tool, input, taskId = null }) {
    const level = tool.riskLevel;
    if (this.decide({ tool, input }) === 'auto') return { decision: 'auto' };

    const approvalId = crypto.randomUUID();
    const record = {
      id: approvalId,
      toolName: tool.name,
      input,
      riskLevel: level,
      status: 'pending',
      createdAt: new Date().toISOString(),
      taskId,
    };
    const data = this._load();
    data.approvals.push(record);
    this._save(data);
    this.activityLog.log({
      type: 'approval_requested',
      taskId,
      toolName: tool.name,
      detail: { approvalId, riskLevel: level, input },
    });
    this.eventBus?.emitEvent(EventType.APPROVAL_REQUIRED, { approvalId, taskId, toolName: tool.name, riskLevel: level });
    return { decision: 'requires_approval', approvalId };
  }

  /** Creates an approval that must be explicitly accepted, regardless of autonomy settings. */
  requestApproval({ tool, input, taskId = null, reason = 'explicit_approval', metadata = {} } = {}) {
    const approvalId = crypto.randomUUID();
    const record = {
      id: approvalId, toolName: tool.name, input, riskLevel: tool.riskLevel, status: 'pending',
      createdAt: new Date().toISOString(), taskId, reason, metadata,
    };
    const data = this._load();
    data.approvals.push(record);
    this._save(data);
    this.activityLog.log({ type: 'approval_requested', taskId, toolName: tool.name, detail: { approvalId, riskLevel: tool.riskLevel, reason, metadata } });
    this.eventBus?.emitEvent(EventType.APPROVAL_REQUIRED, { approvalId, taskId, toolName: tool.name, riskLevel: tool.riskLevel, reason });
    return { decision: 'requires_approval', approvalId, reason };
  }

  _patch(approvalId, patch) {
    const data = this._load();
    const record = data.approvals.find((a) => a.id === approvalId);
    if (!record) throw new Error(`ApprovalSystem: no pending approval '${approvalId}'`);
    Object.assign(record, patch);
    this._save(data);
    return record;
  }

  approve(approvalId) {
    const record = this._patch(approvalId, { status: 'approved' });
    this.activityLog.log({ type: 'approval_granted', taskId: record.taskId, toolName: record.toolName, detail: { approvalId } });
    return record;
  }

  reject(approvalId) {
    const record = this._patch(approvalId, { status: 'rejected' });
    this.activityLog.log({ type: 'approval_denied', taskId: record.taskId, toolName: record.toolName, detail: { approvalId } });
    return record;
  }

  get(approvalId) {
    return this._load().approvals.find((a) => a.id === approvalId) ?? null;
  }

  listPending() {
    return this._load().approvals.filter((r) => r.status === 'pending');
  }
}
