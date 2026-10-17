import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CORE_STATES, reducePhases, deriveCoreState, pickCurrentTask, taskProgress, taskElapsedSeconds, progressBar,
  activityLine, classifyLogEntry, isSystemLogEntry, filterLog, overallStatus, currentModel, providerDisplay,
  fmtLatency, fmtBytes, fmtDuration, riskName, normalizeList, shouldRunFullBoot, BOOT_KEY, NAV_ITEMS, QUICK_COMMANDS,
} from '../public/js/dashboard/logic.js';
import { createStore } from '../public/js/dashboard/store.js';

const NOW = 1_800_000_000_000;

test('core state: every documented state is reachable from real inputs', () => {
  const seen = new Set();
  seen.add(deriveCoreState({}, NOW));
  seen.add(deriveCoreState({ chatPending: true }, NOW));
  seen.add(deriveCoreState({ phases: { a: 'PLANNING' } }, NOW));
  seen.add(deriveCoreState({ phases: { a: 'EXECUTING' } }, NOW));
  seen.add(deriveCoreState({ phases: { a: 'VERIFYING' } }, NOW));
  seen.add(deriveCoreState({ phases: { a: 'RECOVERING' } }, NOW));
  seen.add(deriveCoreState({ completedAt: NOW - 500 }, NOW));
  seen.add(deriveCoreState({ errorUntil: NOW + 1000 }, NOW));
  assert.deepEqual([...seen].sort(), [...CORE_STATES].sort());
});

test('core state: priority and expiry rules', () => {
  assert.equal(deriveCoreState({ emergencyActive: true, phases: { a: 'EXECUTING' } }, NOW), 'ERROR');
  assert.equal(deriveCoreState({ phases: { a: 'EXECUTING', b: 'RECOVERING' } }, NOW), 'RECOVERING');
  assert.equal(deriveCoreState({ errorUntil: NOW - 1 }, NOW), 'IDLE', 'error window expires');
  assert.equal(deriveCoreState({ completedAt: NOW - 5000 }, NOW), 'IDLE', 'learning window expires');
  assert.equal(deriveCoreState({ chatPending: true, phases: { a: 'PLANNING' } }, NOW), 'PLANNING');
});

test('core state: REST resync works when no websocket phase was seen (reload/reconnect)', () => {
  assert.equal(deriveCoreState({ tasks: [{ status: 'running' }] }, NOW), 'EXECUTING');
  assert.equal(deriveCoreState({ tasks: [{ status: 'planned' }] }, NOW), 'PLANNING');
  assert.equal(deriveCoreState({ tasks: [{ status: 'completed' }] }, NOW), 'IDLE');
});

test('reducePhases follows the real EventBus task lifecycle', () => {
  let p = {};
  const ev = (type, taskId = 't1') => ({ type, payload: { taskId } });
  p = reducePhases(p, ev('task.created')); assert.equal(p.t1, 'PLANNING');
  p = reducePhases(p, ev('task.started')); assert.equal(p.t1, 'EXECUTING');
  p = reducePhases(p, ev('task.verifying')); assert.equal(p.t1, 'VERIFYING');
  p = reducePhases(p, ev('task.retrying')); assert.equal(p.t1, 'RECOVERING');
  p = reducePhases(p, ev('task_completed')); assert.deepEqual(p, {});
  const same = { x: 'EXECUTING' };
  assert.equal(reducePhases(same, { type: 'unrelated', payload: { taskId: 'x' } }), same, 'unrelated events do not allocate');
  assert.equal(reducePhases(same, { type: 'task.started', payload: {} }), same, 'events without taskId are ignored');
});

test('current task selection and progress', () => {
  const tasks = [
    { id: 'old', status: 'completed', createdAt: '2026-01-01T00:00:00Z', steps: [] },
    { id: 'run', status: 'running', createdAt: '2026-01-02T00:00:00Z', goal: 'Deploy', steps: [
      { status: 'completed', description: 'a' }, { status: 'running', description: 'Testing Render deployment' }, { status: 'pending', description: 'c' }, { status: 'pending', description: 'd' }] },
  ];
  assert.equal(pickCurrentTask(tasks).id, 'run');
  assert.equal(pickCurrentTask([tasks[0]]).id, 'old', 'falls back to newest finished task');
  assert.equal(pickCurrentTask([]), null);
  const pr = taskProgress(tasks[1]);
  assert.deepEqual([pr.done, pr.total, pr.percent, pr.stepText], [1, 4, 25, 'Testing Render deployment']);
  assert.equal(progressBar(80), '████████░░');
  assert.equal(progressBar(0), '░░░░░░░░░░');
  const t = { status: 'running', createdAt: new Date(NOW - 65_000).toISOString() };
  assert.equal(taskElapsedSeconds(t, NOW), 65);
});

