import { esc } from '../dom.js';
import { pickCurrentTask, taskProgress, taskElapsedSeconds, fmtDuration, progressBar, currentModel } from './logic.js';
import { statusIndicator } from './StatusIndicator.js';

const TONE = { running: 'ok', completed: 'ok', planned: 'idle', waiting_approval: 'warn', failed: 'err', blocked: 'err', timed_out: 'err', cancelled: 'warn' };

export function mountCurrentTask(el, store) {
  let tick = null;

  function paint() {
    const task = pickCurrentTask(store.get('tasks').data);
    if (!task) { el.innerHTML = '<div class="cc-empty">No tasks yet. Give XOFT a command below.</div>'; stopTick(); return; }
    const pr = taskProgress(task);
    const live = task.status === 'running';
    el.innerHTML = `
      <div class="cc-task-name">${esc(String(task.goal ?? task.id).slice(0, 90))}</div>
      <div class="cc-task-status">${statusIndicator(String(task.status).replace(/_/g, ' ').toUpperCase(), TONE[task.status] ?? 'idle')}</div>
      <dl class="cc-kv">
        <div><dt>STEP</dt><dd>${esc(pr.stepText ?? task.blockedReason ?? '—')}</dd></div>
        <div><dt>PROGRESS</dt><dd class="cc-num" aria-label="${pr.percent} percent, ${pr.done} of ${pr.total} steps"><span class="cc-ascii" aria-hidden="true">${progressBar(pr.percent)}</span> ${pr.percent}%${pr.total ? ` (${pr.done}/${pr.total})` : ''}</dd></div>
        <div><dt>ELAPSED</dt><dd class="cc-num" data-elapsed>${fmtDuration(taskElapsedSeconds(task))}</dd></div>
        <div><dt>AGENT</dt><dd class="cc-num">${esc(task.createdBy ?? 'user')}</dd></div>
        <div><dt>MODEL</dt><dd class="cc-num">${esc(currentModel(store.get('providers').data)?.model ?? '—')}</dd></div>
      </dl>`;
    if (live) startTick(task); else stopTick();
  }

  // Only the elapsed cell updates each second, and only while a task is running.
  function startTick(task) {
    stopTick();
    tick = setInterval(() => {
      const cell = el.querySelector('[data-elapsed]');
      if (cell) cell.textContent = fmtDuration(taskElapsedSeconds(task));
    }, 1000);
  }
  function stopTick() { clearInterval(tick); tick = null; }

  paint();
  const unsub = store.subscribe(['tasks', 'providers'], paint);
  return () => { unsub(); stopTick(); };
}
