import { api } from '../api.js';
import { card, badge, esc, toast, guarded, onDelegate, debounce } from '../dom.js';
import { onEvent } from '../ws.js';

const AUTONOMY_LABELS = ['MANUAL', 'SUGGEST', 'APPROVAL', 'LOW_RISK_AUTONOMY', 'TRUSTED_AUTONOMY', 'MISSION_AUTONOMY'];

export const title = 'Overview';
export let cleanup = null;

export async function render(container) {
  const [status, world, autonomy, stop, queue, realtime, activityResult] = await Promise.all([
    api.get('/api/status'), api.get('/api/world-state'), api.get('/api/autonomy'),
    api.get('/api/emergency-stop'), api.get('/api/task-queue/status'), api.get('/api/realtime/status'),
    api.get('/api/activity').catch(() => []),
  ]);
  const recentActivity = Array.isArray(activityResult) ? activityResult.slice().reverse().slice(0, 6) : [];
  const runningCount = Number(queue.running?.length || 0);
  const pendingCount = Number(queue.pending?.length || 0);
  const activityCount = Array.isArray(activityResult) ? activityResult.length : 0;
  const recentWorkHtml = recentActivity.length ? recentActivity.map((item) => '<div class="row work-summary-item"><span class="work-summary-dot" aria-hidden="true"></span><span class="main">' + esc(String(item.type || 'Activity').replace(/[_-]+/g, ' ')) + '</span><small>' + esc(new Date(item.timestamp ?? item.createdAt ?? Date.now()).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })) + '</small></div>').join('') : '<div class="empty">No recent activity has been recorded yet. XOFT will show work here as activity events arrive.</div>';

  container.innerHTML = `
    ${status.__stale ? '<div class="empty">Offline — showing last known status.</div>' : ''}
    <div class="grid">
      ${card('System', `
        <div class="row"><span class="main">AI providers</span><span>${status.configuredProviders.length ? status.configuredProviders.map(p => badge(p, 'ok')).join('') : badge('none configured', 'warn')}</span></div>
        <div class="row"><span class="main">Local model (Ollama)</span><span>${status.localModel.enabled ? badge(status.localModel.reachable ? 'reachable' : 'unreachable', status.localModel.reachable ? 'ok' : 'err') : badge('disabled', '')}</span></div>
        <div class="row"><span class="main">Realtime (WebSocket)</span><span>${realtime.available ? badge(realtime.clients + ' client(s)', 'ok') : badge('unavailable', 'err')}</span></div>
        <div class="row"><span class="main">Task queue</span><span>${queue.running.length} running / ${queue.pending.length} pending</span></div>
      `)}
      ${card('Autonomy', `
        <div class="form-row">
          <label>Level (${autonomy.level} — ${esc(autonomy.label)})</label>
          <select id="autonomy-select">
            ${AUTONOMY_LABELS.map((l, i) => `<option value="${i}" ${i === autonomy.level ? 'selected' : ''}>${i} — ${l}</option>`).join('')}
          </select>
        </div>
        <button id="autonomy-save" class="primary">Set level</button>
      `)}
      ${card('Emergency Stop', `
        <div class="row"><span class="main">Status</span>${stop.active ? badge('ACTIVE — ' + (stop.reason || 'no reason given'), 'err') : badge('inactive', 'ok')}</div>
        <button id="stop-toggle" class="${stop.active ? '' : 'danger'}">${stop.active ? 'Deactivate' : 'Activate emergency stop'}</button>
      `)}
      ${card('Work Summary', `
        <div class="work-summary-stats"><a href="#tasks"><strong>${runningCount}</strong><span>RUNNING</span></a><a href="#tasks"><strong>${pendingCount}</strong><span>QUEUED</span></a><a href="#activity"><strong>${activityCount}</strong><span>ACTIVITY ITEMS</span></a></div>
        <div class="work-summary-list">${recentWorkHtml}</div>
        <div class="work-summary-links"><a href="#activity">Open Activity Log →</a><a href="#tasks">View Tasks →</a><a href="#missions">Review Missions →</a><a href="#memory">Open Memory →</a></div>
      `, { span2: true })}
      ${card('World State', `<pre>${esc(JSON.stringify(world, null, 2)).slice(0, 1200)}</pre>`, { span2: true })}
    </div>
  `;

  onDelegate(container, 'click', '#autonomy-save', async () => {
    const level = Number(container.querySelector('#autonomy-select').value);
    await guarded(() => api.post('/api/autonomy', { level, reason: 'changed from dashboard' }), 'Set autonomy');
    toast('Autonomy level updated', 'ok');
    render(container);
  });

  onDelegate(container, 'click', '#stop-toggle', async () => {
    if (stop.active) {
      await guarded(() => api.post('/api/emergency-stop/deactivate'), 'Deactivate');
      toast('Emergency stop deactivated', 'ok');
    } else {
      const reason = window.prompt('Reason for activating emergency stop:') || 'manual activation';
      await guarded(() => api.post('/api/emergency-stop/activate', { reason }), 'Activate');
      toast('Emergency stop activated', 'err');
    }
    render(container);
  });

  // Live: any of these happening elsewhere (another tab, a background job,
  // the PC agent) should refresh this dashboard without waiting for a
  // manual reload. Debounced since several may arrive in a burst.
  const refresh = debounce(() => render(container), 500);
  const unsubscribe = onEvent(['*'], refresh);
  cleanup = unsubscribe;
}
