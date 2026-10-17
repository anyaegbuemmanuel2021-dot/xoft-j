import { api } from '../api.js';
import { esc, toast } from '../dom.js';
import { overallStatus, currentModel } from './logic.js';
import { statusIndicator } from './StatusIndicator.js';
import { BOOT_KEY } from './logic.js';

export function mountTopBar(el, store, controller) {
  let menuOpen = false;

  el.innerHTML = `
    <div class="cc-brand"><span class="cc-logo" aria-hidden="true">✕</span><div><div class="cc-brand-name">XOFT</div><div class="cc-brand-sub">AI OPERATING SYSTEM</div></div><span data-overall></span></div>
    <div class="cc-top-items">
      <span class="cc-top-item" data-net></span>
      <span class="cc-top-item cc-hide-sm" data-model></span>
      <button type="button" class="cc-stop" data-stop>STOP XOFT</button>
      <a class="cc-icon-btn" href="#approvals" data-notif aria-label="Notifications"><span aria-hidden="true">🔔</span><span class="cc-badge" data-notif-count hidden></span></a>
      <div class="cc-menu-wrap">
        <button type="button" class="cc-icon-btn" data-user aria-haspopup="menu" aria-expanded="false" aria-label="User and device menu"><span aria-hidden="true">◉</span></button>
        <div class="cc-user-menu" role="menu" hidden data-usermenu></div>
      </div>
    </div>`;

  const q = (s) => el.querySelector(s);

  function paintStatus() {
    const conn = store.get('conn');
    const providers = store.get('providers').data;
    const statusSlice = store.get('status');
    const o = overallStatus({ online: conn.online, ws: conn.ws, providers, statusError: Boolean(statusSlice.error) && !statusSlice.data });
    q('[data-overall]').innerHTML = statusIndicator(o.label, o.tone);
    q('[data-net]').innerHTML = `<span class="cc-muted">NETWORK</span> ${!conn.online ? statusIndicator('OFFLINE', 'err') : conn.ws === 'live' ? statusIndicator('LIVE', 'ok') : statusIndicator(conn.ws === 'connecting' ? 'CONNECTING' : 'RECONNECTING', 'warn')}`;
    const m = currentModel(providers);
    q('[data-model]').innerHTML = `<span class="cc-muted">MODEL</span> <span class="cc-num">${esc(m ? m.model : 'none')}</span>`;
  }
  function paintStop() {
    const active = Boolean(store.get('status').data?.emergencyStop?.active);
    const b = q('[data-stop]');
    b.textContent = active ? 'RESUME XOFT' : 'STOP XOFT';
    b.dataset.active = String(active);
    b.setAttribute('aria-label', active ? 'Emergency stop is active. Resume XOFT' : 'Emergency stop: halt all XOFT autonomous activity');
  }
  function paintNotifs() {
    const n = store.get('approvals').data.length + (store.get('status').data?.proactiveSuggestions ?? 0);
    const b = q('[data-notif-count]');
    b.hidden = !n; b.textContent = n || '';
    q('[data-notif]').setAttribute('aria-label', n ? `Notifications: ${n} pending` : 'Notifications: none pending');
  }
  function paintMenu() {
    const status = store.get('status').data;
    const devices = store.get('devices').data;
    const hasKey = Boolean(localStorage.getItem('xoft_api_key'));
    q('[data-usermenu]').innerHTML = `
      <div class="cc-menu-info"><div><span class="cc-muted">DEVICE</span> <span class="cc-num">${esc(status?.localDeviceId ?? '—')}</span></div>
      <div><span class="cc-muted">API KEY</span> ${hasKey ? 'set in this browser' : 'not set'}</div>
      <div><span class="cc-muted">DEVICES</span> ${devices.length ? `${devices.filter((d) => d.online).length} online / ${devices.length}` : '—'}</div></div>
      <button type="button" role="menuitem" data-m="settings">Settings</button>
      <button type="button" role="menuitem" data-m="intro">Replay intro next load</button>
      <button type="button" role="menuitem" data-m="key" ${hasKey ? '' : 'disabled'}>Forget API key</button>`;
  }
  function setMenu(open) {
    menuOpen = open;
    q('[data-usermenu]').hidden = !open;
    q('[data-user]').setAttribute('aria-expanded', String(open));
    if (open) { paintMenu(); q('[data-usermenu] button:not([disabled])')?.focus(); }
  }

  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-stop]')) {
      const active = q('[data-stop]').dataset.active === 'true';
      try {
        if (active) { await api.post('/api/emergency-stop/deactivate'); toast('Emergency stop released', 'ok'); }
        else {
          if (!window.confirm('STOP XOFT? This blocks all tool execution and mission runs until you resume.')) return;
          await api.post('/api/emergency-stop/activate', { reason: 'stopped from Command Center' }); toast('XOFT stopped', 'err');
        }
      } catch (err) { toast(`Emergency stop request failed: ${err.message}`, 'err'); }
      await Promise.all([controller.refresh('status'), controller.refresh('autonomy'), controller.refresh('diagnostics')]);
      return;
    }
    if (e.target.closest('[data-user]')) return setMenu(!menuOpen);
    const m = e.target.closest('[data-m]')?.dataset.m;
    if (m === 'settings') location.hash = '#settings';
    if (m === 'intro') { localStorage.removeItem(BOOT_KEY); toast('Intro will play on next load', 'ok'); }
    if (m === 'key') { localStorage.removeItem('xoft_api_key'); toast('API key removed — you will be asked again on the next request', 'ok'); }
    if (m) setMenu(false);
  });
  const onDoc = (e) => { if (menuOpen && !el.querySelector('.cc-menu-wrap').contains(e.target)) setMenu(false); };
  const onKey = (e) => { if (e.key === 'Escape' && menuOpen) { setMenu(false); q('[data-user]').focus(); } };
  document.addEventListener('click', onDoc);
  document.addEventListener('keydown', onKey);

  paintStatus(); paintNotifs(); paintStop();
  const u1 = store.subscribe(['conn', 'providers', 'status'], paintStatus);
  const u2 = store.subscribe(['approvals', 'status'], () => { paintNotifs(); paintStop(); });
  return () => { u1(); u2(); document.removeEventListener('click', onDoc); document.removeEventListener('keydown', onKey); };
}
