import { EventEmitter } from 'node:events';

/** Event names from spec section 13/4. Extend as new producers/consumers need them. */
export const EventType = {
  TASK_COMPLETED: 'task_completed',
  TASK_FAILED: 'task_failed',
  APPROVAL_REQUIRED: 'approval_required',
  AUTOMATION_TRIGGERED: 'automation_triggered',
  DEVICE_CONNECTED: 'device_connected',
  DEVICE_REVOKED: 'device_revoked',
  GOAL_CREATED: 'goal_created',
  MONITOR_TRIGGERED: 'monitor_triggered',
  EMERGENCY_STOP_ACTIVATED: 'emergency_stop_activated',

  // Device Operating Layer (spec section 13) — real producers: DeviceManager.
  DEVICE_TRUSTED: 'device.trusted',
  DEVICE_ONLINE: 'device.online',
  DEVICE_OFFLINE: 'device.offline',
  DEVICE_STATE_UPDATED: 'device.state.updated',
  DEVICE_BATTERY_LOW: 'device.battery.low',
  DEVICE_CAPABILITIES_UPDATED: 'device.capabilities.updated',
  DEVICE_COMMAND_QUEUED: 'device.command.queued',
  DEVICE_COMMAND_STARTED: 'device.command.started',
  DEVICE_COMMAND_COMPLETED: 'device.command.completed',
  DEVICE_COMMAND_FAILED: 'device.command.failed',
  DEVICE_SECURITY_ALERT: 'device.security.alert',

  // Task lifecycle (spec: task engine upgrade / event bus). Additive —
  // existing TASK_COMPLETED/TASK_FAILED above are unchanged and still fire.
  TASK_CREATED: 'task.created',
  TASK_QUEUED: 'task.queued',
  TASK_STARTED: 'task.started',
  TASK_VERIFYING: 'task.verifying',
  TASK_RETRYING: 'task.retrying',
  TASK_RECOVERING: 'task.recovering',
  TASK_CANCELLED: 'task.cancelled',
  EXECUTION_DUPLICATE_PREVENTED: 'execution.duplicate_prevented',
  EXECUTION_AMBIGUOUS: 'execution.ambiguous',
};

/**
 * EventBus — thin wrapper over Node's EventEmitter. Every emitted event is
 * also written to ActivityLog (so it shows up in the existing audit trail)
 * and kept in a short in-memory ring buffer for `GET /api/events` — nothing
 * new to persist, nothing to lose track of.
 *
 * Producers call emitEvent(); consumers use the normal EventEmitter .on().
 * Injection is optional everywhere it's used — existing callers that don't
 * pass an eventBus keep working exactly as before.
 */
export class EventBus extends EventEmitter {
  constructor({ activityLog } = {}) {
    super();
    this.activityLog = activityLog;
    this._recent = [];
  }

  emitEvent(type, payload = {}) {
    const event = { type, payload, ts: new Date().toISOString() };
    this._recent.push(event);
    if (this._recent.length > 200) this._recent.shift();
    this.activityLog?.log({ type: `event_${type}`, detail: payload });
    this.emit(type, payload);
    this.emit('*', event);
    return event;
  }

  recent(limit = 50) {
    return this._recent.slice(-limit);
  }
}
