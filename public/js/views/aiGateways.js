// aiGateways.js — Settings section for the OPTIONAL AI gateways (FreeLLMAPI, LiteLLM) plus the overall "is AI available" status.
// Each gateway is configured independently; leaving one unconfigured never affects the other or the rest of Xoft.
// The API key field is WRITE-ONLY: the server never returns a key (only "is set" + a masked hint), and an empty field means "leave unchanged".
import { badge, esc, toast } from '../dom.js';

const key = () => localStorage.getItem('xoft_api_key') || '';
// Direct fetch on purpose (not api.js): api.js queues failed/offline mutations for later replay, and a key save or connection test
// must happen NOW or visibly fail — never be silently replayed later.
async function call(method, path, payload) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(key() ? { 'X-API-Key': key() } : {}) }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? body.message ?? `request failed (${res.status})`);
  return body;
}

const META = {
  freellmapi: { title: 'FreeLLMAPI', hint: 'Self-hosted OpenAI-compatible proxy that pools free LLM tiers. Default http://localhost:3001/v1. Needs its unified API key (from its dashboard Keys page).', keyLabel: 'API key (required)', modelHint: 'auto, auto:fast, auto:smart, or a model id' },
  litellm: { title: 'LiteLLM', hint: 'Self-hosted OpenAI-compatible gateway to 100+ providers. Default http://localhost:4000/v1. API key = the proxy master/virtual key (optional if your proxy is open).', keyLabel: 'API key (optional)', modelHint: 'a model_name from your LiteLLM config.yaml' },
};
const STATE_TONE = { available: 'ok', starting: '', disabled: '', unconfigured: 'warn', invalid_configuration: 'err', unavailable: 'err', unhealthy: 'warn', rate_limited: 'warn', authentication_error: 'err', timeout: 'warn', server_error: 'err', cooldown: 'warn' };
const STATE_TEXT = { available: 'available', starting: 'configured — not tested yet', disabled: 'disabled', unconfigured: 'needs configuration', invalid_configuration: 'invalid configuration', unavailable: 'unavailable', unhealthy: 'unhealthy', rate_limited: 'rate limited', authentication_error: 'authentication error', timeout: 'timeout', server_error: 'server error', cooldown: 'cooling down' };

function card(id, g) {
  const m = META[id]; const s = g.status;
  return `<div class="card" data-gw="${esc(id)}" style="margin-top:12px"><h3>${esc(m.title)} <span class="muted" style="font-weight:400">— optional</span></h3>
    <p class="muted">${esc(m.hint)}</p>
    <div data-gw-status>${badge(STATE_TEXT[s.state] ?? s.state, STATE_TONE[s.state] ?? '')}${s.issue ? ` <span class="muted">${esc(s.issue)}</span>` : ''}${s.cooldownUntil ? ` <span class="muted">retry after ${esc(new Date(s.cooldownUntil).toLocaleTimeString())}</span>` : ''}${s.lastProbe ? ` <span class="muted">last test: ${esc(s.lastProbe.result)}</span>` : ''}</div>
    <div class="form-row"><label><input type="checkbox" data-f="enabled" ${g.enabled ? 'checked' : ''}/> Enabled</label></div>
    <div class="form-row"><label>Base URL</label><input data-f="baseUrl" value="${esc(g.baseUrl)}" placeholder="http://localhost:${id === 'freellmapi' ? 3001 : 4000}/v1" style="width:100%"/></div>
    <div class="form-row"><label>${esc(m.keyLabel)}</label><input data-f="apiKey" type="password" autocomplete="off" placeholder="${g.apiKeySet ? `saved (${esc(g.apiKeyMasked ?? '••••')}) — leave blank to keep` : 'not set'}" style="width:100%"/>${g.apiKeySet ? `<label class="muted"><input type="checkbox" data-f="clearKey"/> remove the saved key</label>` : ''}</div>
    <div class="form-row"><label>Model</label><input data-f="model" list="gw-models-${esc(id)}" value="${esc(g.model ?? '')}" placeholder="${esc(m.modelHint)}" style="width:100%"/><datalist id="gw-models-${esc(id)}"></datalist></div>
    <div class="form-row"><label>Embedding model <span class="muted">(optional — enables semantic memory through this gateway when OpenAI is not configured)</span></label><input data-f="embeddingModel" value="${esc(g.embeddingModel ?? '')}" style="width:100%"/></div>
    <div class="form-row"><label><input type="checkbox" data-f="tools" ${g.tools ? 'checked' : ''}/> Model supports tool calling</label> &nbsp; <label><input type="checkbox" data-f="vision" ${g.vision ? 'checked' : ''}/> Model accepts images</label></div>
    <div><button data-act="save" class="primary">Save</button> <button data-act="test">Test connection</button> <button data-act="models">Load models</button> <button data-act="reset">Reset to .env</button></div>
    <div data-gw-out class="muted" style="margin-top:8px" aria-live="polite"></div>
    <p class="muted">Settings source: ${esc(g.source)}. Saved to the server's data folder with owner-only permissions; the key is never shown again.</p></div>`;
}

