import { api } from '../api.js';
import { card, badge, rows, fmtTime, esc, toast, guarded, onDelegate } from '../dom.js';

export const title = 'Automation';
let tab = 'rules';
const TABS = ['rules', 'workflows', 'jobs', 'monitors'];

export async function render(container) {
  container.innerHTML = `
    <div class="tabs">${TABS.map((t) => `<button data-tab="${t}" class="${tab === t ? 'active' : ''}">${t}</button>`).join('')}</div>
    <div id="tab-body"><div class="empty">Loading…</div></div>
  `;
  onDelegate(container, 'click', '[data-tab]', (el) => { tab = el.dataset.tab; render(container); });
  const renderers = { rules: renderRules, workflows: renderWorkflows, jobs: renderJobs, monitors: renderMonitors };
  await renderers[tab](container);
}

async function renderRules(container) {
  const rules = await api.get('/api/rules');
  const body = container.querySelector('#tab-body');
  body.innerHTML = `
    ${card('New rule', `
      <div class="form-row"><label>Rule (natural language)</label><textarea id="new-rule" placeholder="e.g. never send messages after 10pm without asking me"></textarea></div>
      <button id="create-rule" class="primary">Create</button>
    `)}
    ${card('Rules', rows(rules.slice().reverse(), (r) => genericRow(r.description ?? r.rule, r, `/api/rules/${r.id}/disable`), 'No rules yet.'), { span2: true })}
  `;
  onDelegate(body, 'click', '#create-rule', async () => {
    const rule = body.querySelector('#new-rule').value.trim();
    if (!rule) return;
    await guarded(() => api.post('/api/rules', { rule }), 'Create rule');
    toast('Rule created', 'ok');
    render(container);
  });
  wireAction(body, container);
}

async function renderWorkflows(container) {
  const workflows = await api.get('/api/workflows');
  const body = container.querySelector('#tab-body');
  body.innerHTML = `
    ${card('Workflows', rows(workflows.slice().reverse(), (w) => `
      <div class="row" style="flex-direction:column; align-items:stretch;">
        <div style="display:flex; justify-content:space-between;"><span class="main">${esc(w.name)}</span>${badge(w.enabled === false ? 'disabled' : 'enabled', w.enabled === false ? '' : 'ok')}</div>
        <div class="muted" style="margin:4px 0;">${(w.steps ?? []).length} step(s)${w.triggerEventType ? ' · triggers on ' + esc(w.triggerEventType) : ' · manual run'}</div>
        <div class="inline" style="gap:6px;"><button data-run-wf="${w.id}">Run now</button><button data-disable-wf="${w.id}" class="danger">Disable</button></div>
      </div>
    `, 'No workflows defined.'), { span2: true })}
  `;
  onDelegate(body, 'click', '[data-run-wf]', async (el) => { await guarded(() => api.post(`/api/workflows/${el.dataset.runWf}/run`), 'Run workflow'); toast('Started', 'ok'); render(container); });
  onDelegate(body, 'click', '[data-disable-wf]', async (el) => { await guarded(() => api.post(`/api/workflows/${el.dataset.disableWf}/disable`), 'Disable'); render(container); });
}

async function renderJobs(container) {
  const jobs = await api.get('/api/jobs');
  const body = container.querySelector('#tab-body');
  body.innerHTML = card('Background jobs', rows(jobs.slice().reverse(), (j) => `
    <div class="row" style="flex-direction:column; align-items:stretch;">
      <div style="display:flex; justify-content:space-between;"><span class="main">${esc(j.toolName)}</span>${badge(j.status ?? 'scheduled', j.status === 'paused' ? 'warn' : 'ok')}</div>
      <div class="muted" style="margin:4px 0;">${j.intervalMs ? 'every ' + Math.round(j.intervalMs / 60000) + ' min' : 'one-time'}${j.nextRunAt ? ' · next ' + fmtTime(j.nextRunAt) : ''}</div>
      <div class="inline" style="gap:6px;">
        <button data-pause-job="${j.id}">Pause</button>
        <button data-resume-job="${j.id}">Resume</button>
        <button data-cancel-job="${j.id}" class="danger">Cancel</button>
      </div>
    </div>
  `, 'No background jobs.'));
  onDelegate(body, 'click', '[data-pause-job]', async (el) => { await guarded(() => api.post(`/api/jobs/${el.dataset.pauseJob}/pause`), 'Pause'); render(container); });
  onDelegate(body, 'click', '[data-resume-job]', async (el) => { await guarded(() => api.post(`/api/jobs/${el.dataset.resumeJob}/resume`), 'Resume'); render(container); });
  onDelegate(body, 'click', '[data-cancel-job]', async (el) => { await guarded(() => api.post(`/api/jobs/${el.dataset.cancelJob}/cancel`), 'Cancel'); render(container); });
}

async function renderMonitors(container) {
  const monitors = await api.get('/api/monitors');
  const body = container.querySelector('#tab-body');
  body.innerHTML = `
    ${card('New monitor', `
      <div class="form-row"><label>Description</label><input id="mon-desc" placeholder="e.g. check disk space" /></div>
      <div class="form-row"><label>Tool name</label><input id="mon-tool" placeholder="system.info" /></div>
      <div class="form-row"><label>Interval (minutes)</label><input id="mon-interval" type="number" value="15" /></div>
      <button id="create-monitor" class="primary">Create</button>
    `)}
    ${card('Monitors', rows(monitors.slice().reverse(), (m) => genericRow(m.description, m, `/api/monitors/${m.id}/stop`, 'Stop'), 'No monitors running.'), { span2: true })}
  `;
  onDelegate(body, 'click', '#create-monitor', async () => {
    const description = body.querySelector('#mon-desc').value.trim();
    const toolName = body.querySelector('#mon-tool').value.trim();
    const intervalMinutes = Number(body.querySelector('#mon-interval').value) || 15;
    if (!description || !toolName) return toast('Description and tool name are required', 'err');
    await guarded(() => api.post('/api/monitors', { description, toolName, intervalMinutes }), 'Create monitor');
    toast('Monitor created', 'ok');
    render(container);
  });
  wireAction(body, container);
}

function genericRow(label, item, actionPath, actionLabel = 'Disable') {
  return `
    <div class="row" style="flex-direction:column; align-items:stretch;">
      <div style="display:flex; justify-content:space-between;"><span class="main">${esc(label)}</span>${badge(item.enabled === false || item.status === 'stopped' ? 'inactive' : 'active', item.enabled === false || item.status === 'stopped' ? '' : 'ok')}</div>
      <div class="muted" style="margin:4px 0;">created ${fmtTime(item.createdAt)}</div>
      <div><button data-action="${actionPath}">${actionLabel}</button></div>
    </div>
  `;
}

function wireAction(body, container) {
  onDelegate(body, 'click', '[data-action]', async (el) => { await guarded(() => api.post(el.dataset.action), 'Update'); render(container); });
}
