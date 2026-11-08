import { esc } from '../dom.js';
import { statusIndicator } from './StatusIndicator.js';
import { diagTone } from './logic.js';

export function mountDiagnostics(el, store) {
  function paint() {
    const { data, error } = store.get('diagnostics');
    if (!data) { el.innerHTML = `<div class="cc-empty">${error ? 'Diagnostics unavailable: ' + esc(error) : 'Running checks…'}</div>`; return; }
    el.innerHTML = `
      <div class="cc-diag-overall">${statusIndicator(data.overall, diagTone(data.overall))}</div>
      <ul class="cc-list">${data.checks.map((c) => `<li class="cc-line cc-diag-line"><span class="cc-diag-name">${esc(c.name.replace(/_/g, ' '))}</span>${statusIndicator(c.level, diagTone(c.level))}<span class="cc-muted cc-trunc cc-diag-detail" title="${esc(c.detail)}">${esc(c.detail)}</span></li>`).join('')}</ul>`;
  }
  paint();
  return store.subscribe('diagnostics', paint);
}
