import { api } from '../api.js';
import { esc, toast } from '../dom.js';
import { QUICK_COMMANDS } from './logic.js';
import { canSpeakOut, isSpeakOutEnabled, setSpeakOutEnabled, speakOut, stopSpeaking } from '../voice/speak-out.js';

const SESSION_KEY = 'xoft_chat_session'; // same session the Chat view uses

function friendlyProviderError(rawMessage) {
  const raw = String(rawMessage ?? '');
  let body = null;
  try {
    body = JSON.parse(raw.replace(/^\s*\d{3}\s+/, ''));
  } catch { /* This was not a structured API error. */ }

  if (body?.error !== 'AI_PROVIDERS_FAILED' && body?.error !== 'NO_AI_PROVIDER_AVAILABLE') {
    return `Request failed: ${raw}`;
  }

  if (body.error === 'NO_AI_PROVIDER_AVAILABLE') {
    return 'XOFT could not find a usable AI provider. Open Settings → AI providers and configure or test at least one provider.';
  }

  const advice = (body.attempts ?? []).map((attempt) => {
    const name = ({ openai: 'OpenAI', gemini: 'Gemini', claude: 'Claude', grok: 'Grok', ollama: 'Ollama', experiential: 'Experiential Labs', freellmapi: 'FreeLLMAPI', litellm: 'LiteLLM' })[attempt.provider] ?? attempt.provider;
    switch (attempt.errorType) {
      case 'rate_limit':
        return `${name} hit a rate, usage, or quota limit. Check that provider's API usage, billing/credits, and rate limits.`;
      case 'auth':
        return `${name} rejected its credentials. Check the API key in your deployment environment.`;
      case 'invalid_request':
        return `${name} rejected the configured model or request. Check the model name in Settings or deployment variables.`;
      case 'timeout':
      case 'unavailable':
      case 'server_error':
        return `${name} is temporarily unreachable. Try again shortly.`;
      default:
        return `${name} failed. Check its API key and model configuration.`;
    }
  });

  return [
    'XOFT is running, but its configured AI providers could not answer.',
    ...advice,
    'Fix the provider issue, then retry. You can check Settings → AI providers for configuration and connection tests.'
  ].join(' ');
}
function sessionId() {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(SESSION_KEY, id); }
  return id;
}