test('live activity lines are derived from real events only', () => {
  const line = activityLine({ type: 'task.created', ts: '2026-01-01T21:42:10Z', payload: { goal: 'Research deployment', stepCount: 6 } });
  assert.match(line.text, /Task created — Research deployment \(6 steps\)/);
  assert.equal(activityLine({ type: 'task_failed', payload: { error: 'boom' } }).tone, 'err');
  assert.equal(activityLine({ type: 'approval_required', payload: { toolName: 'deploy' } }).tone, 'warn');
  assert.equal(activityLine({ type: 'something.unknown', payload: {} }), null, 'unknown events are not invented into lines');
});

test('system log classification + filtering + no crash on odd entries', () => {
  assert.equal(classifyLogEntry({ type: 'event_task_failed' }), 'err');
  assert.equal(classifyLogEntry({ type: 'approval_requested' }), 'warn');
  assert.equal(classifyLogEntry({ type: 'tool_executed' }), 'info');
  assert.equal(classifyLogEntry(null), 'info');
  assert.equal(isSystemLogEntry({ type: 'tool_executed' }), false);
  assert.equal(isSystemLogEntry({ type: 'ai_model_selected' }), true);
  const e = [{ sev: 'err' }, { sev: 'warn' }, { sev: 'info' }];
  assert.equal(filterLog(e, 'ALL').length, 3);
  assert.equal(filterLog(e, 'WARN').length, 2);
  assert.equal(filterLog(e, 'ERROR').length, 1);
});

test('provider display: degraded provider shows latency unavailable, configured-but-unused is not claimed healthy', () => {
  assert.deepEqual(providerDisplay('DEGRADED'), { label: 'DEGRADED', tone: 'warn' });
  assert.equal(fmtLatency(null), 'unavailable');
  assert.equal(fmtLatency(420), '420 ms');
  assert.equal(providerDisplay('UNKNOWN').label, 'STANDBY');
  assert.equal(providerDisplay('AVAILABLE').label, 'ONLINE');
  assert.equal(providerDisplay('NOT_CONFIGURED').tone, 'off');
  assert.equal(providerDisplay('AUTH_ERROR').tone, 'err');
});

test('overall status and current model', () => {
  const p = (id, status, configured = true) => ({ id, label: id, status, configured, model: `${id}-m` });
  assert.equal(overallStatus({ online: true, ws: 'live', providers: [p('a', 'AVAILABLE')] }).label, 'ONLINE');
  assert.equal(overallStatus({ online: true, ws: 'reconnecting', providers: [] }).label, 'DEGRADED');
  assert.equal(overallStatus({ online: false, ws: 'live', providers: [] }).label, 'OFFLINE');
  assert.equal(overallStatus({ online: true, ws: 'live', providers: [p('a', 'AVAILABLE'), p('b', 'UNAVAILABLE')] }).label, 'DEGRADED');
  assert.equal(overallStatus({ online: true, ws: 'live', providers: [p('a', 'UNAVAILABLE', false)] }).label, 'ONLINE', 'unconfigured providers do not degrade status');
  assert.equal(currentModel([p('claude', 'AVAILABLE'), p('experiential', 'AVAILABLE')]).model, 'experiential-m');
  assert.equal(currentModel([p('claude', 'AVAILABLE', false)]), null);
});

test('formatters', () => {
  assert.equal(fmtBytes(1536), '1.5 KB');
  assert.equal(fmtBytes(null), '—');
  assert.equal(fmtDuration(59), '59s');
  assert.equal(fmtDuration(3661), '1h 1m');
  assert.equal(fmtDuration(90000), '1d 1h');
  assert.equal(riskName(3), 'HIGH');
  assert.equal(riskName(9), 'UNKNOWN');
});

test('normalizeList repairs the array-turned-object produced by api.js stale-cache fallback', () => {
  assert.deepEqual(normalizeList([1, 2]), [1, 2]);
  assert.deepEqual(normalizeList({ 0: 'a', 1: 'b', __stale: true }), ['a', 'b']);
  assert.deepEqual(normalizeList({ __stale: true }), []);
  assert.deepEqual(normalizeList(null), []);
});

