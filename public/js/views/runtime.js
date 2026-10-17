// runtime.js — Device Runtime view: DEVICE · PERMISSIONS · AUTONOMY · WORKSPACES · FILES · BROWSER · APPLICATIONS · OPERATIONS/RECOVERY · VOICE.
// Every action goes through /api/tools/:name/execute (permission + emergency-stop gated) to the real agent; nothing here fakes a result.
import { api } from '../api.js';
import { card, badge, rows, fmtTime, esc, toast } from '../dom.js';

export const title = 'Device Runtime';
export let cleanup = null;

const NAMESPACES = [['browser', 'Browser control'], ['files', 'Files (read/write/move/delete)'], ['workspace', 'Workspaces'], ['operations', 'Journal & undo'], ['terminal', 'Terminal (allowlisted)'], ['runtime', 'Halt control']];
const DOMAINS = ['files', 'browser', 'terminal', 'devices'];
const key = () => localStorage.getItem('xoft_api_key') || '';

// Direct fetch, deliberately NOT api.post: api.js queues failed/offline POSTs for later replay, and a file delete or
// terminal command must never be silently replayed after the moment the user clicked it.
async function tool(name, deviceId, input = {}) {
  const res = await fetch(`/api/tools/${encodeURIComponent(name)}/execute`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key() ? { 'X-API-Key': key() } : {}) }, body: JSON.stringify({ deviceId, input: { deviceId, ...input } }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) throw new Error(body.error ?? `request failed (${res.status})`);
  const r = body.result; // DeviceManager structured result
  if (r && r.success === false) throw new Error(r.error ?? 'the device reported a failure');
  return r?.result ?? r;
}
const direct = async (method, path, payload) => {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(key() ? { 'X-API-Key': key() } : {}) }, body: payload ? JSON.stringify(payload) : undefined });
  const body = await res.json().catch(() => ({})); if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`); return body;
};

export async function render(container) {
  // dom.js onDelegate() stacks a new listener on every re-render of the same container, which would double-fire clicks (double
  // confirm dialogs, double grants). Scope this view's listeners to an AbortController that is replaced on each render.
  container._rtAbort?.abort(); const ac = new AbortController(); container._rtAbort = ac;
  const onDelegate = (c, event, selector, handler) => c.addEventListener(event, (e) => { const el = e.target.closest(selector); if (el && c.contains(el)) handler(el, e); }, { signal: ac.signal });
  const [devices, autonomy] = await Promise.all([api.get('/api/runtime/devices').catch(() => []), api.get('/api/autonomy/domains').catch(() => ({ overrides: {}, global: 2 }))]);
  const list = Array.isArray(devices) ? devices : [];
  let sel = list.find((d) => d.deviceId === container.dataset.sel)?.deviceId ?? list.find((d) => d.online)?.deviceId ?? list[0]?.deviceId ?? null;
  const perms = sel ? await api.get(`/api/devices/${sel}/permissions`).catch(() => []) : [];
  const granted = (ns) => (Array.isArray(perms) ? perms : []).find((p) => p.permission === ns);
  const dev = list.find((d) => d.deviceId === sel);
  const rt = dev?.runtime;

  container.innerHTML = `
    ${card('Device', list.length ? `
      <div class="form-row"><label>Device</label><select id="rt-dev">${list.map((d) => `<option value="${esc(d.deviceId)}" ${d.deviceId === sel ? 'selected' : ''}>${esc(d.name)} ${d.online ? '' : '(offline)'}</option>`).join('')}</select></div>
      <div>${dev.online ? badge('online', 'ok') : badge('offline', 'err')} ${dev.trust === 'trusted' ? badge('trusted', 'ok') : badge(dev.trust, 'warn')} ${rt?.halted ? badge('HALTED', 'err') : badge('running', 'ok')} ${rt?.browser?.ok ? badge('browser reachable', 'ok') : badge('browser not reachable', 'warn')}</div>
      <p class="muted">Active workspace: <b>${esc(rt?.activeWorkspace ?? 'none')}</b> · Interrupted operations: <b>${rt?.interruptedOperations ?? '—'}</b> · Last seen ${esc(fmtTime(dev.lastActiveAt))}</p>
      <button id="rt-halt" class="danger">HALT ALL ACTIONS ON THIS DEVICE</button>
      <p class="muted">Halt kills running terminal processes and blocks every action. Resuming is deliberately local only: run <code>node src/index.js --resume</code> on the device (or delete its <code>.xoft/HALT</code> file). The core emergency stop also halts every agent within seconds.</p>`
      : '<div class="empty">No Device Runtime agent has connected yet. Start the pc-agent (see docs/DEVICE_RUNTIME.md), then trust the device on the Devices page.</div>')}

    ${sel ? card('Permissions for this device', `<p class="muted">Nothing works until you grant it. Time-boxed grants expire on their own.</p>
      ${NAMESPACES.map(([ns, label]) => { const g = granted(ns); return `<div class="form-row" style="display:flex;gap:8px;align-items:center;justify-content:space-between"><span>${esc(label)} ${g ? badge(g.expiresAt ? `until ${fmtTime(g.expiresAt)}` : 'granted', 'ok') : badge('not granted', '')}</span><span>
        ${g ? `<button data-revoke="${ns}">Revoke</button>` : `<select data-ttl="${ns}"><option value="60">1 hour</option><option value="240" selected>4 hours</option><option value="1440">24 hours</option><option value="">until revoked</option></select> <button data-grant="${ns}" class="primary">Grant</button>`}</span></div>`; }).join('')}
      <p class="muted">Note: granting <b>Files</b> covers delete/move too (deletes are recoverable and ask for approval by default). Sensitive files (.env, keys, tokens) are unreadable regardless.</p>`) : ''}

    ${card('Autonomy per domain', `<p class="muted">Global level ${autonomy.global}. Override per domain (0 = always ask … 5 = mission autonomy). Deletes, undo and terminal commands still follow the approval rules.</p>
      ${DOMAINS.map((d) => `<div class="form-row" style="display:flex;gap:8px;align-items:center"><label style="min-width:90px">${d}</label><input type="range" min="0" max="5" value="${autonomy.overrides?.[d] ?? autonomy.global}" data-level="${d}" style="flex:1" /><b data-level-out="${d}">${autonomy.overrides?.[d] ?? autonomy.global}</b> <button data-setlevel="${d}">Set</button> <button data-clearlevel="${d}">Clear</button></div>`).join('')}`)}

    ${sel ? card('Workspaces', `<div id="ws-out" class="muted">Loading…</div><p class="muted">Workspaces can only be added on the device itself: <code>node src/index.js --add-workspace &lt;name&gt; &lt;path&gt;</code>. XOFT cannot widen its own reach.</p>`) : ''}
    ${sel ? card('Files', `<div class="form-row"><input id="f-q" placeholder="Search name, glob (*.js) or text, e.g. browser executor" style="width:100%" /></div>
      <div><button id="f-locate" class="primary">Locate</button> <button id="f-name">Search names</button> <button id="f-content">Search contents</button></div><div id="f-out" style="margin-top:8px"></div>`, { span2: true }) : ''}
    ${sel ? card('Browser', `<div><button id="b-tabs" class="primary">List tabs</button> <button id="b-page">Current page</button> <button id="b-shot">Screenshot</button> <button id="b-recover">Reconnect</button></div><div id="b-out" style="margin-top:8px"></div>
      <p class="muted">Needs Chrome/Chromium started with remote debugging (see docs). XOFT never runs arbitrary JavaScript in your pages.</p>`, { span2: true }) : ''}
    ${sel ? card('Applications', `<button id="a-list">List running applications</button><div id="a-out" style="margin-top:8px"></div>`) : ''}
    ${sel ? card('Operations & recovery', `<div><button id="o-refresh" class="primary">Refresh</button> <button id="o-undo">Undo the last operation</button></div><div id="o-out" style="margin-top:8px"></div>`, { span2: true }) : ''}
    ${card('Voice', `<p>The Companion runs in your browser (microphone stays on this device, local voice-activity detection, wake phrase "Hey Xoft").</p><a href="/companion.html" target="_blank" rel="noopener"><button class="primary">Open Voice Companion</button></a>
      <p class="muted">Voice commands use the same chat entry point as typed ones, so permissions, approvals and the kill switch apply identically. Risky verbs (delete, deploy, send…) need spoken or tapped confirmation.</p>`)}
  `;

  const out = (id, html) => { const el = container.querySelector(id); if (el) el.innerHTML = html; };
  const fail = (id) => (err) => out(id, `<div class="empty" style="color:#f87171">${esc(err.message)}</div>`);
  const pre = (t) => `<pre style="max-height:320px;overflow:auto;white-space:pre-wrap">${esc(t)}</pre>`;

  container.querySelector('#rt-dev')?.addEventListener('change', (e) => { container.dataset.sel = e.target.value; sel = e.target.value; render(container); });
  onDelegate(container, 'click', '#rt-halt', async () => { if (!window.confirm('Halt ALL actions on this device now? Only a human at the device can resume.')) return; try { const r = await direct('POST', '/api/runtime/halt', { deviceId: sel, reason: 'halt from dashboard' }); toast(r.results?.every((x) => x.success) ? 'Device halted' : 'Halt sent — verify on the device', r.results?.every((x) => x.success) ? 'ok' : 'warn'); } catch (e) { toast(e.message, 'err'); } render(container); });
  onDelegate(container, 'click', '[data-grant]', async (el) => { const ns = el.dataset.grant; const ttl = container.querySelector(`[data-ttl="${ns}"]`)?.value; try { await direct('POST', `/api/devices/${sel}/permissions`, { permission: ns, ...(ttl ? { ttlMinutes: Number(ttl) } : {}) }); toast(`Granted ${ns}`, 'ok'); } catch (e) { toast(e.message, 'err'); } render(container); });
  onDelegate(container, 'click', '[data-revoke]', async (el) => { try { await direct('DELETE', `/api/devices/${sel}/permissions/${el.dataset.revoke}`); toast('Revoked', 'ok'); } catch (e) { toast(e.message, 'err'); } render(container); });
  container.querySelectorAll('[data-level]').forEach((r) => r.addEventListener('input', () => { container.querySelector(`[data-level-out="${r.dataset.level}"]`).textContent = r.value; }));
  onDelegate(container, 'click', '[data-setlevel]', async (el) => { const d = el.dataset.setlevel; try { await direct('POST', `/api/autonomy/domains/${d}`, { level: Number(container.querySelector(`[data-level="${d}"]`).value), reason: 'set from Device Runtime view' }); toast(`${d} autonomy updated`, 'ok'); } catch (e) { toast(e.message, 'err'); } });
  onDelegate(container, 'click', '[data-clearlevel]', async (el) => { try { await direct('DELETE', `/api/autonomy/domains/${el.dataset.clearlevel}`); toast('Override cleared', 'ok'); } catch (e) { toast(e.message, 'err'); } render(container); });

  if (!sel) { cleanup = () => ac.abort(); return; }
  tool('workspace_list', sel).then((r) => out('#ws-out', rows(r.workspaces, (w) => `<div>${w.active ? badge('active', 'ok') : `<button data-ws="${esc(w.name)}">Use</button>`} <b>${esc(w.name)}</b> <span class="muted">${esc(w.root)}</span> <button data-wsinspect="${esc(w.name)}">Inspect</button></div>`, 'No workspaces registered on the device — file and terminal work is disabled until you add one.'))).catch(fail('#ws-out'));
  onDelegate(container, 'click', '[data-ws]', async (el) => { try { await tool('workspace_set_active', sel, { name: el.dataset.ws }); toast('Active workspace set', 'ok'); } catch (e) { toast(e.message, 'err'); } render(container); });
  onDelegate(container, 'click', '[data-wsinspect]', async (el) => { try { const r = await tool('workspace_inspect', sel, { name: el.dataset.wsinspect }); out('#ws-out', pre(JSON.stringify({ type: r.type, packageManager: r.packageManager, commands: r.commands, entryPoints: r.entryPoints, scripts: r.scripts, dependencies: r.dependencies }, null, 2))); } catch (e) { fail('#ws-out')(e); } });

  const q = () => container.querySelector('#f-q').value.trim();
  const showFiles = (r) => out('#f-out', [
    ...(r.projects ?? []).map((p) => `<div>${badge('project', 'ok')} <b>${esc(p.name)}</b> <span class="muted">${esc(p.type)} · ${esc(p.path)}</span></div>`),
    ...(r.files ?? r.matches ?? []).map((f) => `<div>${f.sensitive ? badge('protected', 'warn') : `<button data-fread="${esc(f.path)}">Read</button> <button data-finspect="${esc(f.path)}">Inspect</button>`} <span>${esc(f.path)}</span>${f.hits ? `<div class="muted">${f.hits.map((h) => `L${h.line}: ${esc(h.snippet)}`).join('<br>')}</div>` : ''}</div>`),
  ].join('') || '<div class="empty">No matches.</div>');
  onDelegate(container, 'click', '#f-locate', () => q() && tool('file_locate', sel, { query: q() }).then(showFiles).catch(fail('#f-out')));
  onDelegate(container, 'click', '#f-name', () => q() && tool('file_search', sel, { query: q(), kind: 'name' }).then(showFiles).catch(fail('#f-out')));
  onDelegate(container, 'click', '#f-content', () => q() && tool('file_search', sel, { query: q(), kind: 'content' }).then(showFiles).catch(fail('#f-out')));
  onDelegate(container, 'click', '[data-fread]', (el) => tool('file_read', sel, { path: el.dataset.fread }).then((r) => out('#f-out', `<div class="muted">${esc(r.path)} · lines ${r.startLine}-${r.endLine}${r.redactions ? ` · ${r.redactions} secret(s) redacted` : ''}</div>${pre(r.content)}`)).catch(fail('#f-out')));
  onDelegate(container, 'click', '[data-finspect]', (el) => tool('file_inspect', sel, { path: el.dataset.finspect }).then((r) => out('#f-out', pre(JSON.stringify(r, null, 2)))).catch(fail('#f-out')));

  onDelegate(container, 'click', '#b-tabs', () => tool('browser_list_tabs', sel).then((r) => out('#b-out', rows(r.tabs, (t) => `<div>${t.attached ? badge('attached', 'ok') : `<button data-attach="${esc(t.id)}">Attach</button>`} <b>${esc(t.title || '(untitled)')}</b> <span class="muted">${esc(t.url)}</span></div>`, 'No tabs.'))).catch(fail('#b-out')));
  onDelegate(container, 'click', '[data-attach]', (el) => tool('browser_attach_tab', sel, { tabId: el.dataset.attach }).then(() => toast('Attached', 'ok')).catch((e) => toast(e.message, 'err')));
  onDelegate(container, 'click', '#b-page', () => tool('browser_get_page', sel).then((r) => out('#b-out', pre(JSON.stringify(r, null, 2)))).catch(fail('#b-out')));
  onDelegate(container, 'click', '#b-shot', () => tool('browser_screenshot', sel, {}).then((r) => out('#b-out', `<img alt="browser screenshot" style="max-width:100%;border:1px solid #234" src="data:image/png;base64,${esc(r.base64)}" />`)).catch(fail('#b-out')));
  onDelegate(container, 'click', '#b-recover', () => tool('runtime_recover_browser', sel).then(() => toast('Browser connection re-established', 'ok')).catch((e) => toast(e.message, 'err')));
  onDelegate(container, 'click', '#a-list', () => tool('device_list_apps', sel).then((r) => out('#a-out', rows((r.apps ?? []).slice(0, 80), (a) => `<div>${esc(a.name)} <span class="muted">pid ${esc(a.pid)}</span></div>`, 'None reported.'))).catch(fail('#a-out')));

  const loadOps = () => tool('operations_list', sel, { limit: 40 }).then((r) => out('#o-out', rows(r.operations, (o) => `<div style="border-top:1px solid #1c2b30;padding:6px 0">${badge(o.action, '')} ${o.status === 'completed' ? badge('ok', 'ok') : badge(o.status, o.status === 'failed' ? 'err' : 'warn')} <b>#${esc(o.id)}</b> <span>${esc(o.target)}</span><div class="muted">${esc(fmtTime(o.ts))}${o.reason ? ` · ${esc(o.reason)}` : ''}${o.missionId ? ` · mission ${esc(o.missionId)}` : ''} · ${esc(o.agent)}${o.tests ? ` · tests ${o.tests.passed ? 'PASSED' : 'FAILED'}` : ''}</div>${o.rollback?.available && !o.rolledBackBy ? `<button data-undo="${esc(o.id)}">Rollback</button>` : o.rolledBackBy ? `<span class="muted">rolled back by #${esc(o.rolledBackBy)}</span>` : ''}</div>`, 'No operations recorded yet.'))).catch(fail('#o-out'));
  onDelegate(container, 'click', '#o-refresh', loadOps);
  onDelegate(container, 'click', '[data-undo]', async (el) => { if (!window.confirm(`Roll back operation #${el.dataset.undo}? It refuses if the file changed since.`)) return; try { await tool('file_restore', sel, { operationId: Number(el.dataset.undo) }); toast('Rolled back', 'ok'); } catch (e) { toast(e.message, 'err'); } loadOps(); });
  onDelegate(container, 'click', '#o-undo', async () => { if (!window.confirm('Undo the most recent rollback-able operation?')) return; try { await tool('file_undo_last', sel); toast('Undone', 'ok'); } catch (e) { toast(e.message, 'err'); } loadOps(); });
  loadOps();
  cleanup = () => ac.abort();
}
