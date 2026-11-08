import { EventType } from '../events/EventBus.js';

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_THRESHOLDS = {
  commandsPerWindow: 40, // a burst this size in a minute reads as a runaway loop or a flood, not a person clicking buttons
  failuresPerWindow: 8, // repeated failures reads as probing (trying actions/paths that don't exist) or a broken/compromised agent
  elevatedRiskPerWindow: 12, // medium/high risk actions specifically — normal usage rarely queues this many in a minute
};

/**
 * DeviceThreatMonitor — the runtime half of device security; SecurityAgent
 * (src/security/SecurityAgent.js) covers static analysis of XOFT's own
 * source and dependencies, this watches LIVE device-command activity as it
 * happens and reacts automatically, not just after-the-fact in a log.
 *
 * Listens to the same DeviceManager events everything else does
 * (DEVICE_COMMAND_QUEUED / _FAILED / _COMPLETED) — no new instrumentation
 * added to DeviceManager itself, this is a pure observer. On a threshold
 * breach it calls deviceManager.quarantineDevice(), which immediately stops
 * that device from receiving further commands (DeviceManager.execute()
 * re-checks trust on every call) until a human reviews and re-trusts it.
 *
 * Deliberately per-device, sliding-window, in-memory — this is meant to
 * catch abuse DURING a session, not to be a long-term audit store (that's
 * ActivityLog's job, which every alert here still writes to).
 */
export class DeviceThreatMonitor {
  constructor({ eventBus, deviceManager, activityLog, windowMs = DEFAULT_WINDOW_MS, thresholds = {} }) {
    this.eventBus = eventBus;
    this.deviceManager = deviceManager;
    this.activityLog = activityLog;
    this.windowMs = windowMs;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };

    /** @type {Map<string, {commands:number[], failures:number[], elevatedRisk:number[]}>} */
    this._activity = new Map();

    this._onQueued = (payload) => this._recordAndCheck(payload.deviceId, 'commands', payload.riskLevel);
    this._onFailed = (payload) => this._recordAndCheck(payload.deviceId, 'failures');

    this.eventBus.on(EventType.DEVICE_COMMAND_QUEUED, this._onQueued);
    this.eventBus.on(EventType.DEVICE_COMMAND_FAILED, this._onFailed);
  }

  /** Call when tearing down (e.g. in tests) so listeners don't leak across instances. */
  stop() {
    this.eventBus.off(EventType.DEVICE_COMMAND_QUEUED, this._onQueued);
    this.eventBus.off(EventType.DEVICE_COMMAND_FAILED, this._onFailed);
  }

  _bucketFor(deviceId) {
    if (!this._activity.has(deviceId)) this._activity.set(deviceId, { commands: [], failures: [], elevatedRisk: [] });
    return this._activity.get(deviceId);
  }

  _prune(list, now) {
    while (list.length && now - list[0] > this.windowMs) list.shift();
  }

  _recordAndCheck(deviceId, kind, riskLevel) {
    if (!deviceId) return;
    const now = Date.now();
    const bucket = this._bucketFor(deviceId);

    bucket[kind].push(now);
    this._prune(bucket[kind], now);

    if (kind === 'commands' && (riskLevel === 'medium' || riskLevel === 'high')) {
      bucket.elevatedRisk.push(now);
      this._prune(bucket.elevatedRisk, now);
    }

    this._evaluate(deviceId, bucket);
  }

  _evaluate(deviceId, bucket) {
    const reasons = [];
    if (bucket.commands.length > this.thresholds.commandsPerWindow) {
      reasons.push(`${bucket.commands.length} commands queued in the last ${Math.round(this.windowMs / 1000)}s (threshold ${this.thresholds.commandsPerWindow})`);
    }
    if (bucket.failures.length > this.thresholds.failuresPerWindow) {
      reasons.push(`${bucket.failures.length} failed commands in the last ${Math.round(this.windowMs / 1000)}s (threshold ${this.thresholds.failuresPerWindow}) — looks like probing or a broken agent`);
    }
    if (bucket.elevatedRisk.length > this.thresholds.elevatedRiskPerWindow) {
      reasons.push(`${bucket.elevatedRisk.length} medium/high-risk commands in the last ${Math.round(this.windowMs / 1000)}s (threshold ${this.thresholds.elevatedRiskPerWindow})`);
    }
    if (!reasons.length) return;

    let device;
    try {
      device = this.deviceManager.getDevice(deviceId);
    } catch {
      return; // device gone (revoked mid-window) — nothing to quarantine
    }
    if (device.trust !== 'trusted') return; // already not receiving commands — avoid alert spam on every subsequent event

    const reason = reasons.join('; ');
    this.deviceManager.quarantineDevice(deviceId, reason);
    // Reset counters post-quarantine so a re-trusted device gets a clean window rather than an immediate re-trip.
    this._activity.set(deviceId, { commands: [], failures: [], elevatedRisk: [] });
  }

  /** For dashboards/tests — current window's raw counts, not just the pass/fail verdict. */
  getActivitySummary(deviceId) {
    const bucket = this._activity.get(deviceId) ?? { commands: [], failures: [], elevatedRisk: [] };
    const now = Date.now();
    return {
      windowMs: this.windowMs,
      commandsInWindow: bucket.commands.filter((t) => now - t <= this.windowMs).length,
      failuresInWindow: bucket.failures.filter((t) => now - t <= this.windowMs).length,
      elevatedRiskInWindow: bucket.elevatedRisk.filter((t) => now - t <= this.windowMs).length,
    };
  }
}
