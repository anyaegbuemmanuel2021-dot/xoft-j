import { esc } from '../dom.js';
import { statusIndicator } from './StatusIndicator.js';

export function mountMemory(el, store) {
  function paint() {
    const mem = store.get('memory');
    const kg = store.get('kgStats');
    const status = store.get('status').data;
    if (mem.error && !mem.data.length) { el.innerHTML = `<div class="cc-empty">Memory unavailable: ${esc(mem.error)}</div>`; return; }
    const recent = mem.data.slice(-3).reverse();
    el.innerHTML = `
      <dl class="cc-kv">
        <div><dt>STATUS</dt><dd>${statusIndicator(mem.error ? 'ERROR' : mem.stale ? 'CACHED' : 'CONNECTED', mem.error ? 'err' : mem.stale ? 'warn' : 'ok')}</dd></div>
        <div><dt>ENTRIES</dt><dd class="cc-num">${mem.data.length}</dd></div>
        <div><dt>SEMANTIC</dt><dd class="cc-num">${status ? (status.vectorMemoryEnabled ? 'ON' : 'OFF') : '—'}</dd></div>
        <div><dt>GRAPH</dt><dd class="cc-num">${kg.data ? `${kg.data.nodeCount} nodes · ${kg.data.edgeCount} edges` : kg.error ? 'unavailable' : '…'}</dd></div>
      </dl>
      ${recent.length ? `<ul class="cc-list cc-compact">${recent.map((m) => `<li class="cc-line"><span class="cc-tag">${esc(m.category ?? 'memory')}</span><span class="cc-trunc">${esc(m.content ?? '')}</span></li>`).join('')}</ul>` : '<div class="cc-empty">No memories stored yet.</div>'}
      <div class="cc-actions"><button type="button" data-nav="memory">OPEN MEMORY</button></div>`;
  }
  el.addEventListener('click', (e) => { if (e.target.closest('[data-nav="memory"]')) location.hash = '#memory'; });
  paint();
  return store.subscribe(['memory', 'kgStats', 'status'], paint);
}