/** Mounts the AI providers section into `el`. Safe to call repeatedly (listeners are scoped to an AbortController stored on the element). */
export async function mountAiGateways(el) {
  el._gwAbort?.abort(); const ac = new AbortController(); el._gwAbort = ac;
  let status = null; let gws = null; let denied = null;
  try { status = await call('GET', '/api/ai/status'); } catch { /* status is informational */ }
  try { gws = await call('GET', '/api/providers/gateways'); } catch (err) { denied = err.message; }

  const banner = status ? (status.aiAvailable
    ? `<p>${badge('AI available', 'ok')} <span class="muted">Configured: ${esc(status.configuredProviders.join(', '))}</span></p>`
    : `<p>${badge('No AI provider', 'warn')} <span class="muted">Xoft is running normally without AI. Files, devices, automations, settings and logs all work; only AI features are unavailable until a provider is configured.</span></p>`) : '';
  el.innerHTML = `<h2>AI providers — optional gateways</h2>${banner}
    <p class="muted">Xoft does not require FreeLLMAPI, LiteLLM, or any single AI provider. Configure any one, both, or neither; a problem with one never affects the others.</p>
    ${denied ? `<div class="empty">Gateway settings need the admin API key (${esc(denied)}).</div>` : `${card('freellmapi', gws.freellmapi)}${card('litellm', gws.litellm)}`}`;
  if (denied) return;

  const out = (id, html) => { const n = el.querySelector(`[data-gw="${id}"] [data-gw-out]`); if (n) n.innerHTML = html; };
  const val = (id, f) => el.querySelector(`[data-gw="${id}"] [data-f="${f}"]`);
  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const id = btn.closest('[data-gw]').dataset.gw; const act = btn.dataset.act;
    btn.disabled = true;
    try {
      if (act === 'save') {
        const patch = { enabled: val(id, 'enabled').checked, baseUrl: val(id, 'baseUrl').value.trim(), model: val(id, 'model').value.trim(), embeddingModel: val(id, 'embeddingModel').value.trim(), tools: val(id, 'tools').checked, vision: val(id, 'vision').checked };
        const k = val(id, 'apiKey').value.trim();
        if (k) patch.apiKey = k; else if (val(id, 'clearKey')?.checked) patch.apiKey = '';
        await call('PUT', `/api/providers/gateways/${id}`, patch);
        toast(`${META[id].title} saved`, 'ok');
        await mountAiGateways(el);
      } else if (act === 'test') {
        out(id, 'Testing…');
        const r = await call('POST', `/api/providers/gateways/${id}/test`);
        out(id, `${badge(r.result, r.result === 'CONNECTED' ? 'ok' : r.result === 'NOT_CONFIGURED' ? '' : 'err')} ${esc(r.message)}${r.latencyMs != null ? ` <span class="muted">(${r.latencyMs} ms)</span>` : ''}`);
        const st = el.querySelector(`[data-gw="${id}"] [data-gw-status]`);
        if (st) st.innerHTML = `${badge(STATE_TEXT[r.status.state] ?? r.status.state, STATE_TONE[r.status.state] ?? '')}`;
      } else if (act === 'models') {
        out(id, 'Loading models…');
        const r = await call('GET', `/api/providers/gateways/${id}/models`);
        if (!r.available) out(id, `Model discovery unavailable (${esc(r.reason ?? 'unknown')}${r.message ? `: ${esc(r.message)}` : ''}). You can still type a model name manually.`);
        else { el.querySelector(`#gw-models-${id}`).innerHTML = r.models.map((m) => `<option value="${esc(m.id)}"></option>`).join(''); out(id, `${r.models.length} model(s) found — pick one in the Model field, then Save.`); }
      } else if (act === 'reset') {
        if (!window.confirm(`Discard the saved ${META[id].title} settings and go back to the .env values?`)) return;
        await call('DELETE', `/api/providers/gateways/${id}`);
        toast('Reset', 'ok'); await mountAiGateways(el);
      }
    } catch (err) { out(id, `<span style="color:#f87171">${esc(err.message)}</span>`); }
    finally { btn.disabled = false; }
  }, { signal: ac.signal });
}
