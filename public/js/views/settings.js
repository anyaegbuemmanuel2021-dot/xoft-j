import { api, queueLength, flushQueue } from '../api.js';
import { card, badge, rows, esc, toast, guarded, onDelegate } from '../dom.js';
import { mountAiGateways } from './aiGateways.js';

export const title = 'Settings';

export async function render(container) {
  const [health, personality, connectors, tools] = await Promise.all([
    api.get('/api/model-health').catch(() => ({})),
    api.get('/api/personality').catch(() => ({})),
    api.get('/api/connectors').catch(() => []),
    api.get('/api/tools').catch(() => []),
  ]);

  container.innerHTML = `
    <div class="grid">
      ${card('API key', `
        <div class="form-row"><label>Key used by this browser</label><input id="api-key-input" placeholder="leave blank if AUTH_API_KEYS is unset" value="${esc(localStorage.getItem('xoft_api_key') || '')}" /></div>
        <button id="api-key-save" class="primary">Save</button>
      `)}
      ${card('Offline queue', `
        <div class="row"><span class="main">Pending requests</span><span>${queueLength()}</span></div>
        <button id="flush-queue">Retry now</button>
      `)}
      ${card('Model health', rows(Object.entries(health), ([name, h]) => `
        <div class="row"><span class="main">${esc(name)}</span>${badge(h.healthy === false ? 'unhealthy' : 'healthy', h.healthy === false ? 'err' : 'ok')}</div>
      `, 'No data yet.'))}
      ${card('Personality traits', `<pre>${esc(JSON.stringify(personality, null, 2)).slice(0, 800)}</pre>`)}
      ${card('Connectors', rows(connectors, (c) => `<div class="row"><span class="main">${esc(c.id ?? c.name)}</span>${badge(c.enabled ? 'enabled' : 'disabled', c.enabled ? 'ok' : '')}</div>`, 'None configured.'))}
      <div id="ai-gateways" style="grid-column: 1 / -1"></div>
      ${card('Registered tools', `<div class="muted">${tools.length} tool(s) available to the AI planner.</div>`)}
    </div>
  `;

  // Optional AI gateways (FreeLLMAPI / LiteLLM). Isolated: if this section fails to load, the rest of Settings is unaffected.
  mountAiGateways(container.querySelector('#ai-gateways')).catch((err) => { const n = container.querySelector('#ai-gateways'); if (n) n.innerHTML = `<div class="empty">AI provider settings could not be loaded: ${esc(err.message)}</div>`; });

  onDelegate(container, 'click', '#api-key-save', () => {
    const val = container.querySelector('#api-key-input').value.trim();
    if (val) localStorage.setItem('xoft_api_key', val); else localStorage.removeItem('xoft_api_key');
    toast('Saved', 'ok');
  });

  onDelegate(container, 'click', '#flush-queue', async () => {
    await guarded(() => flushQueue(), 'Flush queue');
    toast('Queue processed', 'ok');
    render(container);
  });
}
