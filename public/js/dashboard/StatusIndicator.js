import { esc } from '../dom.js';

/** ● LABEL — tone: ok | warn | err | idle | off. Color is never the only signal: the label text is always present. */
export function statusIndicator(label, tone = 'idle') {
  return `<span class="cc-status" data-tone="${esc(tone)}"><span class="cc-dot" aria-hidden="true"></span><span>${esc(label)}</span></span>`;
}
