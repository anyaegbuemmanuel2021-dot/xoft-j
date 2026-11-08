// data.js — connects the dashboard store to the EXISTING XOFT backend:
// REST via ../api.js (auth header, offline cache/queue) and the EXISTING
// WebSocket client in ../ws.js. There is no second socket here.
import { api } from '../api.js';
import { wsEvents, onEvent, isConnected } from '../ws.js';
import { activityLine, reducePhases, deriveCoreState, normalizeList, classifyLogEntry, isSystemLogEntry } from './logic.js';

const HISTORY_POINTS = 40;

export function initialState() {
  return {
    telemetry: { data: null, stale: false, error: null },
    telemetryHistory: { cpu: [], mem: [] },
    status: { data: null, stale: false, error: null },
    providers: { data: [], stale: false, error: null },
    tasks: { data: [], stale: false, error: null },
    approvals: { data: [], stale: false, error: null },
    memory: { data: [], stale: false, error: null },
    kgStats: { data: null, stale: false, error: null },
    devices: { data: [], stale: false, error: null },
    missions: { data: [], stale: false, error: null },
    sched: { data: null, stale: false, error: null },
    autonomy: { data: null, stale: false, error: null },
    diagnostics: { data: null, stale: false, error: null },
    activity: [], // LIVE ACTIVITY ring (from WebSocket events)
    log: { entries: [], stale: false, error: null }, // SYSTEM LOG
    conn: { online: navigator.onLine, ws: isConnected() ? 'live' : 'connecting' },
    phases: {},
    chat: { pending: false, exchanges: [] },
    completedAt: 0,
    errorUntil: 0,
    core: 'IDLE',
  };
}

