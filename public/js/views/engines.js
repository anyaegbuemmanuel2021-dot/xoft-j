// engines.js — Execution Engines view: Xoft Core + Hermes (and any future engine).
//   ENGINES · NEW ENGINE TASK · ACTIVE & RECENT TASKS (live) · APPROVALS · HERMES SETTINGS · BRIDGE · LOGS
// Everything shown comes from the real engine registry / task manager. Progress is the engine's real event stream
// (tool calls, commands, files) — there is no percentage bar, because the engine does not know how long its work will take.
import { card, badge, rows, fmtTime, esc, toast, debounce } from '../dom.js';
import { onEvent } from '../ws.js';

export const title = 'Engines';
export let cleanup = null;

const key = () => localStorage.getItem('xoft_api_key') || '';
// Direct fetch, deliberately NOT api.post: api.js queues failed/offline POSTs and replays them later. Starting, pausing or
// cancelling an autonomous agent — or approving a delete — must never be silently replayed after the moment the user clicked.
async function direct(method, path, payload) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(key() ? { 'X-API-Key': key() } : {}) }, body: payload !== undefined ? JSON.stringify(payload) : undefined });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body;
}
const soft = (path, fallback) => direct('GET', path).catch(() => fallback);

const STATUS = { online: ['Online', 'ok'], busy: ['Busy', 'warn'], starting: ['Starting', 'warn'], offline: ['Offline', 'err'], error: ['Error', 'err'], disabled: ['Disabled', ''] };
const STATE = { queued: ['queued', ''], initializing: ['starting', 'warn'], running: ['running', 'ok'], waiting: ['waiting for approval', 'warn'], paused: ['paused', 'warn'], completed: ['completed', 'ok'], failed: ['failed', 'err'], cancelled: ['cancelled', ''] };
const DEP_LABEL = { runtime: 'Runtime', api: 'API server', api_key: 'API key', model: 'Model', filesystem: 'Filesystem', terminal: 'Terminal', browser: 'Browser', bridge: 'Xoft tool bridge', git: 'Git', devices: 'Paired device', pc_control: 'PC control' };
const TOOL_GROUPS = [['Filesystem', /(file|patch|read|write|mkdir)/i], ['Terminal', /(terminal|shell|bash|exec|process|powershell|cmd)/i], ['Browser', /browser/i]];
const ACTIVE = ['queued', 'initializing', 'running', 'waiting', 'paused'];

const depBadge = (name, v) => `<span class="badge ${v === true ? 'ok' : v === false ? 'err' : ''}" title="${esc(DEP_LABEL[name] ?? name)}: ${v === true ? 'available' : v === false ? 'not available' : 'unknown / not checked'}">${esc(DEP_LABEL[name] ?? name)} ${v === true ? '✓' : v === false ? '✗' : '?'}</span>`;

function engineCard(e, fallbackName) {
  const [label, kind] = STATUS[e.status] ?? [e.status, ''];
  const h = e.health;
  const deps = h?.dependencies ? Object.entries(h.dependencies) : [];
  const hermes = e.id === 'hermes';
  const reason = h?.reason ?? e.statusReason;
  return `<div class="eng-engine" data-engine="${esc(e.id)}">
    <div class="eng-head"><b>${esc(e.name)}</b> ${badge(label, kind)} ${h?.level && h.level !== 'ready' ? badge(h.level, 'warn') : ''} ${e.managed ? badge('started by Xoft', '') : ''} ${e.pid ? `<span class="muted">pid ${esc(e.pid)}</span>` : ''}</div>
    <div class="muted">${esc(e.description ?? '')}</div>
    ${reason ? `<div class="eng-reason">${esc(reason)}</div>` : ''}
    ${!h?.available && h?.fallback ? `<div class="muted">Fallback: <b>${esc(fallbackName(h.fallback))}</b></div>` : ''}
    ${deps.length ? `<div class="eng-deps">${deps.map(([k, v]) => depBadge(k, v)).join(' ')}</div>` : ''}
    <div class="eng-caps">${(e.capabilities ?? []).map((c) => `<span class="badge">${esc(c)}</span>`).join(' ') || '<span class="muted">no capabilities available right now</span>'}</div>
    ${hermes ? `<div class="eng-actions">
      <button data-eng-act="refresh">Re-check</button>
      <button data-eng-act="start" class="primary" ${e.status === 'disabled' ? 'disabled' : ''}>Start Hermes</button>
      <button data-eng-act="stop" ${e.managed ? '' : 'disabled title="Xoft can only stop a Hermes it started itself"'}>Stop</button>
      <button data-eng-act="env">Detect environment</button>
      <button data-eng-act="install">Install guide</button>
      <button data-eng-act="logs">Process log</button>
    </div><div id="eng-hermes-out" class="eng-out"></div>` : `<div class="eng-actions"><button data-eng-act="refresh">Re-check</button></div>`}
  </div>`;
}

