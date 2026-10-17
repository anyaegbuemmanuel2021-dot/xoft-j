import { esc } from '../dom.js';
import { CORE_BLURB, currentModel, pickCurrentTask } from './logic.js';

// The core is SVG + CSS animation only (no canvas, no requestAnimationFrame).
// All motion is driven by the data-state attribute on the root element; the
// stylesheet slows/stops it under prefers-reduced-motion.
function coreSvg() {
  const ticks = Array.from({ length: 60 }, (_, i) => {
    const a = (i / 60) * Math.PI * 2;
    const long = i % 5 === 0;
    const r1 = 178; const r2 = long ? 168 : 173;
    return `<line x1="${(200 + Math.cos(a) * r1).toFixed(1)}" y1="${(200 + Math.sin(a) * r1).toFixed(1)}" x2="${(200 + Math.cos(a) * r2).toFixed(1)}" y2="${(200 + Math.sin(a) * r2).toFixed(1)}"/>`;
  }).join('');
  return `
  <svg class="cc-core-svg" viewBox="0 0 400 400" aria-hidden="true" focusable="false">
    <circle class="cc-verify-pulse" cx="200" cy="200" r="120"/>
    <g class="cc-ring cc-ring-ticks">${ticks}</g>
    <g class="cc-ring cc-ring-a"><circle cx="200" cy="200" r="150" stroke-dasharray="2 9"/><circle cx="200" cy="200" r="150" stroke-dasharray="90 400" class="cc-arc"/></g>
    <g class="cc-ring cc-ring-b"><circle cx="200" cy="200" r="122" stroke-dasharray="40 14 4 14"/></g>
    <g class="cc-ring cc-ring-c"><circle cx="200" cy="200" r="96" stroke-dasharray="130 80" class="cc-arc"/></g>
    <g class="cc-orbit cc-orbit-1"><circle cx="200" cy="50" r="4" class="cc-particle"/></g>
    <g class="cc-orbit cc-orbit-2"><circle cx="200" cy="78" r="3" class="cc-particle"/><circle cx="200" cy="322" r="2.5" class="cc-particle"/></g>
    <g class="cc-orbit cc-orbit-3"><circle cx="104" cy="200" r="3" class="cc-particle"/></g>
    <circle class="cc-hub" cx="200" cy="200" r="64"/>
    <circle class="cc-hub-core" cx="200" cy="200" r="46"/>
    <path class="cc-glyph" d="M176 176 L224 224 M224 176 L176 224"/>
  </svg>`;
}

export function mountXoftCore(el, store) {
  el.innerHTML = `
    <div class="cc-core" data-state="IDLE">
      ${coreSvg()}
      <div class="cc-core-readout" role="status" aria-live="polite" aria-atomic="true">
        <span class="cc-core-brand">XOFT CORE</span>
        <span class="cc-core-state" data-core-state>IDLE</span>
        <span class="cc-core-blurb cc-trunc" data-core-blurb>${CORE_BLURB.IDLE}</span>
      </div>
    </div>
    <div class="cc-core-meta" data-core-meta></div>`;
  const root = el.querySelector('.cc-core');
  const stateEl = el.querySelector('[data-core-state]');
  const blurbEl = el.querySelector('[data-core-blurb]');
  const metaEl = el.querySelector('[data-core-meta]');

  function paintState() {
    const s = store.get('core');
    root.dataset.state = s;
    stateEl.textContent = s;
    const task = pickCurrentTask(store.get('tasks').data);
    const emergency = store.get('status').data?.emergencyStop?.active;
    blurbEl.textContent = emergency ? 'Emergency stop is active' : (s !== 'IDLE' && task ? String(task.goal).slice(0, 60) : CORE_BLURB[s]);
  }
  function paintMeta() {
    const providers = store.get('providers').data;
    const online = providers.filter((p) => p.configured && p.status === 'AVAILABLE').length;
    const configured = providers.filter((p) => p.configured).length;
    const running = store.get('tasks').data.filter((t) => t.status === 'running').length;
    const m = currentModel(providers);
    metaEl.innerHTML = `
      <span><b>MODEL</b> ${esc(m ? m.model : '—')}</span>
      <span><b>PROVIDERS</b> ${configured} configured · ${online} verified</span>
      <span><b>RUNNING</b> ${running}</span>`;
  }
  paintState(); paintMeta();
  const u1 = store.subscribe(['core', 'tasks', 'status'], paintState);
  const u2 = store.subscribe(['providers', 'tasks'], paintMeta);
  return () => { u1(); u2(); };
}
