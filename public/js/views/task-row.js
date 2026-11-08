import { badge, esc, fmtTime } from '../dom.js';

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

export function taskRow(t) {
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