function toolBadges(t) {
  const used = Object.keys(t.progress?.toolsUsed ?? {});
  const perms = t.grantedPermissions ?? [];
  const allowed = { Filesystem: perms.some((p) => p.startsWith('filesystem.')), Terminal: perms.includes('terminal.execute'), Browser: perms.some((p) => p.startsWith('browser.')) };
  return TOOL_GROUPS.map(([name, re]) => {
    const was = used.some((u) => re.test(u));
    return `<span class="badge ${was ? 'ok' : ''}" title="${allowed[name] ? 'permitted' : 'not permitted for this task'}${was ? ' · used' : ''}">${esc(name)} ${allowed[name] ? '✓' : '✗'}${was ? ' •' : ''}</span>`;
  }).join(' ');
}

function taskRow(t) {
  const [label, kind] = STATE[t.state] ?? [t.state, ''];
  const live = ['initializing', 'running'].includes(t.state);
  const p = t.progress ?? {};
  const v = t.result?.verification;
  const approvals = (t.pendingApprovals ?? []).map((a) => `<div class="eng-approval"><span>${badge(a.destructive ? 'destructive' : 'needs approval', a.destructive ? 'err' : 'warn')} ${esc(a.summary ?? a.tool ?? 'action')}</span>
      <span><button class="primary" data-approve="${esc(a.approvalId)}" data-task="${esc(t.id)}">Approve</button> <button data-reject="${esc(a.approvalId)}" data-task="${esc(t.id)}">Reject</button></span></div>`).join('');
  return `<div class="eng-task" data-id="${esc(t.id)}">
    <div class="eng-head"><b>${esc((t.goal ?? '').slice(0, 140))}</b></div>
    <div>${badge(label, kind)} ${badge(t.engine, '')} ${t.routing?.fallbackFrom ? badge(`fell back from ${t.routing.fallbackFrom}`, 'warn') : ''} ${badge(`autonomy ${t.autonomy}`, '')} ${v ? badge(v.status, v.status === 'verified' ? 'ok' : v.status === 'failed' ? 'err' : 'warn') : ''} <span class="muted">${esc(fmtTime(t.startedAt ?? t.createdAt))}</span></div>
    <div class="muted">Engine: ${esc(t.engine)} · Status: ${esc(label)}${t.stateReason ? ` · ${esc(t.stateReason)}` : ''}</div>
    ${live || t.state === 'waiting' ? `<div class="eng-activity">${live ? '<span class="eng-spin"></span>' : ''}Current activity: ${esc(p.currentActivity ?? (live ? 'working…' : 'waiting'))}</div>` : ''}
    <div>${toolBadges(t)} <span class="muted">${esc(p.toolCalls ?? 0)} tool calls · ${esc((p.filesChanged ?? []).length)} files changed · ${esc((p.commands ?? []).length)} commands${p.errors ? ` · ${esc(p.errors)} errors` : ''}${p.warnings ? ` · ${esc(p.warnings)} warnings` : ''}</span></div>
    ${approvals}
    ${t.result?.summary ? `<div class="eng-result">${esc(t.result.summary.slice(0, 600))}</div>` : ''}
    ${v?.statement ? `<div class="muted">${esc(v.statement)}</div>` : ''}
    ${t.error ? `<div class="eng-reason">${esc(t.error)}</div>` : ''}
    <div class="eng-actions">
      ${['running', 'waiting'].includes(t.state) ? `<button data-task-act="pause">Pause</button>` : ''}
      ${t.state === 'paused' ? `<button data-task-act="resume" class="primary">Resume</button>` : ''}
      ${ACTIVE.includes(t.state) ? `<button data-task-act="cancel" class="danger">Stop</button>` : ''}
      <button data-task-act="logs">View logs</button>
      <button data-task-act="report">Report</button>
      ${!ACTIVE.includes(t.state) && t.workspace?.isRepo ? `<button data-task-act="rollback">Roll back…</button>` : ''}
    </div>
    <div class="eng-out" id="eng-out-${esc(t.id)}"></div>
  </div>`;
}

