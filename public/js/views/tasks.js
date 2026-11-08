import { api } from '../api.js';
import { card, badge, rows, fmtTime, esc, toast, guarded, onDelegate, debounce } from '../dom.js';
import { onEvent } from '../ws.js';
import { taskRow } from './task-row.js';

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


