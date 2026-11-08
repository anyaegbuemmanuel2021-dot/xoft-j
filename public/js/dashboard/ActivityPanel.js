import { esc } from '../dom.js';
import { fmtClock } from './logic.js';

export function mountActivity(el, store) {
  function paint() {
    const items = store.get('activity');
    const ws = store.get('conn').ws;
    el.innerHTML = items.length
      ? `<ol class="cc-feed" aria-label="Live activity, newest first">${items.slice(0, 12).map((a) => `<li data-tone="${esc(a.tone)}"><time class="cc-num">${fmtClock(a.ts)}</time><span>${esc(a.text)}</span></li>`).join('')}</ol>`
      : `<div class="cc-empty">${ws === 'live' ? 'Listening for events…' : 'Waiting for the live connection…'}</div>`;
  }
  paint();
  return store.subscribe(['activity', 'conn'], paint);
}