const settingsField = (id, label, html, help = '') => `<div class="form-row"><label for="${id}">${esc(label)}</label>${html}${help ? `<div class="muted">${esc(help)}</div>` : ''}</div>`;
const sel = (id, opts, cur) => `<select id="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

function settingsForm(s, perms) {
  const profiles = Object.keys(perms?.profiles ?? { standard: 1 });
  return `<div class="eng-form">
    ${settingsField('hs-enabled', 'Enable Hermes', sel('hs-enabled', [[true, 'Enabled'], [false, 'Disabled']], s.enabled))}
    ${settingsField('hs-autoStart', 'Auto-start Hermes', sel('hs-autoStart', [[false, 'No (start it myself)'], [true, 'Yes, when Xoft starts']], s.autoStart), 'Xoft only starts a Hermes it can find; it never installs one.')}
    ${settingsField('hs-baseUrl', 'API URL', `<input id="hs-baseUrl" value="${esc(s.baseUrl)}" />`, 'Where Hermes\' API server listens. The API key is set with HERMES_API_KEY, not here.')}
    ${settingsField('hs-runtimePath', 'Runtime path', `<input id="hs-runtimePath" value="${esc(s.runtimePath)}" placeholder="blank = find 'hermes' on PATH" />`)}
    ${settingsField('hs-hermesHome', 'Hermes home', `<input id="hs-hermesHome" value="${esc(s.hermesHome)}" placeholder="blank = ~/.hermes (or HERMES_HOME)" />`)}
    ${settingsField('hs-workingDirectory', 'Default working directory', `<input id="hs-workingDirectory" value="${esc(s.workingDirectory)}" placeholder="a project folder" />`, 'Used when a coding/file task does not name one.')}
    ${settingsField('hs-allowedRoots', 'Allowed directories', `<input id="hs-allowedRoots" value="${esc((s.allowedRoots ?? []).join(', '))}" placeholder="comma-separated; blank = any non-system project folder" />`, 'Hermes tasks can only be started inside these.')}
    ${settingsField('hs-defaultAutonomy', 'Default autonomy', sel('hs-defaultAutonomy', [0, 1, 2, 3, 4, 5].map((n) => [n, `${n} — ${(perms?.autonomy?.[n] ?? '').split(' — ')[0]}`]), s.defaultAutonomy), 'Xoft\'s global autonomy level is always a ceiling on this.')}
    ${settingsField('hs-permissionProfile', 'Permission profile (ceiling)', sel('hs-permissionProfile', profiles.map((p) => [p, `${p}${perms?.descriptions?.[p] ? ` — ${perms.descriptions[p].slice(0, 60)}` : ''}`]), typeof s.permissionProfile === 'string' ? s.permissionProfile : 'standard'))}
    ${settingsField('hs-maxConcurrentTasks', 'Maximum concurrent tasks', `<input id="hs-maxConcurrentTasks" type="number" min="1" max="32" value="${esc(s.maxConcurrentTasks)}" />`)}
    ${settingsField('hs-timeoutMin', 'Task timeout (minutes)', `<input id="hs-timeoutMin" type="number" min="1" value="${esc(Math.round(s.timeoutMs / 60000))}" />`, 'Time spent waiting for your approval does not count.')}
    ${settingsField('hs-maxToolCalls', 'Tool-call limit per task', `<input id="hs-maxToolCalls" type="number" min="0" value="${esc(s.maxToolCalls)}" />`, '0 = unlimited')}
    ${settingsField('hs-maxRetries', 'Recovery retries', `<input id="hs-maxRetries" type="number" min="0" max="10" value="${esc(s.maxRetries)}" />`)}
    ${settingsField('hs-maxMemoryMb', 'Memory limit (MB)', `<input id="hs-maxMemoryMb" type="number" min="0" value="${esc(s.maxMemoryMb)}" />`, '0 = no limit. Enforced on a Hermes that Xoft started (Linux/macOS).')}
    ${settingsField('hs-nativeToolPolicy', 'Hermes\' own tools', sel('hs-nativeToolPolicy', [['monitor', 'Monitor — log violations'], ['enforce', 'Enforce — stop the task on a violation'], ['off', 'Off']], s.nativeToolPolicy), 'Xoft sees Hermes\' built-in tools only as events, so "enforce" stops the run at the next event.')}
    ${settingsField('hs-workspaceMode', 'Code safety net', sel('hs-workspaceMode', [['in-place', 'Edit in place (backup ref)'], ['branch', 'New git branch (clean tree only)'], ['worktree', 'Isolated git worktree']], s.workspaceMode))}
    ${settingsField('hs-bridgeEnabled', 'Xoft tool bridge', sel('hs-bridgeEnabled', [[true, 'Enabled'], [false, 'Disabled']], s.bridgeEnabled), 'Lets Hermes use Xoft\'s files/browser/device tools through Xoft\'s permission system.')}
    ${settingsField('hs-bridgeDeviceId', 'Bridge device id', `<input id="hs-bridgeDeviceId" value="${esc(s.bridgeDeviceId)}" placeholder="blank = first online trusted device" />`)}
    ${settingsField('hs-logLevel', 'Logging level', sel('hs-logLevel', ['error', 'warn', 'info', 'debug'].map((l) => [l, l]), s.logLevel))}
    <button id="hs-save" class="primary">Save Hermes settings</button>
  </div>`;
}

function readSettings(root) {
  const v = (id) => root.querySelector(`#${id}`).value;
  const b = (id) => v(id) === 'true';
  const n = (id) => Number(v(id));
  const profile = v('hs-permissionProfile');
  return {
    enabled: b('hs-enabled'), autoStart: b('hs-autoStart'), baseUrl: v('hs-baseUrl').trim(), runtimePath: v('hs-runtimePath'), hermesHome: v('hs-hermesHome'), workingDirectory: v('hs-workingDirectory'),
    allowedRoots: v('hs-allowedRoots').split(',').map((x) => x.trim()).filter(Boolean), defaultAutonomy: n('hs-defaultAutonomy'), permissionProfile: profile,
    maxConcurrentTasks: n('hs-maxConcurrentTasks'), timeoutMs: n('hs-timeoutMin') * 60000, maxToolCalls: n('hs-maxToolCalls'), maxRetries: n('hs-maxRetries'), maxMemoryMb: n('hs-maxMemoryMb'),
    nativeToolPolicy: v('hs-nativeToolPolicy'), workspaceMode: v('hs-workspaceMode'), bridgeEnabled: b('hs-bridgeEnabled'), bridgeDeviceId: v('hs-bridgeDeviceId'), logLevel: v('hs-logLevel'),
  };
}

