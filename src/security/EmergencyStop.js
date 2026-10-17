/**
 * EmergencyStop — spec section 23. When active:
 *   - blocks all further tool execution (ToolRegistry.execute checks this)
 *   - cancels pending approvals are left for the caller to handle explicitly
 *   - the chat/status API stays reachable so the user can see state and recover
 *
 * This is intentionally a single in-process flag, not per-user — an
 * emergency stop should be unambiguous and total for this server instance.
 */
import { EventType } from '../events/EventBus.js';

export class EmergencyStop {
  constructor({ activityLog, eventBus }) {
    this.activityLog = activityLog;
    this.eventBus = eventBus;
    this._active = false;
    this._activatedAt = null;
    this._reason = null;
  }

  activate(reason = 'user requested') {
    this._active = true;
    this._activatedAt = new Date().toISOString();
    this._reason = reason;
    this.activityLog.log({ type: 'emergency_stop_activated', detail: { reason } });
    this.eventBus?.emitEvent(EventType.EMERGENCY_STOP_ACTIVATED, { reason });
  }

  deactivate() {
    this._active = false;
    this.activityLog.log({ type: 'emergency_stop_deactivated', detail: { previousReason: this._reason } });
    this._reason = null;
  }

  isActive() {
    return this._active;
  }

  status() {
    return { active: this._active, activatedAt: this._activatedAt, reason: this._reason };
  }

  /** Throws if active — call at the top of any execution path that should be stoppable. */
  assertNotStopped() {
    if (this._active) {
      throw new Error(`EmergencyStop is active (reason: ${this._reason}) — no tool execution is permitted until deactivated.`);
    }
  }
}
