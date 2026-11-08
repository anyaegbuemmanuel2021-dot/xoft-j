/**
 * Shared vocabulary for the Xoft engine layer.
 *
 * Engines are pluggable execution back-ends (Xoft Core, Hermes, future ones). Everything in this
 * file is engine-agnostic — nothing here knows about Hermes.
 */

/** Runtime status of one engine, as shown in the UI. */
export const EngineStatus = Object.freeze({
  DISABLED: 'disabled', // switched off in settings
  OFFLINE: 'offline', // enabled but not reachable / not installed
  STARTING: 'starting',
  ONLINE: 'online',
  BUSY: 'busy', // online and running at least one task
  ERROR: 'error', // enabled, reachable or crashed, but unhealthy
});

/** Availability level used by the router: a partly working engine is not the same as a broken one. */
export const Availability = Object.freeze({
  READY: 'ready',
  PARTIAL: 'partial', // some dependencies missing; may still serve tasks that don't need them
  OFFLINE: 'offline',
  DISABLED: 'disabled',
  ERROR: 'error',
});

/** Lifecycle of one engine task (spec section 9). */
export const TaskState = Object.freeze({
  QUEUED: 'queued',
  INITIALIZING: 'initializing',
  RUNNING: 'running',
  WAITING: 'waiting', // waiting for a human approval
  PAUSED: 'paused', // held: engine failure, restart recovery, or an explicit pause
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export const TERMINAL_STATES = Object.freeze(new Set([TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELLED]));
export const ACTIVE_STATES = Object.freeze(new Set([TaskState.INITIALIZING, TaskState.RUNNING, TaskState.WAITING]));

/** What an engine can do. The router matches task requirements against these (spec section 19). */
export const Capability = Object.freeze({
  CHAT: 'chat',
  PLANNING: 'planning',
  AUTONOMOUS_TASKS: 'autonomous_tasks',
  MULTI_STEP: 'multi_step_execution',
  LONG_RUNNING: 'long_running',
  CODING: 'coding',
  TERMINAL: 'terminal',
  FILESYSTEM: 'filesystem',
  BROWSER: 'browser',
  PC_CONTROL: 'pc_control',
  WEB_SEARCH: 'web_search',
  MEMORY: 'memory',
  GIT: 'git',
  STREAMING: 'streaming',
  CANCEL: 'cancel',
  PAUSE: 'pause',
  RESUME: 'resume',
  APPROVALS: 'approvals',
  TOOL_BRIDGE: 'tool_bridge', // can consume Xoft's tool registry through the Tool Gateway
});

/**
 * Event names published on Xoft's EventBus (spec section 29). All are prefixed `engine.` so they never collide
 * with the existing TaskPlanner events (`task.*`) and the UI can subscribe to the whole family by prefix.
 */
export const EngineEvent = Object.freeze({
  ENGINE_STARTED: 'engine.started',
  ENGINE_READY: 'engine.ready',
  ENGINE_OFFLINE: 'engine.offline',
  ENGINE_ERROR: 'engine.error',
  ENGINE_STATUS: 'engine.status',
  ENGINE_FALLBACK: 'engine.fallback',

  TASK_CREATED: 'engine.task.created',
  TASK_STARTED: 'engine.task.started',
  TASK_PROGRESS: 'engine.task.progress',
  TASK_WAITING: 'engine.task.waiting',
  TASK_PAUSED: 'engine.task.paused',
  TASK_RESUMED: 'engine.task.resumed',
  TASK_COMPLETED: 'engine.task.completed',
  TASK_FAILED: 'engine.task.failed',
  TASK_CANCELLED: 'engine.task.cancelled',
  TASK_STATE: 'engine.task.state',
  TASK_CHECKPOINT: 'engine.task.checkpoint',
  TASK_RECOVERY: 'engine.task.recovery',

  TOOL_STARTED: 'engine.tool.started',
  TOOL_COMPLETED: 'engine.tool.completed',
  TOOL_FAILED: 'engine.tool.failed',
  COMMAND_EXECUTED: 'engine.command.executed',

  FILE_CREATED: 'engine.file.created',
  FILE_MODIFIED: 'engine.file.modified',
  FILE_DELETED: 'engine.file.deleted',

  APPROVAL_REQUESTED: 'engine.approval.requested',
  APPROVAL_RESOLVED: 'engine.approval.resolved',
  POLICY_VIOLATION: 'engine.policy.violation',
  MESSAGE: 'engine.message', // assistant text / reasoning summary from the engine
});

/** Error codes thrown by engine code. `retryable` lets callers decide between retrying and failing over. */
export class EngineError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{retryable?:boolean, status?:number, cause?:Error, details?:object}} [opts]
   */
  constructor(code, message, { retryable = false, status = null, cause = null, details = null } = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

export const ErrorCode = Object.freeze({
  UNAVAILABLE: 'ENGINE_UNAVAILABLE',
  DISABLED: 'ENGINE_DISABLED',
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  POLICY_DENIED: 'POLICY_DENIED',
  TIMEOUT: 'TIMEOUT',
  PROTOCOL: 'PROTOCOL_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_FOUND: 'NOT_FOUND',
  INVALID: 'INVALID_REQUEST',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  INTERRUPTED: 'INTERRUPTED',
});

/** Autonomy uses Xoft's existing 0-5 scale (AutonomyManager) — the engine layer does not invent a second one. */
export const ENGINE_AUTONOMY_LABELS = Object.freeze({
  0: 'MANUAL — observe only (read-only permissions)',
  1: 'SUGGEST — propose, do not change anything (read-only permissions)',
  2: 'APPROVAL — every side-effecting action needs approval',
  3: 'LOW_RISK_AUTONOMY — low-risk actions run, external/high-impact need approval',
  4: 'TRUSTED_AUTONOMY — trusted actions run inside the permission profile',
  5: 'MISSION_AUTONOMY — full task execution inside the permission profile',
});