async function transcribe(blob) {
  const key = localStorage.getItem('xoft_api_key');
  const res = await fetch('/api/voice/transcribe', { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm', ...(key ? { 'X-API-Key': key } : {}) }, body: blob });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
  return (await res.json()).text ?? '';
}

export function mountCommandInput(el, store, controller) {
  const canRecord = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  let menuOpen = false;
  let recorder = null;

  el.innerHTML = `
    <form class="cc-cmd" data-form autocomplete="off">
      <label class="cc-sr" for="cc-input">Command for XOFT</label>
      <textarea id="cc-input" rows="2" placeholder="What can I do for you?" aria-describedby="cc-hint"></textarea>
      <div class="cc-cmd-bar">
        <span id="cc-hint" class="cc-muted cc-hint">Enter to send · Shift+Enter for newline</span>
        <div class="cc-actions">
          <button type="button" data-act="command" aria-haspopup="menu" aria-expanded="false">COMMAND</button>
          <button type="button" data-act="attach" disabled title="File attachments are not supported by the XOFT chat API yet">ATTACH</button>
          <button type="button" data-act="voice" ${canRecord ? '' : 'disabled title="Microphone recording is not available in this browser"'} aria-pressed="false">VOICE</button>
          <button type="button" data-act="speakout" aria-pressed="${isSpeakOutEnabled()}" ${canSpeakOut() ? '' : 'disabled title="Text-to-speech is not available in this browser"'}>${isSpeakOutEnabled() ? 'SPEAK OUT: ON' : 'SPEAK OUT: OFF'}</button>
          <button type="button" data-act="stop-speaking" ${canSpeakOut() ? '' : 'disabled'}>STOP SPEAKING</button>
          <button type="submit" class="cc-primary" data-act="send">SEND</button>
        </div>
      </div>
      <ul class="cc-menu" role="menu" aria-label="Quick commands" hidden></ul>
    </form>
    <div class="cc-exchanges" aria-live="polite" aria-relevant="additions text" data-exchanges></div>`;

  const input = el.querySelector('#cc-input');
  const menu = el.querySelector('.cc-menu');
  const exchangesEl = el.querySelector('[data-exchanges]');
  const sendBtn = el.querySelector('[data-act="send"]');
  const voiceBtn = el.querySelector('[data-act="voice"]');
  menu.innerHTML = QUICK_COMMANDS.map((c) => `<li role="none"><button type="button" role="menuitem" data-cmd="${esc(c)}">${esc(c)}</button></li>`).join('');

  function setMenu(open) {
    menuOpen = open;
    menu.hidden = !open;
    el.querySelector('[data-act="command"]').setAttribute('aria-expanded', String(open));
  }

  function paintExchanges() {
    const { exchanges, pending } = store.get('chat');
    sendBtn.disabled = pending;
    exchangesEl.innerHTML = exchanges.slice(-3).map((x) => `
      <article class="cc-exchange" data-status="${x.status}">
        <div class="cc-you"><span class="cc-tag">YOU</span> ${esc(x.user)}</div>
        <div class="cc-reply"><span class="cc-tag">XOFT</span>
          ${x.status === 'sending' ? '<span class="cc-muted">working…</span>' : x.status === 'error' ? `<span class="cc-err">${esc(x.reply)}</span>` : `<span class="cc-pre">${esc(x.reply)}</span>`}
        </div>
        ${x.action ? `<div class="cc-muted cc-meta">route: ${esc(x.action)}${x.taskId ? ` · <a href="#tasks">open tasks</a>` : ''}</div>` : ''}
        ${x.awaiting && x === exchanges[exchanges.length - 1] ? '<div class="cc-actions"><button type="button" data-say="yes, go ahead" class="cc-primary">CONFIRM PLAN</button><button type="button" data-say="cancel that">CANCEL</button></div>' : ''}
      </article>`).join('');
  }

  async function submit(text) {
    text = text.trim();
    if (!text || store.get('chat').pending) return;
    const ex = { user: text, reply: '', status: 'sending', ts: Date.now() };
    store.set('chat', { pending: true, exchanges: [...store.get('chat').exchanges, ex].slice(-10) });
    input.value = '';
    let ok = true;
    try {
      const result = await api.post('/api/chat', { message: text, sessionId: sessionId() });
      if (result.__queued) { ex.reply = 'Offline — this command is queued and will be sent when you are back online.'; ex.status = 'queued'; }
      else { ex.reply = result.reply ?? JSON.stringify(result); ex.status = 'done'; ex.action = result.action; ex.taskId = result.meta?.task?.id ?? null; ex.awaiting = Boolean(result.meta?.awaitingConfirmation); }
        speakOut(ex.reply);
    } catch (err) {
      ok = false;
      ex.reply = friendlyProviderError(err.message);
      ex.status = 'error';
      store.set('errorUntil', Date.now() + 6000);
      toast(ex.reply, 'warn');
    }
    store.set('chat', { pending: false, exchanges: [...store.get('chat').exchanges] });
    if (ok) { controller.refresh('tasks'); controller.refresh('approvals'); controller.refresh('memory'); }
  }

  el.querySelector('[data-form]').addEventListener('submit', (e) => { e.preventDefault(); submit(input.value); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(input.value); } });

  el.addEventListener('click', async (e) => {
    const cmd = e.target.closest('[data-cmd]');
    if (cmd) { input.value = cmd.dataset.cmd; setMenu(false); input.focus(); return; }
    const say = e.target.closest('[data-say]');
    if (say) { submit(say.dataset.say); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'command') { setMenu(!menuOpen); if (menuOpen) menu.querySelector('button')?.focus(); }
    if (act === 'voice') await toggleVoice();
    if (act === 'speakout') {
      const enabled = !isSpeakOutEnabled();
      setSpeakOutEnabled(enabled);
      window.dispatchEvent(new CustomEvent('xoft:speakout-change'));
      const button = el.querySelector('[data-act="speakout"]');
      button.textContent = enabled ? 'SPEAK OUT: ON' : 'SPEAK OUT: OFF';
      button.setAttribute('aria-pressed', String(enabled));
      toast(enabled ? 'Speak Out enabled — XOFT replies will be read aloud.' : 'Speak Out disabled.', 'info');
    }
    if (act === 'stop-speaking') stopSpeaking();
  });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuOpen) { setMenu(false); el.querySelector('[data-act="command"]').focus(); } });

  async function toggleVoice() {
    if (recorder) { recorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (ev) => chunks.push(ev.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        recorder = null; voiceBtn.setAttribute('aria-pressed', 'false'); voiceBtn.textContent = 'VOICE';
        try { const text = await transcribe(new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' })); if (text) { input.value = text; input.focus(); } else toast('No speech recognised', 'warn'); }
        catch (err) { toast(`Voice transcription failed: ${err.message}`, 'err'); }
      };
      recorder.start();
      voiceBtn.setAttribute('aria-pressed', 'true'); voiceBtn.textContent = 'STOP';
    } catch (err) { toast(`Microphone unavailable: ${err.message}`, 'err'); recorder = null; }
  }

  paintExchanges();
  const unsub = store.subscribe('chat', paintExchanges);
  return () => { unsub(); try { recorder?.stop(); } catch { /* ignore */ } };
}
