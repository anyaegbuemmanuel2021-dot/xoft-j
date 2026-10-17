import { esc } from '../dom.js';
import { fmtBytes, fmtDuration } from './logic.js';
import { statusIndicator } from './StatusIndicator.js';
import { telemetryGraph } from './TelemetryGraph.js';

function meter(label, pct, detail, history, graphLabel) {
  const has = pct !== null && pct !== undefined;
  const tone = !has ? 'idle' : pct >= 90 ? 'err' : pct >= 75 ? 'warn' : 'ok';
  return `
    <div class="cc-metric">
      <div class="cc-metric-head"><span>${label}</span><span class="cc-num">${has ? pct + '%' : 'unavailable'}</span></div>
      <div class="cc-bar" role="meter" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" ${has ? `aria-valuenow="${pct}"` : ''} data-tone="${tone}"><i style="width:${has ? pct : 0}%"></i></div>
      <div class="cc-metric-foot"><span class="cc-muted">${esc(detail)}</span>${history ? telemetryGraph(history, { label: graphLabel }) : ''}</div>
    </div>`;
}

export function mountSystemStatus(el, store) {
  function paint() {
    const { data: t, stale, error } = store.get('telemetry');
    const conn = store.get('conn');
    const hist = store.get('telemetryHistory');
    const status = store.get('status').data;
    if (!t) {
      el.innerHTML = `<div class="cc-empty">${error ? 'Telemetry unavailable: ' + esc(error) : 'Reading system…'}</div>`;
      return;
    }
    const server = conn.online && !error ? statusIndicator(stale ? 'STALE' : 'ONLINE', stale ? 'warn' : 'ok') : statusIndicator('UNREACHABLE', 'err');
    const net = !conn.online ? statusIndicator('OFFLINE', 'err') : conn.ws === 'live' ? statusIndicator('LIVE', 'ok') : statusIndicator('RECONNECTING', 'warn');
    el.innerHTML = `
      ${meter('CPU', t.cpu?.percent, `${t.cpu?.cores ?? '?'} cores · load ${t.cpu?.load1?.toFixed?.(2) ?? '—'}`, hist.cpu, 'CPU history')}
      ${meter('MEMORY', t.memory?.usedPercent, `${fmtBytes(t.memory?.usedBytes)} / ${fmtBytes(t.memory?.totalBytes)}`, hist.mem, 'Memory history')}
      ${meter('STORAGE', t.storage?.usedPercent, t.storage ? `${fmtBytes(t.storage.usedBytes)} / ${fmtBytes(t.storage.totalBytes)}` : 'not readable on this platform')}
      <dl class="cc-kv">
        <div><dt>NETWORK</dt><dd>${net}</dd></div>
        <div><dt>UPTIME</dt><dd class="cc-num">${fmtDuration(t.uptime?.processSeconds)}</dd></div>
        <div><dt>SERVER</dt><dd>${server}</dd></div>
        <div><dt>PLATFORM</dt><dd class="cc-num">${esc(t.platform)}</dd></div>
        ${status ? `<div><dt>AUTONOMY</dt><dd class="cc-num">${esc(status.autonomy?.label ?? '—')}</dd></div>` : ''}
      </dl>`;
  }
  paint();
  return store.subscribe(['telemetry', 'telemetryHistory', 'conn', 'status'], paint);
}
