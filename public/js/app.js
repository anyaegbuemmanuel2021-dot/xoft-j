import { registerRoute, startRouter } from './router.js';
import { events, queueLength } from './api.js';
import { toast } from './dom.js';
import { connect as wsConnect, isConnected as wsIsConnected, wsEvents } from './ws.js';

import * as command from './dashboard/XoftCommandCenter.js';
import * as overview from './views/overview.js';
import * as chat from './views/chat.js';
import * as tasks from './views/tasks.js';
import * as missions from './views/missions.js';
import * as memory from './views/memory.js';
import * as devices from './views/devices.js';
import * as runtime from './views/runtime.js';
import * as engines from './views/engines.js';
import * as approvals from './views/approvals.js';
import * as automation from './views/automation.js';
import * as activity from './views/activity.js';
import * as settings from './views/settings.js';
import * as integrations from './views/integrations.js';

const ICONS = {
  command: '<path d="M12 2v3m0 14v3M2 12h3m14 0h3"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/>',
  overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-4-.9L3 21l1.9-5.5a9 9 0 0 1-.9-4A8.5 8.5 0 0 1 12.5 3h.5a8.5 8.5 0 0 1 8 8z"/><path d="M8 12h.01M12 12h.01M16 12h.01"/>',
  tasks: '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  agents: '<circle cx="12" cy="8" r="3"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/><path d="M19 8h3m-1.5-1.5v3"/>',
  missions: '<path d="M12 3 14.8 8.7 21 9.6l-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3z"/>',
  memory: '<path d="M9 3H5a2 2 0 0 0-2 2v4m0 6v4a2 2 0 0 0 2 2h4m6-18h4a2 2 0 0 1 2 2v4m0 6v4a2 2 0 0 1-2 2h-4"/><path d="M9 8h6a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2zM10 5v3m4-3v3m-4 8v3m4-3v3"/>',
  automation: '<path d="M12 8V4H8"/><path d="M4.9 19.1A8 8 0 1 0 4 12"/><path d="M4 4v5h5"/>',
  approvals: '<path d="m5 12 4 4L19 6"/><circle cx="12" cy="12" r="10"/>',
  devices: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  runtime: '<path d="M12 2 4 6v6c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V6l-8-4z"/><path d="m9 12 2 2 4-4"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-1.6.9l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.6-.9l-1.7.6-1.4-2.4 1.4-1.1a7 7 0 0 1 0-1.9l-1.4-1.1 1.4-2.4 1.7.6a8 8 0 0 1 1.6-.9l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.6.9l1.7-.6 1.4 2.4-1.4 1.1a7 7 0 0 1 0 1.9z"/>',
  plugins: '<path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3"/><rect x="6" y="6" width="12" height="12" rx="3"/><circle cx="12" cy="12" r="2"/>',
  speaker: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7m3-10a9 9 0 0 1 0 13"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>'
};
const icon = (name) => `<svg class="nav-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.overview}</svg>`;

const NAV = [
  { group: 'Workspace', items: [['command', 'Command Center', command, 'command'], ['overview', 'Overview', overview, 'overview'], ['chat', 'Chat', chat, 'chat']] },
  { group: 'Intelligence', items: [['tasks', 'Tasks', tasks, 'tasks'], ['engines', 'Agents', engines, 'agents'], ['missions', 'Missions & Goals', missions, 'missions'], ['memory', 'Memory', memory, 'memory']] },
  { group: 'Automation', items: [['automation', 'Automations', automation, 'automation'], ['approvals', 'Approvals', approvals, 'approvals'], ['integrations', 'Plugins & Apps', integrations, 'plugins']] },
  { group: 'System', items: [['devices', 'Devices', devices, 'devices'], ['runtime', 'Device Runtime', runtime, 'runtime'], ['activity', 'Activity Log', activity, 'activity'], ['settings', 'Runtime Settings', settings, 'settings']] },
];

