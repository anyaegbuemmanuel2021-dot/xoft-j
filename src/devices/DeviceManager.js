import crypto from 'node:crypto';
import { EventType } from '../events/EventBus.js';

/** Risk model — spec section 16. Every device command carries one of these. */
export const DeviceRiskLevel = {
  LOW: 'low', // read state, open a permitted app
  MEDIUM: 'medium', // move files, change normal settings, media control
  HIGH: 'high', // delete files, send messages, change security-relevant settings
  CRITICAL: 'critical', // factory reset, disable security — blocked outright here
};

const CRITICAL_ACTIONS_BLOCKED = new Set([
  'factory_reset',
  'disable_security',
  'wipe_device',
  'disable_lock_screen',
]);

const DEFAULT_ONLINE_THRESHOLD_MS = 90_000; // no heartbeat/state update in 90s => offline
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000; // how long we wait for an agent to report a result

/**
 * DeviceManager — spec sections 3/10/13/16/18/28/29. This is the Device
 * Operating Layer's coordination point. It does NOT execute anything on a
 * device itself (this backend has no OS-level access — see
 * docs/MOBILE_COMPANION_CONTRACT.md); it queues commands for a real
 * connected agent to pull, and genuinely waits for that agent to report a
 * result before telling the caller anything succeeded (spec section 18 —
 * no `return { success: true }` without a real agent behind it).
 *
 * Built ON TOP OF the existing DeviceRegistry (identity/trust/capabilities/
 * state persistence) rather than replacing it — this class owns the parts
 * DeviceRegistry deliberately doesn't: online/offline derivation, the
 * command queue, idempotency, and command-lifecycle events.
 */
export class DeviceManager {
  /**
   * @param {object} deps
   * @param {import('./DeviceRegistry.js').DeviceRegistry} deps.deviceRegistry
   * @param {import('../events/EventBus.js').EventBus} [deps.eventBus]
   * @param {import('../activity/ActivityLog.js').ActivityLog} deps.activityLog
   * @param {number} [deps.onlineThresholdMs]
   * @param {number} [deps.defaultCommandTimeoutMs]
   */
  constructor({ deviceRegistry, eventBus, activityLog, onlineThresholdMs = DEFAULT_ONLINE_THRESHOLD_MS, defaultCommandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, commandStore = null }) {
    this.deviceRegistry = deviceRegistry;
    this.eventBus = eventBus;
    this.activityLog = activityLog;
    this.onlineThresholdMs = onlineThresholdMs;
    this.defaultCommandTimeoutMs = defaultCommandTimeoutMs;
    this.commandStore = commandStore;

    /** @type {Map<string, object[]>} deviceId -> pending command queue (FIFO, oldest first) */
    this._queues = new Map();
    /** @type {Map<string, object>} commandId -> command record (across all devices, for lookup/idempotency) */
    this._commands = new Map();
    /** @type {Map<string, Array<{resolve:Function, reject:Function, timer:NodeJS.Timeout}>>} commandId -> pending waiters (plural — an idempotent retry fans out to the same command) */
    this._waiters = new Map();
    if (this.commandStore) {
      for (const c of this.commandStore.loadCommands()) {
        this._commands.set(c.id, c);
        if (['pending','dispatched'].includes(c.status)) {
          if (!this._queues.has(c.deviceId)) this._queues.set(c.deviceId, []);
          this._queues.get(c.deviceId).push(c);
        }
      }
    }
  }

  // --- Identity / discovery / trust (delegates to DeviceRegistry) ---

  registerDevice(name, platform = 'web') {
    return this.deviceRegistry.register(name, platform);
  }

  getDevice(deviceId) {
    return this.deviceRegistry.get(deviceId);
  }

  listDevices() {
    return this.deviceRegistry.list().map((d) => ({ ...d, online: this.isOnline(d.id) }));
  }

  /** Discovery != trust (spec section 5) — this is the explicit step a human takes. */
  trustDevice(deviceId) {
    const device = this.deviceRegistry.setTrust(deviceId, 'trusted');
    this.eventBus?.emitEvent(EventType.DEVICE_TRUSTED, { deviceId });
    return device;
  }

  revokeDevice(deviceId) {
    return this.deviceRegistry.revoke(deviceId);
  }

  /**
   * Automatic protective response to a detected threat pattern (see
   * DeviceThreatMonitor) — distinct from a human calling revokeDevice().
   * Drops trust back to 'unverified' rather than fully revoking: the
   * device stops receiving commands immediately (DeviceManager.execute()
   * re-checks trust on every call), but a human can review and re-trust it
   * rather than needing to re-pair it from scratch if it turns out to be a
   * false positive.
   */
  quarantineDevice(deviceId, reason) {
    const device = this.deviceRegistry.setTrust(deviceId, 'unverified');
    this.activityLog.log({ type: 'device_quarantined', detail: { deviceId, reason } });
    this.eventBus?.emitEvent(EventType.DEVICE_SECURITY_ALERT, { deviceId, reason, action: 'quarantined' });
    return device;
  }

