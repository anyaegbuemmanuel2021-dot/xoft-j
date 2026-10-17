import { api } from '../api.js';
import { card, badge, rows, fmtTime, esc, toast, guarded, onDelegate, debounce } from '../dom.js';
import { onEvent } from '../ws.js';

export const title = 'Devices';
export let cleanup = null;

const DEVICE_EVENTS = ['device_connected', 'device_revoked', 'device.trusted', 'device.online', 'device.offline', 'device.state.updated', 'device.security.alert'];

export async function render(container) {
  const [devices, catalog] = await Promise.all([
    api.get('/api/devices').catch(() => []), // 403 for a device-token caller — show empty rather than erroring the whole page
    api.get('/api/permissions/catalog').catch(() => []),
  ]);

  container.innerHTML = `
    ${card('Register a device', `
      <div class="form-row"><label>Name</label><input id="dev-name" placeholder="My Windows PC" /></div>
      <div class="form-row"><label>Platform</label><input id="dev-platform" placeholder="desktop" value="desktop" /></div>
      <button id="dev-create" class="primary">Register</button>
    `)}
    ${card('Devices', rows(devices, (d) => deviceRow(d, catalog), 'No devices registered.'), { span2: true })}
  `;

  onDelegate(container, 'click', '#dev-create', async () => {
    const name = container.querySelector('#dev-name').value.trim();
    const platform = container.querySelector('#dev-platform').value.trim() || 'desktop';
    if (!name) return;
    await guarded(() => api.post('/api/devices', { name, platform }), 'Register device');
    toast('Registered — trust it below once you verify it', 'ok');
    render(container);
  });

  onDelegate(container, 'click', '[data-trust]', async (el) => {
    const result = await guarded(() => api.post(`/api/devices/${el.dataset.trust}/trust`), 'Trust device');
    if (result?.deviceToken) {
      window.prompt('Device trusted. Copy this one-time token into the device\'s own config now (it will not be shown again):', result.deviceToken);
    }
    render(container);
  });

  onDelegate(container, 'click', '[data-revoke]', async (el) => {
    if (!window.confirm('Revoke this device? Its token will stop working immediately.')) return;
    await guarded(() => api.post(`/api/devices/${el.dataset.revoke}/revoke`), 'Revoke');
    toast('Revoked', 'ok');
    render(container);
  });

  onDelegate(container, 'click', '[data-grant]', async (el) => {
    const permission = window.prompt(`Grant which permission? (${catalog.join(', ') || 'e.g. files.read'})`);
    if (!permission) return;
    await guarded(() => api.post(`/api/devices/${el.dataset.grant}/permissions`, { permission }), 'Grant permission');
    render(container);
  });

  // Live: device online/offline/security-alert state matters most exactly
  // when you're NOT the one who caused it (the PC agent connecting/dropping
  // on its own, in the background).
  const refresh = debounce(() => render(container), 500);
  cleanup = onEvent(DEVICE_EVENTS, refresh);
}

function deviceRow(d, catalog) {
  const trusted = d.trust === 'trusted';
  return `
    <div class="row" style="flex-direction:column; align-items:stretch;">
      <div style="display:flex; justify-content:space-between; gap:8px;">
        <span class="main">${esc(d.name)} <span class="muted">(${esc(d.platform)})</span></span>
        ${trusted ? badge('trusted', 'ok') : badge('untrusted', 'warn')}
        ${d.online ? badge('online', 'ok') : badge('offline', '')}
      </div>
      <div class="muted" style="margin:4px 0;">registered ${fmtTime(d.createdAt)}${d.lastSeen ? ' · last seen ' + fmtTime(d.lastSeen) : ''}</div>
      <div class="inline" style="gap:6px; flex-wrap:wrap;">
        ${!trusted ? `<button data-trust="${d.id}" class="primary">Trust</button>` : `<button data-grant="${d.id}">Grant permission…</button>`}
        <button data-revoke="${d.id}" class="danger">Revoke</button>
      </div>
    </div>
  `;
}
