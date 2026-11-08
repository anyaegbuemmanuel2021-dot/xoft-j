import { api } from '../api.js';
import { card, badge, rows, fmtTime, esc, toast, guarded, onDelegate, debounce } from '../dom.js';
import { onEvent } from '../ws.js';

export const title = 'Tasks';
export let cleanup = null;

const TASK_EVENTS = ['task.created', 'task.queued', 'task.started', 'task.verifying', 'task.retrying', 'task.recovering', 'task.cancelled', 'task_completed', 'task_failed'];

export async function render(container) {
  const [tasks, queue] = await Promise.all([
    api.get('/api/tasks'),
    api.get('/api/task-queue/status').catch(() => null),
  ]);

  container.innerHTML = `
    ${queue ? queueCard(queue) : ''}
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


function queueCard(queue) {
  const running = Array.isArray(queue.running) ? queue.running.length : 0;
  const pending = Array.isArray(queue.pending) ? queue.pending.length : 0;
  const concurrency = Math.max(1, Number(queue.concurrency) || 1);
  const capacity = Math.max(1, Number(queue.maxPending) || 250);
  const percent = Math.min(100, Math.round((pending / capacity) * 100));
  return card('Execution queue', `
    <div class="inline" style="gap:18px; flex-wrap:wrap;">
      <div><div class="muted">RUNNING</div><strong>${running} / ${concurrency}</strong></div>
      <div><div class="muted">WAITING</div><strong>${pending} / ${capacity}</strong></div>
      <div><div class="muted">AVAILABLE SLOTS</div><strong>${Math.max(0, concurrency - running)}</strong></div>
    </div>
    <div class="muted" style="margin-top:10px;">Pending queue capacity · ${percent}% used</div>
    <div class="progress-track" role="progressbar" aria-label="Pending queue capacity" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" style="height:5px; margin-top:5px; overflow:hidden; border-radius:99px; background:var(--surface-2, #222);">
      <div style="height:100%; width:${percent}%; background:var(--accent, #00b8b0); transition:width .2s ease;"></div>
    </div>
  `);
}

function statusBadge(status) {
  const kind = { completed: 'ok', failed: 'err', running: 'ok', cancelled: '', blocked: 'warn', waiting_approval: 'warn', scheduled: 'warn', queued: 'warn' }[status] ?? '';
  return badge(status, kind);
}

function stepRows(steps = []) {
  return steps.map((step, index) => {
    const dependencies = Array.isArray(step.dependsOn) && step.dependsOn.length
      ? `<div class="muted">Depends on: ${step.dependsOn.map(esc).join(', ')}</div>`
      : '';
    const attempts = Number.isFinite(Number(step.attempts)) ? Number(step.attempts) : 0;
    return `
      <div class="row" style="flex-direction:column; align-items:stretch; gap:3px; padding:8px 0;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
          <span class="main">${index + 1}. ${esc(step.description || step.toolName || step.id || 'Untitled step')}</span>
          ${statusBadge(step.status || 'pending')}
        </div>
        <div class="muted">${esc(step.toolName || 'No tool assigned')} · ${attempts} attempt${attempts === 1 ? '' : 's'}</div>
        ${dependencies}
        ${step.error ? `<div class="muted" style="color:var(--danger, #d55);">${esc(step.error)}</div>` : ''}
      </div>
    `;
  }).join('');
}

function taskRow(t) {
  const steps = Array.isArray(t.steps) ? t.steps : [];
  const doneSteps = steps.filter((s) => s.status === 'completed').length;
  const percent = steps.length ? Math.round((doneSteps / steps.length) * 100) : 0;
  const expanded = ['running', 'failed', 'waiting_approval', 'blocked', 'timed_out'].includes(t.status);
  const taskId = esc(t.id);
  return `
    <div class="row" style="flex-direction:column; align-items:stretch;">
      <div style="display:flex; justify-content:space-between; gap:8px;">
        <span class="main">${esc(t.goal)}</span>
        ${statusBadge(t.status)}
      </div>
      <div class="muted" style="margin:4px 0;">${doneSteps}/${steps.length} steps · ${percent}% · created ${fmtTime(t.createdAt)}${t.scheduledFor ? ' · scheduled for ' + fmtTime(t.scheduledFor) : ''}</div>
      ${steps.length ? `
        <details ${expanded ? 'open' : ''} style="margin:4px 0;">
          <summary style="cursor:pointer;">Step-by-step progress (${steps.length})</summary>
          <div style="padding-left:8px;">${stepRows(steps)}</div>
        </details>
      ` : ''}
      ${t.blockedReason ? `<div class="muted" style="margin:4px 0;">${esc(t.blockedReason)}</div>` : ''}
      <div class="inline" style="gap:6px; flex-wrap:wrap;">
        ${t.status === 'planned' || t.status === 'waiting_approval' ? `<button data-execute="${taskId}">Execute</button><button data-enqueue="${taskId}">Enqueue</button><button data-schedule="${taskId}">Schedule…</button>` : ''}
        ${!['completed', 'cancelled', 'blocked', 'rolled_back'].includes(t.status) ? `<button data-cancel="${taskId}" class="danger">Cancel</button>` : ''}
        <button data-executions="${taskId}">Executions</button>
      </div>
    </div>
  `;
}