  heartbeat(deviceId) {
    const wasOffline = !this.isOnline(deviceId, { silent: true });
    const device = this.deviceRegistry.heartbeat(deviceId);
    if (wasOffline) this.eventBus?.emitEvent(EventType.DEVICE_ONLINE, { deviceId });
    return device;
  }

  isOnline(deviceId, { silent = false } = {}) {
    let device;
    try {
      device = this.deviceRegistry.get(deviceId);
    } catch {
      return false;
    }
    if (device.status === 'revoked') return false;
    const age = Date.now() - new Date(device.lastActiveAt).getTime();
    const online = age <= this.onlineThresholdMs;
    if (!online && !silent) this.eventBus?.emitEvent(EventType.DEVICE_OFFLINE, { deviceId });
    return online;
  }

  // --- Capabilities / state ---

  setCapabilities(deviceId, capabilities) {
    const device = this.deviceRegistry.setCapabilities(deviceId, capabilities);
    this.eventBus?.emitEvent(EventType.DEVICE_CAPABILITIES_UPDATED, { deviceId, capabilities: device.capabilities });
    return device;
  }

  hasCapability(deviceId, capability) {
    const device = this.deviceRegistry.get(deviceId);
    return device.capabilities.includes(capability);
  }

  /** Agent-reported state (battery, network, active app, ...). Emits battery-low as a real signal, not synthetic. */
  updateState(deviceId, partialState) {
    const device = this.deviceRegistry.updateState(deviceId, partialState);
    this.eventBus?.emitEvent(EventType.DEVICE_STATE_UPDATED, { deviceId, state: device.state });
    if (typeof partialState.battery === 'number' && partialState.battery <= 15 && partialState.charging !== true) {
      this.eventBus?.emitEvent(EventType.DEVICE_BATTERY_LOW, { deviceId, battery: partialState.battery });
    }
    return device;
  }

  // --- Command lifecycle (spec section 10) ---
  // REQUEST -> TARGET DEVICE -> CHECK CAPABILITY -> QUEUE -> (agent) EXECUTE ->
  // (agent) RESULT -> VERIFY -> AUDIT -> RESPOND. Permission/risk/approval
  // checks happen one layer up, in ToolRegistry/ApprovalSystem, before this
  // is ever called — this class does NOT re-implement that gate; it assumes
  // the caller already passed it, and only enforces device-level facts
  // (online, capable, not a blocked critical action).

  /**
   * Enqueues a command for a device agent to pick up, and returns a promise
   * that resolves with the agent's reported result (or rejects on timeout /
   * offline / missing capability). Never resolves early with a fabricated
   * success.
   *
   * @param {object} req
   * @param {string} req.deviceId
   * @param {string} req.capability e.g. 'applications', 'files', 'browser', 'system', 'media'
   * @param {string} req.action e.g. 'open', 'close', 'list', 'transfer'
   * @param {object} [req.parameters]
   * @param {string} [req.riskLevel] one of DeviceRiskLevel
   * @param {string} [req.requestedBy]
   * @param {string} [req.idempotencyKey] if provided and a command with the same key is
   *   still pending/dispatched, the existing command's promise is returned instead of
   *   queuing a duplicate (spec section 29 — retries must not double-execute).
   * @param {number} [req.timeoutMs]
   */
  async execute({ deviceId, capability, action, parameters = {}, riskLevel = DeviceRiskLevel.LOW, requestedBy = 'user', idempotencyKey = null, timeoutMs }) {
    if (CRITICAL_ACTIONS_BLOCKED.has(action)) {
      throw new Error(`DeviceManager: action '${action}' is CRITICAL-risk and is blocked outright — no override exists.`);
    }

    const device = this.deviceRegistry.get(deviceId); // throws if unknown
    if (device.status === 'revoked') {
      throw new Error(`DeviceManager: device '${deviceId}' has been revoked.`);
    }
    if (device.trust !== 'trusted') {
      throw new Error(`DeviceManager: device '${deviceId}' is not trusted yet — pair and trust it before sending commands.`);
    }
    if (!this.isOnline(deviceId)) {
      throw new Error(`DeviceManager: device '${deviceId}' (${device.name}) is offline — cannot execute '${action}'.`);
    }
    if (!this.hasCapability(deviceId, capability)) {
      throw new Error(`DeviceManager: device '${deviceId}' (${device.name}) has not reported capability '${capability}'.`);
    }

    if (idempotencyKey) {
      const existing = [...this._commands.values()].find(
        (c) => c.idempotencyKey === idempotencyKey && ['pending', 'dispatched'].includes(c.status)
      );
      if (existing) return this._waitFor(existing.id, timeoutMs);
    }

    const command = {
      id: crypto.randomUUID(),
      deviceId,
      capability,
      action,
      parameters,
      riskLevel,
      requestedBy,
      idempotencyKey,
      status: 'pending', // pending -> dispatched -> completed | failed | timed_out
      createdAt: new Date().toISOString(),
      dispatchedAt: null,
      completedAt: null,
      result: null,
    };
    this._commands.set(command.id, command);
    this.commandStore?.saveCommand(command);
    if (!this._queues.has(deviceId)) this._queues.set(deviceId, []);
    this._queues.get(deviceId).push(command);

    this.activityLog.log({
      type: 'device_command_queued',
      detail: { commandId: command.id, deviceId, capability, action, riskLevel, requestedBy },
    });
    this.eventBus?.emitEvent(EventType.DEVICE_COMMAND_QUEUED, { commandId: command.id, deviceId, capability, action, riskLevel });

    return this._waitFor(command.id, timeoutMs);
  }