function buildSidebar() {
  const nav = document.getElementById('nav');
  nav.innerHTML = NAV.map((g) => `
    <div class="group-label">${g.group}</div>
    ${g.items.map(([route, label, , glyph]) => `
      <a href="#${route}" data-route="${route}" title="${label}">
        ${icon(glyph)}<span class="label">${label}</span><span class="nav-chevron">${icon('chevron')}</span>
      </a>`).join('')}
  `).join('');
  const brand = document.querySelector('#sidebar .brand');
  if (brand) brand.innerHTML = `<span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 40 40"><path d="M4 5h10l22 30H25z"/><path d="M36 5H25L4 35h11z"/></svg></span><span class="brand-copy">XOFT<small>AI CORE <i>PERSONAL OS</i></small></span>`;
  const topbar = document.getElementById('topbar');
  topbar.innerHTML = `
    <div class="topbar-title"><span class="eyebrow">XOFT / SYSTEM CONSOLE</span><h1 id="page-title">Command Center</h1></div>
    <div class="topbar-actions">
      <span class="system-pill"><i class="status-pulse"></i><span id="system-state">SYSTEM ONLINE</span></span>
      <button id="global-speak-toggle" class="icon-button voice-toggle" type="button" aria-pressed="true" title="Toggle Speak Out" aria-label="Toggle Speak Out">${icon('speaker')}<span>Speak Out</span><b id="speak-state">ON</b></button>
      <button id="global-stop-speaking" class="icon-button stop-speaking" type="button" title="Stop speaking" aria-label="Stop speaking">${icon('stop')}</button>
    </div>`;
  wireGlobalVoice();
}
function wireGlobalVoice() {
  const toggle = document.getElementById('global-speak-toggle');
  const label = document.getElementById('speak-state');
  const paint = () => {
    const enabled = localStorage.getItem('xoft_speak_out_enabled') !== 'false';
    toggle?.classList.toggle('is-on', enabled);
    toggle?.setAttribute('aria-pressed', String(enabled));
    if (label) label.textContent = enabled ? 'ON' : 'OFF';
  };
  toggle?.addEventListener('click', () => {
    const enabled = localStorage.getItem('xoft_speak_out_enabled') !== 'false';
    localStorage.setItem('xoft_speak_out_enabled', String(!enabled));
    if (enabled && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    window.dispatchEvent(new CustomEvent('xoft:speakout-change'));
    paint();
    toast(!enabled ? 'Speak Out enabled' : 'Speak Out disabled', 'info');
  });
  document.getElementById('global-stop-speaking')?.addEventListener('click', () => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    toast('Speech stopped', 'info');
  });
  window.addEventListener('storage', (event) => { if (event.key === 'xoft_speak_out_enabled') paint(); });
  window.addEventListener('xoft:speakout-change', paint);
  paint();
}

function wireConnectivity() {
  const banner = document.getElementById('offline-banner');
  const indicator = document.getElementById('conn-indicator');

  function paint() {
    const online = navigator.onLine;
    banner.classList.toggle('show', !online);
    const q = queueLength();
    const live = wsIsConnected();
    const liveTag = online ? (live ? 'REALTIME' : 'POLLING') : 'OFFLINE';
    const state = document.getElementById('system-state');
    if (state) state.textContent = online ? (live ? 'SYSTEM ONLINE' : 'SYSTEM CONNECTING') : 'SYSTEM OFFLINE';
    const liveDot = document.querySelector('.status-pulse');
    if (liveDot) liveDot.classList.toggle('is-offline', !online);
    indicator.innerHTML = online
      ? (q ? '<span class="dot warn"></span> online · ' + liveTag.toLowerCase() + ' · ' + q + ' queued' : '<span class="dot ' + (live ? 'ok' : 'warn') + '"></span> online · ' + liveTag.toLowerCase())
      : '<span class="dot err"></span> offline' + (q ? ' · ' + q + ' queued' : '');

    const voice = document.querySelector('.voice-toggle');
    if (voice) voice.title = 'Speak Out is ' + (localStorage.getItem('xoft_speak_out_enabled') !== 'false' ? 'on' : 'off');
  }

  window.addEventListener('online', () => { paint(); wsConnect(); });
  window.addEventListener('offline', paint);
  wsEvents.addEventListener('open', paint);
  wsEvents.addEventListener('close', paint);
  events.addEventListener('queued', () => { paint(); toast('Offline — request queued', 'warn'); });
  events.addEventListener('queue-flushed', (e) => { paint(); if (e.detail.remaining === 0) toast('Back online — queue synced', 'ok'); });
  paint();
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* offline shell is best-effort */ });
  }
}

for (const g of NAV) for (const [route, , mod] of g.items) registerRoute(route, mod);

buildSidebar();
wireConnectivity();
registerServiceWorker();
wsConnect();
startRouter();