export function startData(store) {
  const disposers = [];
  const timers = [];
  let stopped = false;
  let ready = false; // polling starts once the first authenticated call has settled (see markReady)

  async function load(key, path, map) {
    try {
      const raw = await api.get(path);
      const data = map ? map(raw) : raw;
      store.set(key, { data, stale: Boolean(raw?.__stale), error: null, ts: Date.now() });
      return data;
    } catch (err) {
      const prev = store.get(key) ?? {};
      store.set(key, { ...prev, error: err.message });
      return null;
    }
  }

  const list = (raw) => normalizeList(raw);

  const fetchers = {
    telemetry: async () => {
      const data = await load('telemetry', '/api/system/telemetry');
      if (data) {
        store.update('telemetryHistory', (h) => ({
          cpu: data.cpu?.percent === null || data.cpu?.percent === undefined ? h.cpu : [...h.cpu, data.cpu.percent].slice(-HISTORY_POINTS),
          mem: data.memory?.usedPercent === null || data.memory?.usedPercent === undefined ? h.mem : [...h.mem, data.memory.usedPercent].slice(-HISTORY_POINTS),
        }));
      }
    },
    status: () => load('status', '/api/status'),
    providers: () => load('providers', '/api/providers/overview', list),
    tasks: () => load('tasks', '/api/tasks', list),
    approvals: () => load('approvals', '/api/approvals', list),
    memory: () => load('memory', '/api/memory', list),
    kgStats: () => load('kgStats', '/api/knowledge-graph/stats'),
    devices: () => load('devices', '/api/devices', list),
    missions: () => load('missions', '/api/missions', list),
    sched: () => load('sched', '/api/missions/next'),
    autonomy: () => load('autonomy', '/api/autonomy/policy'),
    diagnostics: () => load('diagnostics', '/api/diagnostics'),
    log: async () => {
      try {
        const raw = await api.get('/api/activity');
        const entries = normalizeList(raw).slice(-300).map((e) => ({ ...e, sev: classifyLogEntry(e) })).filter(isSystemLogEntry).slice(-60).reverse();
        store.set('log', { entries, stale: Boolean(raw?.__stale), error: null });
      } catch (err) {
        store.set('log', { ...store.get('log'), error: err.message });
      }
    },
  };

  const intervals = { telemetry: 5000, status: 15000, providers: 15000, tasks: 6000, approvals: 10000, memory: 30000, kgStats: 30000, devices: 30000, log: 30000, missions: 8000, sched: 15000, autonomy: 20000, diagnostics: 20000 };

  const refresh = (key) => fetchers[key]?.();
  const refreshAll = () => Promise.allSettled(Object.keys(fetchers).map((k) => fetchers[k]()));

  // Debounced targeted refresh so a burst of events costs one request.
  const pending = new Set();
  let flushTimer = null;
  function scheduleRefresh(...keys) {
    keys.forEach((k) => pending.add(k));
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const ks = [...pending];
      pending.clear();
      ks.forEach((k) => refresh(k));
    }, 350);
  }

  // ---- core state derivation ----
  let coreTimer = null;
  function recomputeCore() {
    const status = store.get('status')?.data;
    const now = Date.now();
    const next = deriveCoreState({
      chatPending: store.get('chat').pending,
      emergencyActive: Boolean(status?.emergencyStop?.active),
      errorUntil: store.get('errorUntil'),
      phases: store.get('phases'),
      tasks: store.get('tasks').data ?? [],
      completedAt: store.get('completedAt'),
    }, now);
    if (next !== store.get('core')) store.set('core', next);
    clearTimeout(coreTimer);
    const expiries = [store.get('errorUntil'), store.get('completedAt') + 4000].filter((t) => t > now);
    if (expiries.length) coreTimer = setTimeout(recomputeCore, Math.min(...expiries) - now + 30);
  }
  disposers.push(store.subscribe(['chat', 'phases', 'tasks', 'status', 'completedAt', 'errorUntil'], recomputeCore));

  // ---- WebSocket (existing ws.js) ----
  function pushActivity(line) {
    store.update('activity', (a) => [line, ...a].slice(0, 40));
    if (line.tone === 'warn' || line.tone === 'err') {
      store.update('log', (l) => ({ ...l, entries: [{ id: `ws-${line.ts}-${line.type}`, ts: line.ts, type: line.type, detail: line.text, sev: line.tone === 'err' ? 'err' : 'warn' }, ...l.entries].slice(0, 60) }));
    }
  }
  function systemNote(text, tone = 'warn') {
    const line = { ts: new Date().toISOString(), type: 'dashboard', text, tone };
    pushActivity(line);
  }

  let wasLive = isConnected();
  const onOpen = () => {
    store.update('conn', (c) => ({ ...c, ws: 'live' }));
    if (!wasLive) { systemNote('WebSocket connected — resyncing', 'info'); refreshAll(); }
    wasLive = true;
  };
  const onClose = () => {
    store.update('conn', (c) => ({ ...c, ws: 'reconnecting' }));
    if (wasLive) systemNote('WebSocket disconnected — reconnecting', 'warn');
    wasLive = false;
  };
  wsEvents.addEventListener('open', onOpen);
  wsEvents.addEventListener('close', onClose);
  disposers.push(() => { wsEvents.removeEventListener('open', onOpen); wsEvents.removeEventListener('close', onClose); });

  disposers.push(onEvent('*', (event) => {
    const phases = reducePhases(store.get('phases'), event);
    if (phases !== store.get('phases')) store.set('phases', phases);
    const line = activityLine(event);
    if (line) pushActivity(line);
    const t = event.type;
    if (t === 'task_completed') store.set('completedAt', Date.now());
    if (t === 'task_failed' || t === 'device.security.alert') store.set('errorUntil', Date.now() + 8000);
    if (t.startsWith('task')) scheduleRefresh('tasks');
    if (t === 'approval_required') scheduleRefresh('approvals', 'tasks');
    if (t.startsWith('device')) scheduleRefresh('devices');
    if (t === 'emergency_stop_activated') scheduleRefresh('status', 'autonomy', 'diagnostics');
    if (t.startsWith('mission.') || t === 'watchdog.paused') scheduleRefresh('missions', 'sched', 'diagnostics');
    if (t === 'autonomy.changed') scheduleRefresh('autonomy', 'status');
    if (t === 'watchdog.paused') store.set('errorUntil', Date.now() + 6000);
    if (t === 'automation_triggered' || t === 'monitor_triggered') scheduleRefresh('log');
  }));

  // ---- browser connectivity ----
  const onNet = () => { store.update('conn', (c) => ({ ...c, online: navigator.onLine })); if (navigator.onLine) refreshAll(); };
  window.addEventListener('online', onNet);
  window.addEventListener('offline', onNet);
  disposers.push(() => { window.removeEventListener('online', onNet); window.removeEventListener('offline', onNet); });

  // ---- polling, paused while the tab is hidden ----
  function startPolling() {
    for (const [key, ms] of Object.entries(intervals)) timers.push(setInterval(() => { if (ready && !document.hidden && !stopped) fetchers[key](); }, ms));
  }
  const onVis = () => { if (!document.hidden) refreshAll(); };
  document.addEventListener('visibilitychange', onVis);
  disposers.push(() => document.removeEventListener('visibilitychange', onVis));

  startPolling();

  return {
    refresh,
    refreshAll,
    recomputeCore,
    markReady() { ready = true; },
    stop() {
      stopped = true;
      timers.forEach(clearInterval);
      clearTimeout(flushTimer);
      clearTimeout(coreTimer);
      disposers.forEach((d) => { try { d(); } catch { /* ignore */ } });
    },
  };
}
