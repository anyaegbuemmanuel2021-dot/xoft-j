import { api } from '../api.js';
import { esc, toast } from '../dom.js';
import { riskName } from './logic.js';
import { statusIndicator } from './StatusIndicator.js';

function summarize(input) {
  try { const s = JSON.stringify(input); return s.length > 180 ? s.slice(0, 177) + '…' : s; } catch { return ''; }
}

/** Renders pending approvals from the EXISTING approval system; approve/deny call the existing endpoints. Nothing is auto-approved here. */
export function mountApprovals(el, store, controller) {
  const busy = new Set();

  function paint() {
    const list = store.get('approvals').data;
    if (!list.length) { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = list.map((a) => {
      const risk = riskName(a.riskLevel);
      const tone = risk === 'HIGH' ? 'err' : risk === 'MEDIUM' ? 'warn' : 'idle';
      const disabled = busy.has(a.id) ? 'disabled' : '';
      return `
      <section class="cc-approval" data-risk="${risk}" aria-labelledby="ap-${esc(a.id)}">
        <h3 id="ap-${esc(a.id)}">APPROVAL REQUIRED</h3>
        <p class="cc-approval-q">Run <b>${esc(a.toolName)}</b>?${a.reason && a.reason !== 'explicit_approval' ? ` <span class="cc-muted">(${esc(a.reason)})</span>` : ''}</p>
        <dl class="cc-kv">
          <div><dt>RISK</dt><dd>${statusIndicator(risk, tone)}</dd></div>
          <div><dt>ACTION</dt><dd class="cc-num cc-wrap">${esc(a.toolName)} ${esc(summarize(a.input))}</dd></div>
        </dl>
        <div class="cc-actions">
          <button type="button" class="cc-primary" data-approve="${esc(a.id)}" ${disabled}>APPROVE</button>
          <button type="button" data-deny="${esc(a.id)}" ${disabled}>DENY</button>
        </div>
      </section>`;
    }).join('');
  }

  async function decide(id, verb) {
    busy.add(id); paint();
    try {
      await api.post(`/api/approvals/${encodeURIComponent(id)}/${verb}`);
      toast(verb === 'approve' ? 'Approved' : 'Denied', verb === 'approve' ? 'ok' : '');
    } catch (err) { toast(`${verb} failed: ${err.message}`, 'err'); }
    busy.delete(id);
    await Promise.all([controller.refresh('approvals'), controller.refresh('tasks')]);
    paint();
  }

  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-approve]'); if (a) return decide(a.dataset.approve, 'approve');
    const d = e.target.closest('[data-deny]'); if (d) return decide(d.dataset.deny, 'reject');
  });
  paint();
  return store.subscribe('approvals', paint);
}
