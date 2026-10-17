import { api } from '../api.js';
import { card, rows, fmtTime, esc, onDelegate, debounce } from '../dom.js';
import { onEvent } from '../ws.js';

export const title = 'Activity';
export let cleanup = null;
let tab = 'log';

export async function render(container) {
  container.innerHTML = `
    <div class="tabs">
      <button data-tab="log" class="${tab === 'log' ? 'active' : ''}">Activity log</button>
      <button data-tab="events" class="${tab === 'events' ? 'active' : ''}">Event stream</button>
    </div>
    <div id="tab-body"><div class="empty">Loading…</div></div>
  `;
  onDelegate(container, 'click', '[data-tab]', (el) => { tab = el.dataset.tab; render(container); });

  const body = container.querySelector('#tab-body');
  if (tab === 'log') {
    const entries = await api.get('/api/activity');
    body.innerHTML = card(`Recent activity (${entries.length})`, rows(entries.slice().reverse().slice(0, 200), logRow, 'Nothing logged yet.'));
    const refresh = debounce(() => render(container), 600);
    cleanup = onEvent(['*'], refresh);
  } else {
    const events = await api.get('/api/events?limit=100');
    const list = events.slice().reverse();
    body.innerHTML = card(`Recent events (${list.length})`, rows(list, eventRow, 'No events yet.'), { id: 'events-card' });
    // Genuinely live here, no re-fetch: prepend each incoming event as it
    // arrives instead of waiting for a debounced full reload.
    cleanup = onEvent(['*'], (event) => {
      const listEl = body.querySelector('#events-card');
      const empty = listEl.querySelector('.empty');
      if (empty) empty.remove();
      listEl.insertAdjacentHTML('beforeend', eventRow(event));
    });
  }
}

function logRow(e) {
  return `
    <div class="row" style="flex-direction:column; align-items:stretch;">
      <div class="main">${esc(e.type)}</div>
      <div class="muted" style="margin:2px 0;">${fmtTime(e.timestamp ?? e.createdAt)}${e.taskId ? ' · task ' + e.taskId.slice(0, 8) : ''}</div>
      ${e.detail ? `<pre>${esc(JSON.stringify(e.detail)).slice(0, 300)}</pre>` : ''}
    </div>
  `;
}

function eventRow(e) {
  return `
    <div class="row" style="flex-direction:column; align-items:stretch;">
      <div class="main">${esc(e.type)}</div>
      <div class="muted" style="margin:2px 0;">${fmtTime(e.ts)}</div>
      ${e.payload ? `<pre>${esc(JSON.stringify(e.payload)).slice(0, 300)}</pre>` : ''}
    </div>
  `;
}
