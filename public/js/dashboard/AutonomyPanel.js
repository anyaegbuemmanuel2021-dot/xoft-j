import { esc } from '../dom.js';
import { statusIndicator } from './StatusIndicator.js';

const DECISION = {
  auto: ['ALLOWED', 'ok'],
  auto_if_trusted_device_or_mission: ['ALLOWED (trusted only)', 'warn'],
  approval_required: ['APPROVAL REQUIRED', 'warn'],
  approval_always: ['ALWAYS ASKS', 'err'],
};

export function mountAutonomy(el, store) {
  function paint() {
    const { data, error } = store.get('autonomy');
    if (!data) { el.innerHTML = `<div class="cc-empty">${error ? 'Autonomy policy unavailable: ' + esc(error) : 'Loading…'}</div>`; return; }
    el.innerHTML = `
      <dl class="cc-kv">
        <div><dt>LEVEL</dt><dd class="cc-num">${data.level} · ${esc(data.label)}</dd></div>
        <div><dt>EMERGENCY STOP</dt><dd>${data.emergencyStop?.active ? statusIndicator('ACTIVE', 'err') : statusIndicator('INACTIVE', 'ok')}</dd></div>
        <div><dt>PRIVACY ROUTING</dt><dd>${data.privacyRouting ? statusIndicator('ON', 'ok') : statusIndicator('OFF', 'off')}</dd></div>
      </dl>
      <div class="cc-sub">WITHOUT ASKING YOU, BY RISK</div>
      <dl class="cc-kv">${data.policy.map((p) => { const [label, tone] = DECISION[p.decision] ?? [p.decision, 'idle']; return `<div><dt>${esc(p.risk)}</dt><dd>${statusIndicator(label, tone)}</dd></div>`; }).join('')}</dl>
      <p class="cc-muted cc-small">Per-domain autonomy (files, browser, finance…) is not implemented in XOFT; this is the real per-risk policy.</p>
      <div class="cc-actions"><button type="button" data-nav="overview">CHANGE LEVEL</button></div>`;
  }
  el.addEventListener('click', (e) => { if (e.target.closest('[data-nav]')) location.hash = '#overview'; });
  paint();
  return store.subscribe('autonomy', paint);
}