test('first-load preference: full intro once, then skipped; reduced motion always skips', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(shouldRunFullBoot(storage, false), true);
  storage.setItem(BOOT_KEY, '1');
  assert.equal(shouldRunFullBoot(storage, false), false);
  assert.equal(shouldRunFullBoot({ getItem: () => null }, true), false);
  assert.equal(shouldRunFullBoot({ getItem() { throw new Error('denied'); } }, false), true, 'storage errors never break boot');
});

test('store: subscribers are notified only for their own slices', () => {
  const s = createStore({ a: 1, b: 1 });
  let a = 0; let b = 0;
  const ua = s.subscribe('a', () => { a += 1; });
  s.subscribe(['b'], () => { b += 1; });
  s.set('a', 2); s.set('a', 3); s.set('b', 2);
  assert.deepEqual([a, b], [2, 1]);
  ua(); s.set('a', 4);
  assert.equal(a, 2, 'unsubscribe works');
  s.update('b', (v) => v + 10);
  assert.equal(s.get('b'), 12);
});

test('navigation: all 8 required entries exist and point at registered routes', () => {
  assert.deepEqual(NAV_ITEMS.map((n) => n.label), ['COMMAND', 'CHAT', 'TASKS', 'MEMORY', 'AGENTS', 'AUTOMATIONS', 'DEVICES', 'RUNTIME', 'SETTINGS']);
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  for (const n of NAV_ITEMS) assert.match(app, new RegExp(`\\['${n.route}',`), `route ${n.route} is registered in app.js`);
  assert.equal(QUICK_COMMANDS.length, 9);
});

// ---- static structure checks (rendering itself is verified in a real browser, see scripts/verify-command-center.mjs) ----
const css = fs.readFileSync(new URL('../public/css/command-center.css', import.meta.url), 'utf8');

test('design tokens defined', () => {
  for (const t of ['--xoft-bg', '--xoft-panel', '--xoft-panel-border', '--xoft-cyan', '--xoft-cyan-dim', '--xoft-text', '--xoft-muted', '--xoft-danger', '--xoft-warning', '--xoft-success']) {
    assert.match(css, new RegExp(`${t}:`), t);
  }
});

test('responsive: desktop three-column, tablet two-column, dedicated mobile layout', () => {
  assert.match(css, /@media \(min-width: 1100px\)/);
  assert.match(css, /grid-template-columns: minmax\(250px, 300px\) minmax\(0, 1fr\) minmax\(250px, 320px\)/);
  assert.match(css, /@media \(max-width: 1099px\)[\s\S]*grid-template-columns: 1fr 1fr/);
  assert.match(css, /@media \(max-width: 699px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  // mobile order required by the spec: core, command, task, activity, providers, system
  const order = (cls) => Number(css.match(new RegExp(`\\.${cls} \\{ order: (\\d+)`))[1]);
  assert.ok(order('cc-p-core') < order('cc-p-cmd') && order('cc-p-cmd') < order('cc-p-task') && order('cc-p-task') < order('cc-p-activity')
    && order('cc-p-activity') < order('cc-p-providers') && order('cc-p-providers') < order('cc-p-system'));
});

test('reduced motion: all command-center animation is disabled and no rAF loop exists', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/);
  for (const f of fs.readdirSync(new URL('../public/js/dashboard/', import.meta.url))) {
    const src = fs.readFileSync(new URL(`../public/js/dashboard/${f}`, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''); // ignore comments
    assert.doesNotMatch(src, /requestAnimationFrame/, `${f} must not run an animation loop`);
  }
});

test('security: dashboard code never references secrets, and the new endpoints are secret-free by construction', () => {
  for (const f of fs.readdirSync(new URL('../public/js/dashboard/', import.meta.url))) {
    const src = fs.readFileSync(new URL(`../public/js/dashboard/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /apiKey|JWT|secret|Bearer /i, `${f}`);
  }
});

test('offline shell: every dashboard file and the stylesheet are precached by the service worker', () => {
  const sw = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /\/css\/command-center\.css/);
  for (const f of fs.readdirSync(new URL('../public/js/dashboard/', import.meta.url))) assert.ok(sw.includes(`/js/dashboard/${f}`), f);
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /command-center\.css/);
});
