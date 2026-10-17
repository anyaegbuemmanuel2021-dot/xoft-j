/**
 * Watchdog + self-diagnostics. diagnose() is read-only and returns real check
 * results (HEALTHY | DEGRADED | WARNING | CRITICAL); tick() additionally PAUSES
 * autonomous missions when a CRITICAL condition makes continued autonomous work
 * unsafe (resource exhaustion, or every configured AI provider down). It never
 * cancels work, never touches the emergency stop, and resume stays a human decision.
 */
const ORDER = ['HEALTHY', 'DEGRADED', 'WARNING', 'CRITICAL'];
const worst = (a, b) => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);
const byPct = (pct, warn, crit) => (pct === null || pct === undefined ? 'DEGRADED' : pct >= crit ? 'CRITICAL' : pct >= warn ? 'WARNING' : 'HEALTHY');

export class Watchdog {
  constructor({ telemetry, providerOverview, missionManager, emergencyStop, realtime, taskQueueStatus, runtimeHealth, engineStatus, activityLog, eventBus, thresholds = {} } = {}) {
    this.t = telemetry; this.providerOverview = providerOverview; this.missions = missionManager;
    this.emergencyStop = emergencyStop; this.realtime = realtime; this.engineStatus = engineStatus; this.taskQueueStatus = taskQueueStatus; this.runtimeHealth = runtimeHealth;
    this.activityLog = activityLog; this.eventBus = eventBus;
    this.th = { memWarn: 90, memCrit: 97, diskWarn: 90, diskCrit: 98, cpuWarn: 90, ...thresholds };
    this._timer = null;
  }