function eventLine(e) {
  const t = new Date(e.ts).toLocaleTimeString();
  const bits = [e.tool, e.command ?? e.preview ?? e.text ?? e.summary ?? e.reason ?? e.message ?? e.error ?? e.state].filter(Boolean).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
  return `${t}  ${e.type}${bits.length ? `  ${bits.join(' · ').replace(/\s+/g, ' ').slice(0, 220)}` : ''}`;
}

export async function render(container) {
  container._engAbort?.abort(); const ac = new AbortController(); container._engAbort = ac;
  const on = (selector, handler) => container.addEventListener('click', (e) => { const el = e.target.closest(selector); if (el && container.contains(el)) handler(el, e); }, { signal: ac.signal });
  const [perms, settingsResp] = await Promise.all([soft('/api/engines/permissions', {}), soft('/api/engines/hermes/settings', null)]);

  container.innerHTML = `
    ${card('Execution engines', '<div id="eng-engines" class="empty">Loading…</div>', { span2: true })}
    ${card('New engine task', `
      <div class="form-row"><label>Goal</label><textarea id="et-goal" placeholder="e.g. Open my project, inspect the authentication system, find the bug, fix it, run the tests and report what you changed."></textarea></div>
      <div class="form-row"><label>Working directory</label><input id="et-wd" placeholder="/path/to/project (needed for coding / file tasks)" /></div>
      <div class="form-row"><label>Engine</label><select id="et-engine"><option value="auto">Auto (Xoft chooses, with fallback)</option><option value="xoft-core">Xoft Core</option><option value="hermes">Hermes</option></select></div>
      <div class="form-row"><label>Permissions</label><select id="et-profile"><option value="">Engine default</option>${Object.keys(perms.profiles ?? {}).map((p) => `<option value="${esc(p)}">${esc(p)} — ${esc((perms.descriptions?.[p] ?? '').slice(0, 70))}</option>`).join('')}</select></div>
      <div class="form-row"><label>Autonomy</label><select id="et-autonomy"><option value="">Engine default</option>${[0, 1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n} — ${esc((perms.autonomy?.[n] ?? '').split(' — ')[0])}</option>`).join('')}</select></div>
      <button id="et-preview">Preview routing</button> <button id="et-run" class="primary">Run task</button>
      <div id="et-out" class="eng-out"></div>
      <p class="muted">Destructive actions (deleting files, force-push, dropping data) always ask you first, whatever the autonomy level.</p>`)}
    ${settingsResp ? card('Hermes settings', settingsForm(settingsResp.settings, perms)) : card('Hermes settings', '<div class="empty">Settings need an admin API key.</div>')}
    ${card('Tasks', '<div id="eng-tasks" class="empty">Loading…</div>', { span2: true })}
  `;

  const names = {};
  const out = (id, html) => { const el = container.querySelector(id); if (el) el.innerHTML = html; };
  const fail = (id) => (err) => out(id, `<div class="eng-reason">${esc(err.message)}</div>`);
  const pre = (text) => `<pre class="eng-pre">${esc(text)}</pre>`;

  async function refreshEngines() {
    const data = await soft('/api/engines', { engines: [] });
    for (const e of data.engines) names[e.id] = e.name;
    out('#eng-engines', `<div class="eng-grid">${rows(data.engines, (e) => engineCard(e, (id) => names[id] ?? id), 'No engines registered.')}</div>
      <p class="muted">Queue: ${esc((data.queue?.running ?? []).length)} running · ${esc((data.queue?.pending ?? []).length)} waiting · limit ${esc(data.queue?.maxConcurrent ?? '—')} at once</p>`);
  }
  const openLogs = new Set();
  async function refreshTasks() {
    const data = await soft('/api/engine-tasks?limit=30', { tasks: [] });
    const keep = {}; for (const id of openLogs) { const el = container.querySelector(`#eng-out-${CSS.escape(id)}`); if (el) keep[id] = el.innerHTML; }
    out('#eng-tasks', rows(data.tasks, taskRow, 'No engine tasks yet. Start one above.'));
    for (const [id, html] of Object.entries(keep)) { const el = container.querySelector(`#eng-out-${CSS.escape(id)}`); if (el) el.innerHTML = html; }
    return data.tasks;
  }
  await refreshEngines(); await refreshTasks();

  const refreshSoon = debounce(() => { refreshTasks().catch(() => {}); }, 500);
  const refreshEnginesSoon = debounce(() => { refreshEngines().catch(() => {}); }, 800);
  const unsub = onEvent(['*'], (ev) => { if (!ev?.type?.startsWith('engine.')) return; if (ev.type.startsWith('engine.task') || ev.type.startsWith('engine.tool') || ev.type.startsWith('engine.approval') || ev.type.startsWith('engine.command') || ev.type.startsWith('engine.file')) refreshSoon(); else refreshEnginesSoon(); });
  const poll = setInterval(() => { refreshTasks().then((t) => { if (t.some((x) => ACTIVE.includes(x.state))) refreshEnginesSoon(); }).catch(() => {}); }, 6000);
  cleanup = () => { unsub?.(); clearInterval(poll); ac.abort(); };

  // ---- engine actions ----
  on('[data-eng-act]', async (el) => {
    const act = el.dataset.engAct; const id = el.closest('[data-engine]').dataset.engine;
    try {
      if (act === 'refresh') { await direct('POST', '/api/engines/refresh', { engine: id }); toast('Re-checked', 'ok'); await refreshEngines(); return; }
      if (act === 'start') { el.disabled = true; const r = await direct('POST', '/api/engines/hermes/start'); toast(r.started ? 'Hermes started' : r.reason, 'ok'); await refreshEngines(); return; }
      if (act === 'stop') { await direct('POST', '/api/engines/hermes/stop'); toast('Hermes stopped', 'ok'); await refreshEngines(); return; }
      if (act === 'env') { const r = await direct('GET', '/api/engines/hermes/environment'); out('#eng-hermes-out', pre(`OS: ${r.os.platform} ${r.os.arch}${r.os.wsl ? ' (WSL)' : ''}\nNode: ${r.node.version}\nPython: ${r.python.found ? r.python.version : 'not found'}\nGit: ${r.git.found ? r.git.version : 'not found'}\nPackage managers: ${Object.entries(r.packageManagers).filter(([, v]) => v.found).map(([k]) => k).join(', ') || 'none'}\nHermes: ${r.hermes.installed ? `${r.hermes.version ?? 'installed'} at ${r.hermes.path}` : 'NOT INSTALLED'}\nHermes home: ${r.hermes.home} (${r.hermes.homeExists ? 'exists' : 'missing'}; config.yaml ${r.hermes.hasConfig ? 'present' : 'missing'})\nModel providers configured in Hermes: ${r.hermes.configuredProviders.join(', ') || 'none found'}\nAPI key for Xoft: ${r.api.keyConfigured ? `set (${r.api.keySource})` : 'not set'}`)); return; }
      if (act === 'install') { const g = await direct('GET', '/api/engines/hermes/install'); out('#eng-hermes-out', pre(`${g.recommended.title}\n  ${g.recommended.commands.join('\n  ')}\n\nThen:\n  ${g.afterInstall.join('\n  ')}\n\n${g.notes.join('\n')}\n\nDocs: ${g.docs.apiServer}`)); return; }
      if (act === 'logs') { const r = await direct('GET', '/api/engines/hermes/logs?lines=80'); out('#eng-hermes-out', pre(r.lines.length ? r.lines.join('\n') : `No output captured — Hermes is ${r.process.running ? 'running' : 'not running'} and was ${r.process.managed ? '' : 'not '}started by Xoft.`)); }
    } catch (err) { toast(err.message, 'err'); fail('#eng-hermes-out')(err); refreshEngines().catch(() => {}); }
  });

  // ---- new task ----
  const taskBody = () => {
    const body = { goal: container.querySelector('#et-goal').value.trim() };
    const wd = container.querySelector('#et-wd').value.trim(); if (wd) body.workingDirectory = wd;
    const eng = container.querySelector('#et-engine').value; if (eng !== 'auto') body.engine = eng;
    const prof = container.querySelector('#et-profile').value; if (prof) body.permissions = prof;
    const aut = container.querySelector('#et-autonomy').value; if (aut !== '') body.autonomy = Number(aut);
    return body;
  };
  on('#et-preview', async () => {
    const body = taskBody(); if (!body.goal) return;
    try {
      const r = await direct('POST', '/api/engines/route', body);
      out('#et-out', pre(`${r.engine ? `→ ${names[r.engine] ?? r.engine}${r.chain.length > 1 ? `  (fallback chain: ${r.chain.map((c) => names[c] ?? c).join(' → ')})` : ''}` : '→ no engine can run this'}\n${r.reason ?? ''}\nNeeds: ${r.analysis.requiredCapabilities.join(', ')}${r.analysis.autonomous ? ' · autonomous' : ''}${r.analysis.longRunning ? ' · long-running' : ''}\n\n${r.candidates.map((c) => `${c.serveable ? '✓' : '✗'} ${names[c.engineId] ?? c.engineId}: ${c.reasons.join('; ')}`).join('\n')}`));
    } catch (err) { fail('#et-out')(err); }
  });
  on('#et-run', async (el) => {
    const body = taskBody(); if (!body.goal) { toast('Enter a goal', 'warn'); return; }
    el.disabled = true;
    try {
      const { task } = await direct('POST', '/api/engine-tasks', body);
      toast(`Started on ${names[task.engine] ?? task.engine}`, 'ok');
      out('#et-out', pre(`${task.routing.reason}\nEffective permissions: ${task.grantedPermissions.join(', ') || 'none'}\nAutonomy: ${task.autonomy}`));
      container.querySelector('#et-goal').value = '';
      await refreshTasks();
    } catch (err) { fail('#et-out')(err); toast(err.message, 'err'); } finally { el.disabled = false; }
  });

  // ---- task actions ----
  on('[data-task-act]', async (el) => {
    const id = el.closest('[data-id]').dataset.id; const act = el.dataset.taskAct; const box = `#eng-out-${CSS.escape(id)}`;
    try {
      if (act === 'cancel') { if (!confirm('Stop this task? Work already done is kept.')) return; await direct('POST', `/api/engine-tasks/${id}/cancel`, {}); toast('Stopped', 'ok'); }
      else if (act === 'pause') { await direct('POST', `/api/engine-tasks/${id}/pause`, {}); toast('Paused', 'ok'); }
      else if (act === 'resume') { await direct('POST', `/api/engine-tasks/${id}/resume`, {}); toast('Resuming', 'ok'); }
      else if (act === 'logs') {
        if (openLogs.has(id)) { openLogs.delete(id); out(box, ''); return; }
        const { events } = await direct('GET', `/api/engine-tasks/${id}/events?limit=200`);
        openLogs.add(id); out(box, pre(events.map(eventLine).join('\n') || 'No events yet.')); return;
      } else if (act === 'report') { const r = await direct('GET', `/api/engine-tasks/${id}/report`); openLogs.add(id); out(box, pre(JSON.stringify(r, null, 2))); return; }
      else if (act === 'rollback') { if (!confirm('Undo this task\'s changes? They are stashed/kept in git, not deleted.')) return; const r = await direct('POST', `/api/engine-tasks/${id}/rollback`, {}); openLogs.add(id); out(box, pre(`${r.rolledBack ? 'Rolled back' : 'Not rolled back'}: ${r.how}`)); return; }
      await refreshTasks();
    } catch (err) { toast(err.message, 'err'); fail(box)(err); }
  });
  const decide = (decision) => async (el) => {
    const approvalId = decision === 'approve' ? el.dataset.approve : el.dataset.reject;
    try { await direct('POST', `/api/engine-tasks/${el.dataset.task}/approvals/${approvalId}`, { decision }); toast(decision === 'approve' ? 'Approved' : 'Rejected', 'ok'); await refreshTasks(); } catch (err) { toast(err.message, 'err'); }
  };
  on('[data-approve]', decide('approve'));
  on('[data-reject]', decide('reject'));

  // ---- settings ----
  on('#hs-save', async () => {
    try { const r = await direct('PUT', '/api/engines/hermes/settings', readSettings(container)); toast('Hermes settings saved', 'ok'); void r; await refreshEngines(); } catch (err) { toast(err.message, 'err'); }
  });
}