  _waitFor(commandId, timeoutMs) {
    const existingResult = this._commands.get(commandId)?.result;
    if (existingResult) return Promise.resolve(existingResult);

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const list = this._waiters.get(commandId);
        if (list) {
          const idx = list.indexOf(waiter);
          if (idx !== -1) list.splice(idx, 1);
          if (list.length === 0) this._waiters.delete(commandId);
        }
        const command = this._commands.get(commandId);
        if (command && command.status !== 'completed' && command.status !== 'failed') {
          command.status = 'timed_out';
          this.commandStore?.saveCommand(command);
          this.activityLog.log({ type: 'device_command_timed_out', detail: { commandId, deviceId: command.deviceId } });
          this.eventBus?.emitEvent(EventType.DEVICE_COMMAND_FAILED, { commandId, deviceId: command.deviceId, reason: 'timeout' });
        }
        reject(new Error(`DeviceManager: command '${commandId}' timed out waiting for the device agent to report a result. The action was NOT confirmed to have happened.`));
      }, timeoutMs ?? this.defaultCommandTimeoutMs);

      if (!this._waiters.has(commandId)) this._waiters.set(commandId, []);
      this._waiters.get(commandId).push(waiter);
    });
  }

  /** Called by a device agent (via API) pulling its queue. Marks returned commands 'dispatched'. */
  pullPending(deviceId) {
    const queue = this._queues.get(deviceId) ?? [];
    const pending = queue.filter((c) => c.status === 'pending');
    const now = new Date().toISOString();
    for (const c of pending) {
      c.status = 'dispatched';
      c.dispatchedAt = now;
      this.commandStore?.saveCommand(c);
    }
    if (pending.length) {
      this.eventBus?.emitEvent(EventType.DEVICE_COMMAND_STARTED, { deviceId, commandIds: pending.map((c) => c.id) });
    }
    return pending.map((c) => ({ id: c.id, capability: c.capability, action: c.action, parameters: c.parameters }));
  }

  /**
   * Called by a device agent (via API) reporting the outcome of a command it
   * executed. This is the ONLY thing that resolves a caller's execute()
   * promise — nothing here is assumed to have succeeded before this arrives.
   *
   * @param {string} deviceId
   * @param {string} commandId
   * @param {{success:boolean, data?:object, error?:string, verification?:{verified:boolean, evidence?:object}}} result
   */
  submitResult(deviceId, commandId, result) {
    const command = this._commands.get(commandId);
    if (!command) throw new Error(`DeviceManager: no command '${commandId}'`);
    if (command.deviceId !== deviceId) throw new Error(`DeviceManager: command '${commandId}' does not belong to device '${deviceId}'`);
    if (command.status === 'completed' || command.status === 'failed') {
      // Idempotent no-op — a retried result post shouldn't resolve twice or throw.
      return command;
    }

    const verified = result?.verification?.verified ?? Boolean(result?.success);
    const structuredResult = {
      success: Boolean(result?.success),
      commandId,
      deviceId,
      result: result?.data ?? {},
      verification: { verified, evidence: result?.verification?.evidence ?? {} },
      error: result?.error ?? null,
    };

    command.status = structuredResult.success ? 'completed' : 'failed';
    command.completedAt = new Date().toISOString();
    command.result = structuredResult;
    this.commandStore?.saveCommand(command);

    this.activityLog.log({
      type: 'device_command_result',
      detail: { commandId, deviceId, success: structuredResult.success, verified, error: structuredResult.error },
    });
    this.eventBus?.emitEvent(
      structuredResult.success ? EventType.DEVICE_COMMAND_COMPLETED : EventType.DEVICE_COMMAND_FAILED,
      { commandId, deviceId, success: structuredResult.success }
    );

    const waiters = this._waiters.get(commandId);
    if (waiters) {
      this._waiters.delete(commandId);
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve(structuredResult);
      }
    }
    return command;
  }

  getCommand(commandId) {
    return this._commands.get(commandId) ?? null;
  }

  listCommands(deviceId) {
    return [...this._commands.values()].filter((c) => c.deviceId === deviceId);
  }
}