  async diagnose() {
    const checks = [];
    const add = (name, level, detail) => checks.push({ name, level, detail });
    try {
      const s = this.t.snapshot();
      add('memory', byPct(s.memory?.usedPercent, this.th.memWarn, this.th.memCrit), `${s.memory?.usedPercent ?? '?'}% used`);
      add('disk', s.storage ? byPct(s.storage.usedPercent, this.th.diskWarn, this.th.diskCrit) : 'DEGRADED', s.storage ? `${s.storage.usedPercent}% used` : 'disk usage not readable on this platform');
      add('cpu', s.cpu?.percent === null || s.cpu?.percent === undefined ? 'DEGRADED' : s.cpu.percent >= this.th.cpuWarn ? 'WARNING' : 'HEALTHY', s.cpu?.percent === null || s.cpu?.percent === undefined ? 'no sample yet' : `${s.cpu.percent}%`);
    } catch (err) { add('system', 'WARNING', `telemetry failed: ${err.message}`); }

    try {
      const provs = (await this.providerOverview()).filter((p) => p.configured);
      const bad = provs.filter((p) => ['UNAVAILABLE', 'AUTH_ERROR'].includes(p.status));
      const soft = provs.filter((p) => ['DEGRADED', 'RATE_LIMITED', 'TIMEOUT'].includes(p.status));
      if (!provs.length) add('providers', 'WARNING', 'no AI provider configured');
      else if (bad.length === provs.length) add('providers', 'CRITICAL', `all ${provs.length} configured provider(s) unavailable`);
      else if (bad.length || soft.length) add('providers', 'DEGRADED', `${bad.length} down, ${soft.length} degraded of ${provs.length}`);
      else add('providers', 'HEALTHY', `${provs.length} configured, none reporting failures`);
    } catch (err) { add('providers', 'WARNING', `provider check failed: ${err.message}`); }

    const rt = this.realtime?.();
    add('websocket', rt?.available ? 'HEALTHY' : 'DEGRADED', rt?.available ? `${rt.clients} client(s)` : 'realtime bridge not running (REST still works)');

    try {
      const ms = this.missions.list();
      const paused = ms.filter((m) => m.status === 'paused');
      const stuck = ms.filter((m) => !['cancelled', 'paused', 'completed'].includes(m.status) && this.missions.isStuck(m));
      add('missions', stuck.length ? 'WARNING' : paused.length ? 'DEGRADED' : 'HEALTHY', `${ms.length} total, ${paused.length} paused, ${stuck.length} stuck`);
    } catch (err) { add('missions', 'WARNING', err.message); }

    try {
      const q = this.taskQueueStatus?.();
      if (q) add('task_queue', 'HEALTHY', `${q.running?.length ?? 0} running, ${q.pending?.length ?? 0} pending`);
    } catch (err) { add('task_queue', 'WARNING', err.message); }

    // Execution engines (Xoft Core, Hermes, …): an offline optional engine is DEGRADED at worst — never CRITICAL — because
    // tasks fall back to another compatible engine. Only "no engine can run anything" is a WARNING.
    try {
      const engines = this.engineStatus?.();
      if (engines?.length) {
        const usable = engines.filter((e) => e.health?.available);
        const down = engines.filter((e) => e.status !== 'disabled' && !e.health?.available);
        if (!usable.length) add('engines', 'WARNING', 'no execution engine is currently available');
        else if (down.length) add('engines', 'DEGRADED', `${usable.length} available; ${down.map((e) => `${e.name}: ${e.health?.level ?? e.status}`).join(', ')} (tasks fall back automatically)`);
        else add('engines', 'HEALTHY', `${usable.length} engine(s) available: ${usable.map((e) => e.name).join(', ')}`);
      }
    } catch (err) { add('engines', 'WARNING', `engine check failed: ${err.message}`); }

    // Device Runtime (pc-agent): reads what each agent last REPORTED — no fabricated health.
    try {
      const rts = this.runtimeHealth?.() ?? [];
      if (rts.length) {
        const parts = []; let level = 'HEALTHY';
        for (const d of rts) {
          const r = d.runtime;
          if (!d.online) { level = worst(level, 'WARNING'); parts.push(`${d.name}: OFFLINE`); continue; }
          if (!r) { parts.push(`${d.name}: no runtime report yet`); continue; }
          if (r.halted) { level = worst(level, 'DEGRADED'); parts.push(`${d.name}: HALTED (human resume required)`); }
          if (r.interruptedOperations > 0) { level = worst(level, 'WARNING'); parts.push(`${d.name}: ${r.interruptedOperations} operation(s) interrupted by a restart/crash — review the operation journal`); }
          if (!r.halted && !r.interruptedOperations) parts.push(`${d.name}: ok, browser ${r.browser?.ok ? 'reachable' : 'not reachable (only matters if browser tools are used)'}`);
        }
        add('device_runtime', level, parts.join('; '));
      }
    } catch (err) { add('device_runtime', 'WARNING', `runtime health check failed: ${err.message}`); }

    if (this.emergencyStop?.isActive?.()) add('emergency_stop', 'WARNING', 'emergency stop is ACTIVE — autonomous work is blocked');

    return { overall: checks.reduce((l, c) => worst(l, c.level), 'HEALTHY'), checks, ts: new Date().toISOString() };
  }

  async tick() {
    const report = await this.diagnose();
    const critical = report.checks.filter((c) => c.level === 'CRITICAL');
    const paused = [];
    if (critical.length) {
      const reason = `watchdog: ${critical.map((c) => `${c.name} — ${c.detail}`).join('; ')}`;
      for (const m of this.missions.list()) {
        if (['created', 'planned', 'running'].includes(m.status)) {
          try { this.missions.pause(m.id, reason); paused.push(m.id); } catch { /* already terminal */ }
        }
      }
      if (paused.length) {
        this.activityLog?.log({ type: 'watchdog_paused_missions', detail: { count: paused.length, reason } });
        this.eventBus?.emitEvent('watchdog.paused', { count: paused.length, reason });
      }
    }
    return { ...report, pausedMissions: paused };
  }

  start(intervalMs = 30000) {
    if (this._timer) return;
    this._timer = setInterval(() => { this.tick().catch(() => { /* a watchdog error must never crash the server */ }); }, intervalMs);
    this._timer.unref?.();
  }
  stop() { clearInterval(this._timer); this._timer = null; }
}
