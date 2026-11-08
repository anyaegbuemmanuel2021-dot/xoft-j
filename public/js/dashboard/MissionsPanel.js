import { api } from '../api.js';
import { esc, toast } from '../dom.js';
import { statusIndicator } from './StatusIndicator.js';
import { missionTone, missionUsageText } from './logic.js';

export function mountMissions(el, store, controller) {
  const busy = new Set();

  function paint() {
    const { data, error, stale } = store.get('missions');
    const next = store.get('sched').data?.next;
    if (error && !data.length) { el.innerHTML = `<div class="cc-empty">Missions unavailable: ${esc(error)}</div>`; return; }
    const active = data.filter((m) => !['completed', 'cancelled'].includes(m.status));
    const shown = [...active, ...data.filter((m) => !active.includes(m))].slice(0, 5);
    if (!shown.length) { el.innerHTML = '<div class="cc-empty">No missions yet. Create one with POST /api/missions.</div>'; return; }
    el.innerHTML = `${stale ? '<div class="cc-note" role="status">Showing cached missions</div>' : ''}
      ${next ? `<div class="cc-muted cc-next">NEXT UP · <span class="cc-trunc">${esc(String(next.goal).slice(0, 60))}</span> (${esc(next.reasons.join(', '))})</div>` : ''}
      <ul class="cc-list">${shown.map((m) => {
        const paused = m.status === 'paused';
        const off = busy.has(m.id) ? 'disabled' : '';
        return `<li class="cc-mission" data-status="${esc(m.status)}">
          <div class="cc-mission-head"><span class="cc-mission-goal">${esc(String(m.goal).slice(0, 70))}</span>${statusIndicator(String(m.status).replace(/_/g, ' ').toUpperCase(), missionTone(m.status))}</div>
          <div class="cc-muted cc-mission-meta">${esc(missionUsageText(m))}${m.deadline ? ` · due ${esc(new Date(m.deadline).toLocaleDateString())}` : ''}</div>
          ${m.pausedReason ? `<div class="cc-note">${esc(m.pausedReason)}</div>` : ''}
          <div class="cc-actions">
            ${paused ? `<button type="button" data-m="resume" data-id="${esc(m.id)}" ${off}>RESUME</button>` : ['created', 'planned', 'running', 'waiting_approval'].includes(m.status) ? `<button type="button" data-m="pause" data-id="${esc(m.id)}" ${off}>PAUSE</button>` : ''}
            ${['completed', 'cancelled'].includes(m.status) ? '' : `<button type="button" data-m="stop" data-id="${esc(m.id)}" ${off}>STOP</button>`}
            <button type="button" data-m="inspect">INSPECT</button>
          </div></li>`;
      }).join('')}</ul>`;
  }

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    const { m: act, id } = b.dataset;
    if (act === 'inspect') { location.hash = '#missions'; return; }
    const mission = store.get('missions').data.find((x) => x.id === id);
    let call;
    if (act === 'pause') call = () => api.post(`/api/missions/${encodeURIComponent(id)}/pause`, { reason: 'paused from dashboard' });
    if (act === 'stop') { if (!window.confirm('Stop (cancel) this mission? This cannot be resumed.')) return; call = () => api.post(`/api/missions/${encodeURIComponent(id)}/cancel`); }
    if (act === 'resume') {
      const exhausted = /budget_exhausted/.test(mission?.pausedReason ?? '');
      let extendBudget;
      if (exhausted) {
        const extra = Number(window.prompt('Budget exhausted. Authorize how many additional runs?', '3'));
        if (!Number.isFinite(extra) || extra <= 0) return;
        extendBudget = { maxRuns: (mission.budget?.maxRuns ?? 0) + extra, maxFailures: (mission.budget?.maxFailures ?? 0) + extra };
      }
      call = () => api.post(`/api/missions/${encodeURIComponent(id)}/resume`, { extendBudget });
    }
    busy.add(id); paint();
    try { await call(); toast(`Mission ${act === 'stop' ? 'stopped' : act + 'd'}`.replace('resumed', 'resumed').replace('paused', 'paused'), 'ok'); }
    catch (err) { toast(`${act} failed: ${err.message}`, 'err'); }
    busy.delete(id);
    await Promise.all([controller.refresh('missions'), controller.refresh('sched')]);
    paint();
  });

  paint();
  return store.subscribe(['missions', 'sched'], paint);
}
