import { api } from '../api.js';
import { esc, toast } from '../dom.js';
import { providerDisplay, fmtLatency } from './logic.js';
import { statusIndicator } from './StatusIndicator.js';

export function mountProviderStatus(el, store, controller) {
  let openId = null;
  let models = null; // catalog for the experiential switcher, loaded on demand

  function detail(p) {
    const d = providerDisplay(p.status);
    const bad = ['warn', 'err'].includes(d.tone) && p.configured;
    return `
      <div class="cc-prov-detail" id="prov-detail-${p.id}">
        <dl class="cc-kv">
          <div><dt>CALLS</dt><dd class="cc-num">${p.calls}</dd></div>
          <div><dt>FAILURES</dt><dd class="cc-num">${p.failures}</dd></div>
          <div><dt>MODEL</dt><dd class="cc-num">${esc(p.model ?? '—')}</dd></div>
        </dl>
        ${p.configured && p.status === 'UNKNOWN' ? '<p class="cc-muted">Configured, but no request has used it yet — health is unproven.</p>' : ''}
        ${!p.configured ? '<p class="cc-muted">No API key / not enabled in server config.</p>' : ''}
        ${p.switchable && p.configured ? `<label class="cc-field"><span>SWITCH MODEL</span><select data-model-select aria-label="Experiential Labs model">${models ? models.map((m) => `<option value="${esc(m)}" ${m === p.model ? 'selected' : ''}>${esc(m)}</option>`).join('') : `<option>${esc(p.model)}</option>`}</select></label>` : ''}
        <div class="cc-actions">
          ${bad ? '<button type="button" data-act="retry">RETRY CHECK</button>' : ''}
          ${p.switchable && p.configured ? `<button type="button" data-act="${models ? 'apply-model' : 'load-models'}">${models ? 'APPLY MODEL' : 'SWITCH MODEL'}</button>` : ''}
          <button type="button" data-act="settings">OPEN SETTINGS</button>
        </div>
      </div>`;
  }

  function paint() {
    const { data, error, stale } = store.get('providers');
    if (!data.length) { el.innerHTML = `<div class="cc-empty">${error ? 'Provider status unavailable: ' + esc(error) : 'Loading providers…'}</div>`; return; }
    el.innerHTML = `${stale ? '<div class="cc-note" role="status">Showing cached provider data</div>' : ''}<ul class="cc-list">${data.map((p) => {
      const d = providerDisplay(p.status);
      const expanded = openId === p.id;
      return `<li>
        <button type="button" class="cc-row" data-prov="${p.id}" aria-expanded="${expanded}" aria-controls="prov-detail-${p.id}">
          <span class="cc-row-main"><span class="cc-row-title">${esc(p.label)}</span><span class="cc-muted cc-trunc">${esc(p.model ?? '—')} · ${esc(fmtLatency(p.avgLatencyMs))}</span></span>
          ${statusIndicator(d.label, d.tone)}
        </button>${expanded ? detail(p) : ''}</li>`;
    }).join('')}</ul>`;
  }

  el.addEventListener('click', async (e) => {
    const row = e.target.closest('[data-prov]');
    if (row) { openId = openId === row.dataset.prov ? null : row.dataset.prov; paint(); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'settings') { location.hash = '#settings'; return; }
    if (act === 'retry') { await controller.refresh('providers'); toast('Provider status re-checked (recovers after the next successful request)', ''); return; }
    if (act === 'load-models') {
      try { const r = await api.get('/api/ai/models'); models = (r.models ?? []).map((m) => m.id ?? m.slug).filter(Boolean); if (!models.length) { models = null; toast('Model catalog is empty', 'warn'); } }
      catch (err) { toast(`Could not load models: ${err.message}`, 'err'); }
      paint(); return;
    }
    if (act === 'apply-model') {
      const model = el.querySelector('[data-model-select]')?.value;
      try { await api.post('/api/ai/model', { model, provider: 'experiential' }); toast(`Model switched to ${model}`, 'ok'); await controller.refresh('providers'); }
      catch (err) { toast(err.message, 'err'); }
    }
  });

  paint();
  return store.subscribe('providers', paint);
}
