import { api } from '../api.js';
import { card, badge, rows, fmtTime, esc, toast, guarded, onDelegate, debounce } from '../dom.js';
import { onEvent } from '../ws.js';

export const title = 'Tasks';
export let cleanup = null;

const TASK_EVENTS = ['task.created', 'task.queued', 'task.started', 'task.verifying', 'task.retrying', 'task.recovering', 'task.cancelled', 'task_completed', 'task_failed'];

export async function render(container) {
  const tasks = await api.get('/api/tasks');

  container.innerHTML = `
    ${card('New task', `
      <div class="form-row"><label>Goal</label><textarea id="new-goal" placeholder="e.g. summarize today's activity log"></textarea></div>
      <button id="create-task" class="primary">Plan task</button>
    `)}
    ${card('Tasks', rows(tasks.slice().reverse(), taskRow, 'No tasks yet.'), { span2: true, id: 'task-list' })}
  `;

  onDelegate(container, 'click', '#create-task', async () => {
    const goal = container.querySelector('#new-goal').value.trim();
    if (!goal) return;
    await guarded(() => api.post('/api/tasks', { goal }), 'Create task');
    toast('Task planned', 'ok');
    render(container);
  });

  onDelegate(container, 'click', '[data-execute]', async (el) => {
    await guarded(() => api.post(`/api/tasks/${el.dataset.execute}/execute`), 'Execute');
    render(container);
  });
  onDelegate(container, 'click', '[data-enqueue]', async (el) => {
    await guarded(() => api.post(`/api/tasks/${el.dataset.enqueue}/enqueue`), 'Enqueue');
    toast('Queued', 'ok');
    render(container);
  });
  onDelegate(container, 'click', '[data-cancel]', async (el) => {
    await guarded(() => api.post(`/api/tasks/${el.dataset.cancel}/cancel`), 'Cancel');
    render(container);
  });
  onDelegate(container, 'click', '[data-schedule]', async (el) => {
    const when = window.prompt('Schedule for (ISO time, e.g. 2026-01-01T20:00:00Z):');
    if (!when) return;
    await guarded(() => api.post(`/api/tasks/${el.dataset.schedule}/schedule`, { at: when }), 'Schedule');
    toast('Scheduled', 'ok');
    render(container);
  });
  onDelegate(container, 'click', '[data-executions]', async (el) => {
    const list = await guarded(() => api.get(`/api/tasks/${el.dataset.executions}/executions`), 'Load executions');
    alert(list.length ? list.map((r) => `${r.toolName} attempt ${r.attemptNumber}: ${r.status}${r.error ? ' — ' + r.error : ''}`).join('\n') : 'No execution records yet.');
  });

  // Live: a task's status can change from the queue/scheduler/recovery
  // engine with nobody touching this page — reflect that without polling.
  const refresh = debounce(() => render(container), 400);
  cleanup = onEvent(TASK_EVENTS, refresh);
}

function statusBadge(status) {
  const kind = { completed: 'ok', failed: 'err', running: 'ok', cancelled: '', blocked: 'warn', waiting_approval: 'warn', scheduled: 'warn', queued: 'warn' }[status] ?? '';
  return badge(status, kind);
}

function taskRow(t) {
  const doneSteps = t.steps.filter((s) => s.status === 'completed').length;
  return `
    <div class="row" style="flex-direction:column; align-items:stretch;">
      <div style="display:flex; justify-content:space-between; gap:8px;">
        <span class="main">${esc(t.goal)}</span>
        ${statusBadge(t.status)}
      </div>
      <div class="muted" style="margin:4px 0;">${doneSteps}/${t.steps.length} steps · created ${fmtTime(t.createdAt)}${t.scheduledFor ? ' · scheduled for ' + fmtTime(t.scheduledFor) : ''}</div>
      <div class="inline" style="gap:6px; flex-wrap:wrap;">
        ${t.status === 'planned' || t.status === 'blocked' || t.status === 'waiting_approval' ? `<button data-execute="${t.id}">Execute</button><button data-enqueue="${t.id}">Enqueue</button><button data-schedule="${t.id}">Schedule…</button>` : ''}
        ${!['completed', 'cancelled'].includes(t.status) ? `<button data-cancel="${t.id}" class="danger">Cancel</button>` : ''}
        <button data-executions="${t.id}">Executions</button>
      </div>
    </div>
  `;
}
