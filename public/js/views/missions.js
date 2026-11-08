import { api } from '../api.js';
import { card, badge, rows, fmtTime, esc, toast, guarded, onDelegate } from '../dom.js';

export const title = 'Missions & Goals';
let tab = 'missions';

export async function render(container) {
  container.innerHTML = `
    <div class="tabs">
      <button data-tab="missions" class="${tab === 'missions' ? 'active' : ''}">Missions</button>
      <button data-tab="goals" class="${tab === 'goals' ? 'active' : ''}">Goals</button>
    </div>
    <div id="tab-body"><div class="empty">Loading…</div></div>
  `;
  onDelegate(container, 'click', '[data-tab]', (el) => { tab = el.dataset.tab; render(container); });
  tab === 'missions' ? await renderMissions(container) : await renderGoals(container);
}

async function renderMissions(container) {
  const missions = await api.get('/api/missions');
  const body = container.querySelector('#tab-body');
  body.innerHTML = `
    ${card('New mission', `
      <div class="form-row"><label>Goal</label><textarea id="new-mission-goal" placeholder="a larger, multi-step objective"></textarea></div>
      <button id="create-mission" class="primary">Create</button>
    `)}
    ${card('Missions', rows(missions.slice().reverse(), missionRow, 'No missions yet.'), { span2: true })}
  `;
  onDelegate(body, 'click', '#create-mission', async () => {
    const goal = body.querySelector('#new-mission-goal').value.trim();
    if (!goal) return;
    await guarded(() => api.post('/api/missions', { goal }), 'Create mission');
    toast('Mission created', 'ok');
    render(container);
  });
  onDelegate(body, 'click', '[data-plan]', async (el) => { await guarded(() => api.post(`/api/missions/${el.dataset.plan}/plan`), 'Plan'); render(container); });
  onDelegate(body, 'click', '[data-run]', async (el) => { await guarded(() => api.post(`/api/missions/${el.dataset.run}/run`), 'Run'); render(container); });
  onDelegate(body, 'click', '[data-cancel-mission]', async (el) => { await guarded(() => api.post(`/api/missions/${el.dataset.cancelMission}/cancel`), 'Cancel'); render(container); });
}

function missionRow(m) {
  return `
    <div class="row" style="flex-direction:column; align-items:stretch;">
      <div style="display:flex; justify-content:space-between;">
        <span class="main">${esc(m.goal)}</span>
        ${badge(m.status, m.status === 'completed' ? 'ok' : m.status === 'failed' ? 'err' : '')}
      </div>
      <div class="muted" style="margin:4px 0;">created ${fmtTime(m.createdAt)}</div>
      <div class="inline" style="gap:6px;">
        ${!m.taskId ? `<button data-plan="${m.id}">Plan</button>` : `<button data-run="${m.id}">Run</button>`}
        <button data-cancel-mission="${m.id}" class="danger">Cancel</button>
      </div>
    </div>
  `;
}

async function renderGoals(container) {
  const goals = await api.get('/api/goals');
  const body = container.querySelector('#tab-body');
  body.innerHTML = `
    ${card('New goal', `
      <div class="form-row"><label>Description</label><input id="new-goal-desc" placeholder="e.g. launch the new landing page" /></div>
      <button id="create-goal" class="primary">Create</button>
    `)}
    ${card('Goals', rows(goals.slice().reverse(), goalRow, 'No goals yet.'), { span2: true })}
  `;
  onDelegate(body, 'click', '#create-goal', async () => {
    const description = body.querySelector('#new-goal-desc').value.trim();
    if (!description) return;
    await guarded(() => api.post('/api/goals', { description }), 'Create goal');
    toast('Goal created', 'ok');
    render(container);
  });
  onDelegate(body, 'click', '[data-add-project]', async (el) => {
    const name = window.prompt('Project name:');
    if (!name) return;
    await guarded(() => api.post(`/api/goals/${el.dataset.addProject}/projects`, { name }), 'Add project');
    render(container);
  });
}

function goalRow(g) {
  return `
    <div class="row" style="flex-direction:column; align-items:stretch;">
      <div class="main">${esc(g.description)}</div>
      <div class="muted" style="margin:4px 0;">${(g.projects ?? []).length} project(s) · created ${fmtTime(g.createdAt)}</div>
      <div><button data-add-project="${g.id}">+ Project</button></div>
    </div>
  `;
}
