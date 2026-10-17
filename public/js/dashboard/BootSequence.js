import { api } from '../api.js';
import { esc } from '../dom.js';
import { BOOT_KEY, shouldRunFullBoot, normalizeList } from './logic.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * First-load sequence. The READY/ONLINE lines are real checks (healthz,
 * status, memory, tools), not a timed script — a failed check shows its real
 * state and the dashboard still opens. Returning users see a short
 * "XOFT READY" flash (preference stored in localStorage); click/Enter/Escape
 * skips it at any time.
 */
export async function runBoot(container, { onAuthChecked } = {}) {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const full = shouldRunFullBoot(localStorage, reduced);
  const overlay = document.createElement('div');
  overlay.className = 'cc-boot';
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  overlay.tabIndex = -1;
  overlay.innerHTML = '<div class="cc-boot-inner"><div class="cc-boot-title">XOFT</div><div class="cc-boot-lines"></div><div class="cc-muted cc-boot-skip">press any key to skip</div></div>';
  container.appendChild(overlay);
  overlay.focus();
  const lines = overlay.querySelector('.cc-boot-lines');
  let skipped = false;
  const skip = () => { skipped = true; };
  overlay.addEventListener('click', skip);
  overlay.addEventListener('keydown', skip);

  const add = (label, value, tone = 'ok') => { lines.insertAdjacentHTML('beforeend', `<div class="cc-boot-line" data-tone="${tone}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`); };
  const step = full && !skipped ? 240 : 0;

  add('XOFT', 'INITIALIZING CORE...', 'idle');
  // One authenticated call first, so an API-key prompt (existing behavior in api.js) happens once, not in parallel.
  let status = null;
  try { status = await api.get('/api/status'); } catch { /* reported below */ }
  onAuthChecked?.(); // the caller starts loading dashboard data now that the key (if any) is settled
  const [health, mem, tools] = await Promise.all([
    fetch('/healthz').then((r) => r.ok).catch(() => false),
    api.get('/api/memory').then(normalizeList).catch(() => null),
    api.get('/api/tools').then(normalizeList).catch(() => null),
  ]);

  const results = [
    ['SYSTEM', health ? 'ONLINE' : 'UNREACHABLE', health ? 'ok' : 'err'],
    ['AI PROVIDERS', !status ? 'UNAVAILABLE' : status.configuredProviders?.length ? `READY (${status.configuredProviders.length})` : 'NONE CONFIGURED', !status ? 'err' : status.configuredProviders?.length ? 'ok' : 'warn'],
    ['MEMORY', mem ? `CONNECTED (${mem.length})` : 'UNAVAILABLE', mem ? 'ok' : 'err'],
    ['AGENTS', tools?.length ? `READY (${tools.length} tools)` : 'UNAVAILABLE', tools?.length ? 'ok' : 'err'],
  ];
  // Returning users (or reduced-motion) skip the per-subsystem lines; failures are still surfaced in the final line.
  if (full) {
    for (const [l, v, t] of results) {
      add(l, v, t);
      if (!skipped && step) await wait(step);
    }
  }
  const allOk = results.every((r) => r[2] === 'ok');
  add('XOFT', allOk ? 'READY' : 'READY (WITH WARNINGS)', allOk ? 'ok' : 'warn');
  await wait(skipped || reduced ? 150 : full ? 450 : 350);

  try { localStorage.setItem(BOOT_KEY, '1'); } catch { /* preference is best-effort */ }
  overlay.classList.add('cc-boot-out');
  await wait(reduced ? 0 : 220);
  overlay.remove();
}
