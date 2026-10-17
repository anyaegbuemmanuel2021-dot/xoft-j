import { esc } from '../dom.js';
import { fmtClock, filterLog, logEntryText } from './logic.js';

const MODES = ['ALL', 'WARN', 'ERROR'];

export function mountSystemLog(el, store) {
  let mode = 'ALL';
  let clearedAt = 0; // CLEAR hides what is on screen only — the server's audit log is never modified

  function paint() {
    const { entries, error, stale } = store.get('log');
    const shown = filterLog(entries.filter((e) => Date.parse(e.ts) > clearedAt), mode).slice(0, 8);
    el.innerHTML = `
      <div class="cc-actions cc-actions-top" role="group" aria-label="System log controls">
        <button type="button" data-act="filter" aria-label="Filter: ${mode}. Activate to change filter">FILTER: ${mode}</button>
        <button type="button" data-act="clear">CLEAR</button>
        <button type="button" data-act="open">OPEN LOGS</button>
      </div>
      ${error && !entries.length ? `<div class="cc-empty">Log unavailable: ${esc(error)}</div>` : shown.length
        ? `<ul class="cc-feed cc-log" aria-label="System log">${shown.map((e) => `<li data-tone="${e.sev === 'err' ? 'err' : e.sev === 'warn' ? 'warn' : 'info'}"><time class="cc-num">${fmtClock(e.ts)}</time><span class="cc-trunc2">${esc(logEntryText(e))}</span></li>`).join('')}</ul>`
        : '<div class="cc-empty">No matching log entries.</div>'}
      ${stale ? '<div class="cc-note" role="status">Showing cached log</div>' : ''}`;
  }

  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'filter') { mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length]; paint(); }
    if (act === 'clear') { clearedAt = Date.now(); paint(); }
    if (act === 'open') location.hash = '#activity';
  });
  paint();
  return store.subscribe('log', paint);
}
