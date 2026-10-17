// logic.js — pure functions for the Command Center. No DOM, no fetch, no
// timers: everything here is unit-testable under `node --test`
// (see test/commandCenterLogic.test.js).

export const CORE_STATES = ['IDLE', 'THINKING', 'PLANNING', 'EXECUTING', 'VERIFYING', 'RECOVERING', 'LEARNING', 'ERROR'];

export const CORE_BLURB = {
  IDLE: 'Awaiting command',
  THINKING: 'Reasoning about your request',
  PLANNING: 'Building a plan',
  EXECUTING: 'Running plan steps',
  VERIFYING: 'Verifying results',
  RECOVERING: 'Retrying / recovering a step',
  LEARNING: 'Recording experience',
  ERROR: 'Attention needed',
};

const RISK_NAMES = ['SAFE', 'LOW', 'MEDIUM', 'HIGH'];
export function riskName(level) {
  return RISK_NAMES[level] ?? 'UNKNOWN';
}

export function fmtBytes(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fmtDuration(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined || Number.isNaN(totalSeconds)) return '—';
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function fmtClock(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Provider health status (ModelHealthManager.getStatus + NOT_CONFIGURED) -> display. */
export function providerDisplay(status) {
  switch (status) {
    case 'AVAILABLE': return { label: 'ONLINE', tone: 'ok' };
    // Configured but no call has happened yet — we do not claim it is healthy.
    case 'UNKNOWN': return { label: 'STANDBY', tone: 'idle' };
    case 'DEGRADED': return { label: 'DEGRADED', tone: 'warn' };
    case 'RATE_LIMITED': return { label: 'RATE LIMITED', tone: 'warn' };
    case 'TIMEOUT': return { label: 'TIMEOUT', tone: 'warn' };
    case 'AUTH_ERROR': return { label: 'AUTH ERROR', tone: 'err' };
    case 'UNAVAILABLE': return { label: 'OFFLINE', tone: 'err' };
    case 'NOT_CONFIGURED': return { label: 'NOT CONFIGURED', tone: 'off' };
    default: return { label: 'UNKNOWN', tone: 'idle' };
  }
}

export function fmtLatency(ms) {
  return ms === null || ms === undefined ? 'unavailable' : `${ms} ms`;
}

/** Phase tracking from EventBus events: taskId -> phase. */
export function reducePhases(phases, event) {
  const type = event?.type;
  const id = event?.payload?.taskId;
  if (!type || !id) return phases;
  const next = { ...phases };
  switch (type) {
    case 'task.created':
    case 'task.queued': next[id] = 'PLANNING'; break;
    case 'task.started': next[id] = 'EXECUTING'; break;
    case 'task.verifying': next[id] = 'VERIFYING'; break;
    case 'task.retrying':
    case 'task.recovering': next[id] = 'RECOVERING'; break;
    case 'task_completed':
    case 'task_failed':
    case 'task.cancelled': delete next[id]; break;
    default: return phases;
  }
  return next;
}

const PHASE_RANK = { RECOVERING: 4, VERIFYING: 3, EXECUTING: 2, PLANNING: 1 };

/**
 * What the XOFT CORE should show. Every input is real backend state:
 * REST task list, EventBus phases, in-flight chat request, emergency stop.
 * LEARNING is a short window after a completed task (the planner records the
 * experience on completion) — see completedAt.
 */
export function deriveCoreState(ctx, now = Date.now()) {
  const { chatPending = false, emergencyActive = false, errorUntil = 0, phases = {}, tasks = [], completedAt = 0 } = ctx;
  if (emergencyActive) return 'ERROR';
  if (errorUntil > now) return 'ERROR';
  let best = null;
  for (const p of Object.values(phases)) if (!best || PHASE_RANK[p] > PHASE_RANK[best]) best = p;
  if (!best) {
    // REST resync path: phases can be empty after a reconnect/reload.
    if (tasks.some((t) => t.status === 'running')) best = 'EXECUTING';
    else if (tasks.some((t) => t.status === 'planned' || t.status === 'queued')) best = 'PLANNING';
  }
  if (best) return best;
  if (chatPending) return 'THINKING';
  if (completedAt && now - completedAt < 4000) return 'LEARNING';
  return 'IDLE';
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'rolled_back']);

/** Most relevant task for the CURRENT TASK panel. */
export function pickCurrentTask(tasks) {
  if (!tasks?.length) return null;
  const byNewest = [...tasks].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return byNewest.find((t) => !TERMINAL.has(t.status) && t.status !== 'blocked') ?? byNewest[0];
}

export function taskProgress(task) {
  const steps = task?.steps ?? [];
  const total = steps.length;
  const done = steps.filter((s) => s.status === 'completed').length;
  const active = steps.find((s) => s.status === 'running' || s.status === 'waiting_approval')
    ?? steps.find((s) => s.status === 'pending' || s.status === 'failed');
  const percent = total ? Math.round((done / total) * 100) : (task && TERMINAL.has(task.status) && task.status === 'completed' ? 100 : 0);
  return { done, total, percent, stepText: active?.description ?? active?.toolName ?? null };
}

export function taskElapsedSeconds(task, now = Date.now()) {
  if (!task) return null;
  const start = Date.parse(task.startedAt ?? task.createdAt);
  if (Number.isNaN(start)) return null;
  const end = TERMINAL.has(task.status) && task.completedAt ? Date.parse(task.completedAt) : now;
  return Math.max(0, Math.round((end - start) / 1000));
}

export function progressBar(percent, width = 10) {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** One EventBus event -> a line for LIVE ACTIVITY. Returns null for events not worth showing. */
export function activityLine(event) {
  const p = event?.payload ?? {};
  const t = event?.type;
  const goal = p.goal ? ` — ${String(p.goal).slice(0, 60)}` : '';
  const map = {
    'task.created': [`Task created${goal}${p.stepCount !== undefined ? ` (${p.stepCount} steps)` : ''}`, 'info'],
    'task.queued': ['Task queued', 'info'],
    'task.started': ['Task started', 'info'],
    'task.verifying': ['Verifying task', 'info'],
    'task.retrying': ['Retrying step', 'warn'],
    'task.recovering': ['Recovering step', 'warn'],
    'task.cancelled': ['Task cancelled', 'warn'],
    task_completed: ['Task completed', 'ok'],
    task_failed: [`Task failed${p.error ? `: ${String(p.error).slice(0, 80)}` : ''}`, 'err'],
    approval_required: [`Approval required${p.toolName ? `: ${p.toolName}` : ''}`, 'warn'],
    automation_triggered: ['Automation triggered', 'info'],
    monitor_triggered: ['Monitor triggered', 'info'],
    goal_created: ['Goal created', 'info'],
    emergency_stop_activated: ['EMERGENCY STOP activated', 'err'],
    'execution.duplicate_prevented': ['Duplicate execution prevented', 'warn'],
    'execution.ambiguous': ['Ambiguous execution — needs review', 'warn'],
    device_connected: ['Device connected', 'info'],
    device_revoked: ['Device revoked', 'warn'],
    'device.online': ['Device online', 'info'],
    'device.offline': ['Device offline', 'warn'],
    'device.trusted': ['Device trusted', 'info'],
    'device.battery.low': ['Device battery low', 'warn'],
    'device.security.alert': ['Device security alert', 'err'],
    'device.command.queued': ['Device command queued', 'info'],
    'device.command.started': ['Device command started', 'info'],
    'device.command.completed': ['Device command completed', 'ok'],
    'device.command.failed': ['Device command failed', 'err'],
    'mission.created': ['Mission created', 'info'],
    'mission.run': [p.failed ? 'Mission run failed' : 'Mission run finished', p.failed ? 'warn' : 'ok'],
    'mission.paused': [`Mission paused${p.reason ? `: ${String(p.reason).slice(0, 70)}` : ''}`, 'warn'],
    'mission.resumed': ['Mission resumed', 'info'],
    'watchdog.paused': [`Watchdog paused ${p.count ?? ''} mission(s)`, 'err'],
    'autonomy.changed': ['Autonomy level changed', 'warn'],
  };
  const hit = map[t];
  if (!hit) return null;
  return { ts: event.ts ?? new Date().toISOString(), type: t, text: hit[0], tone: hit[1] };
}

/** ActivityLog entry -> severity for SYSTEM LOG. */
export function classifyLogEntry(entry) {
  const type = String(entry?.type ?? '').toLowerCase();
  if (/(fail|error|blocked|denied|reject|threat|alert|stop|revoked|timed_out|init_failed)/.test(type)) return 'err';
  if (/(warn|retry|timeout|ambiguous|duplicate|recover|approval_requested|cancel)/.test(type)) return 'warn';
  return 'info';
}

/** SYSTEM LOG shows warnings/errors and system-level events, not every tool call. */
export function isSystemLogEntry(entry) {
  const sev = classifyLogEntry(entry);
  if (sev !== 'info') return true;
  return /^(realtime_|ai_model_selected|autonomy|emergency|security|device_|channel_request)/.test(String(entry?.type ?? ''));
}

export function filterLog(entries, mode) {
  if (mode === 'ERROR') return entries.filter((e) => e.sev === 'err');
  if (mode === 'WARN') return entries.filter((e) => e.sev === 'warn' || e.sev === 'err');
  return entries;
}

export function logEntryText(entry) {
  const d = entry?.detail;
  const extra = d && typeof d === 'object' ? (d.error ?? d.reason ?? d.model ?? d.goal ?? '') : (d ?? '');
  return `${entry.type}${extra ? ` — ${String(extra).slice(0, 90)}` : ''}`;
}

/** Aggregate for the top bar. */
export function overallStatus({ online = true, ws = 'connecting', providers = [], statusError = false }) {
  if (!online || statusError) return { label: 'OFFLINE', tone: 'err' };
  const configured = providers.filter((p) => p.configured);
  const bad = configured.filter((p) => ['UNAVAILABLE', 'AUTH_ERROR'].includes(p.status));
  if (ws !== 'live' || (configured.length && bad.length === configured.length)) return { label: 'DEGRADED', tone: 'warn' };
  if (bad.length) return { label: 'DEGRADED', tone: 'warn' };
  return { label: 'ONLINE', tone: 'ok' };
}

/** Model shown in the top bar: Experiential's selected model when configured, else the first configured provider. */
export function currentModel(providers = []) {
  const exp = providers.find((p) => p.id === 'experiential' && p.configured);
  const pick = exp ?? providers.find((p) => p.configured);
  return pick ? { provider: pick.label, model: pick.model } : null;
}

export const QUICK_COMMANDS = [
  'Research the best deployment strategy.',
  'Run system diagnostics.',
  'Show my tasks.',
  'Switch to Claude.',
  'Use Experiential Labs.',
  'Open memory.',
  'Check my PC.',
  'Start automation.',
  'Deploy XOFT.',
];

export const NAV_ITEMS = [
  { id: 'command', label: 'COMMAND', route: 'command', icon: '◈' },
  { id: 'chat', label: 'CHAT', route: 'chat', icon: '✉' },
  { id: 'tasks', label: 'TASKS', route: 'tasks', icon: '☰' },
  { id: 'memory', label: 'MEMORY', route: 'memory', icon: '◍' },
  // No dedicated "agents" view exists in XOFT; missions & goals is the closest existing route.
  { id: 'agents', label: 'AGENTS', route: 'missions', icon: '⚙' },
  { id: 'automations', label: 'AUTOMATIONS', route: 'automation', icon: '⟳' },
  { id: 'devices', label: 'DEVICES', route: 'devices', icon: '▣' },
  { id: 'runtime', label: 'RUNTIME', route: 'runtime', icon: '⌘' },
  { id: 'settings', label: 'SETTINGS', route: 'settings', icon: '≡' },
];

export const BOOT_KEY = 'xoft_boot_seen';
export function shouldRunFullBoot(storage, reducedMotion = false) {
  if (reducedMotion) return false;
  try { return storage.getItem(BOOT_KEY) !== '1'; } catch { return true; }
}

/**
 * api.js's stale-cache fallback does `{...cachedArray, __stale: true}`, which
 * turns an array response into an object with numeric keys. Normalise both
 * shapes back to a plain array so panels keep working offline.
 */
export function normalizeList(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    return Object.keys(data).filter((k) => k !== '__stale' && /^\d+$/.test(k)).sort((a, b) => a - b).map((k) => data[k]);
  }
  return [];
}

export function missionTone(status) {
  return { completed: 'ok', running: 'ok', planned: 'idle', created: 'idle', paused: 'warn', waiting_approval: 'warn', failed: 'err', blocked: 'err', timed_out: 'err', cancelled: 'off' }[status] ?? 'idle';
}

export function missionUsageText(m) {
  const b = m.budget ?? {}; const u = m.usage ?? {};
  return `runs ${u.runs ?? 0}/${b.maxRuns ?? '∞'} · failures ${u.failures ?? 0}/${b.maxFailures ?? '∞'}`;
}

export function diagTone(level) {
  return { HEALTHY: 'ok', DEGRADED: 'warn', WARNING: 'warn', CRITICAL: 'err' }[level] ?? 'idle';
}
