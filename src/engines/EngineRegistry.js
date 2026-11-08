import { Availability, EngineEvent, EngineStatus, ErrorCode, EngineError } from './constants.js';

const withTimeout = (promise, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new EngineError(ErrorCode.TIMEOUT, `${label} timed out after ${ms}ms`, { retryable: true })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * EngineRegistry — the single place engines are registered and their health is tracked (spec sections 3, 5, 18, 19).
 *
 * An engine that is offline, misconfigured or crashing never takes anything else down: health checks are isolated,
 * time-boxed, and their failures are converted into an OFFLINE/ERROR health record instead of an exception.
 */
export class EngineRegistry {
  constructor({ eventBus = null, activityLog = null, healthTimeoutMs = 6000 } = {}) {
    this.eventBus = eventBus;
    this.activityLog = activityLog;
    this.healthTimeoutMs = healthTimeoutMs;
    /** @type {Map<string, {engine:import('./Engine.js').Engine, priority:number, health:object|null, unsubscribe:Function}>} */
    this._engines = new Map();
    this._monitor = null;
  }

  register(engine, { priority = 50 } = {}) {
    if (this._engines.has(engine.id)) throw new Error(`EngineRegistry: an engine with id '${engine.id}' is already registered`);
    const unsubscribe = engine.onStatusChange((change) => {
      this.eventBus?.emitEvent(EngineEvent.ENGINE_STATUS, change);
    });
    this._engines.set(engine.id, { engine, priority, health: null, unsubscribe });
    this.activityLog?.log({ type: 'engine_registered', detail: { engineId: engine.id, capabilities: engine.capabilities, priority } });
    return engine;
  }

  unregister(id) {
    const entry = this._engines.get(id);
    if (!entry) return false;
    entry.unsubscribe?.();
    this._engines.delete(id);
    return true;
  }

  has(id) { return this._engines.has(id); }

  get(id) {
    const entry = this._engines.get(id);
    if (!entry) throw new EngineError(ErrorCode.NOT_FOUND, `No engine registered with id '${id}'`);
    return entry.engine;
  }

  priority(id) { return this._engines.get(id)?.priority ?? 0; }
  engines() { return [...this._engines.values()].map((e) => e.engine); }

  /** Last known health for an engine (null until the first refresh). */
  health(id) { return this._engines.get(id)?.health ?? null; }

  /** Description + last known health for every engine — what the UI and `xoft engines` show. */
  list() {
    return [...this._engines.values()].map(({ engine, health, priority }) => ({ ...engine.describe(), priority, health }));
  }

  /** Runs one engine's health check in isolation; never throws. Emits events on availability changes. */
  async refresh(id) {
    const entry = this._engines.get(id);
    if (!entry) throw new EngineError(ErrorCode.NOT_FOUND, `No engine registered with id '${id}'`);
    let health;
    try {
      health = await withTimeout(entry.engine.healthCheck(), this.healthTimeoutMs, `${id} health check`);
    } catch (err) {
      health = {
        available: false, level: Availability.ERROR, status: EngineStatus.ERROR, reason: `health check failed: ${err.message}`,
        dependencies: {}, capabilities: entry.engine.capabilities, checkedAt: new Date().toISOString(),
      };
    }
    const previous = entry.health;
    entry.health = health;
    if (!previous || previous.level !== health.level) this._announce(entry.engine, previous, health);
    return health;
  }

  async refreshAll() {
    await Promise.all([...this._engines.keys()].map((id) => this.refresh(id)));
    return this.list();
  }

  _announce(engine, previous, health) {
    const payload = { engineId: engine.id, level: health.level, reason: health.reason ?? null, previous: previous?.level ?? null };
    if (health.level === Availability.READY || health.level === Availability.PARTIAL) this.eventBus?.emitEvent(EngineEvent.ENGINE_READY, payload);
    else if (health.level === Availability.ERROR) this.eventBus?.emitEvent(EngineEvent.ENGINE_ERROR, payload);
    else this.eventBus?.emitEvent(EngineEvent.ENGINE_OFFLINE, payload);
  }

  startMonitor(intervalMs = 30000) {
    if (this._monitor) return;
    this._monitor = setInterval(() => { this.refreshAll().catch(() => { /* refresh() never throws; belt and braces */ }); }, intervalMs);
    this._monitor.unref?.();
  }

  stopMonitor() {
    if (this._monitor) clearInterval(this._monitor);
    this._monitor = null;
  }

  async shutdown() {
    this.stopMonitor();
    await Promise.allSettled(this.engines().map((e) => e.shutdown()));
  }
}
