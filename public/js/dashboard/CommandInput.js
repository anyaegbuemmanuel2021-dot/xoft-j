import { api } from '../api.js';
import { esc, toast } from '../dom.js';
import { QUICK_COMMANDS } from './logic.js';
import { canSpeakOut, isSpeakOutEnabled, setSpeakOutEnabled, speakOut, stopSpeaking } from '../voice/speak-out.js';

const SESSION_KEY = 'xoft_chat_session';
const WAKE_PATTERN = /\b(?:hey\s+)?xoft\b/i;

function friendlyProviderError(rawMessage) {
  const raw = String(rawMessage ?? '');
  let body = null;
  try { body = JSON.parse(raw.replace(/^\s*\d{3}\s+/, '')); } catch { /* plain error */ }
  if (body?.error !== 'AI_PROVIDERS_FAILED' && body?.error !== 'NO_AI_PROVIDER_AVAILABLE') return `Request failed: ${raw}`;
  if (body.error === 'NO_AI_PROVIDER_AVAILABLE') return 'XOFT could not find a usable AI provider. Open Runtime Settings and configure or test a provider.';
  const advice = (body.attempts ?? []).map((attempt) => {
    const name = ({ openai: 'OpenAI', gemini: 'Gemini', claude: 'Claude', grok: 'Grok', ollama: 'Ollama', experiential: 'Experiential Labs', freellmapi: 'FreeLLMAPI', litellm: 'LiteLLM' })[attempt.provider] ?? attempt.provider;
    if (attempt.errorType === 'rate_limit') return `${name} hit a usage or quota limit. Check its API usage and credits.`;
    if (attempt.errorType === 'auth') return `${name} rejected its credentials. Check the API key.`;
    if (attempt.errorType === 'invalid_request') return `${name} rejected the model or request. Check its model setting.`;
    return `${name} is unavailable. Check its configuration and try again.`;
  });
  return ['XOFT is running, but its configured AI providers could not answer.', ...advice, 'Check Runtime Settings, then retry.'].join(' ');
}
function sessionId() {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(SESSION_KEY, id); }
  return id;
}
async function transcribe(blob) {
  if (!blob || !blob.size) throw new Error('No audio was recorded. Hold the phone closer and try again.');
  const key = localStorage.getItem('xoft_api_key');
  const type = blob.type || 'audio/webm';
  const res = await fetch('/api/voice/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': type, ...(key ? { 'X-API-Key': key } : {}) },
    body: blob,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 180); } catch { /* ignore */ }
    throw new Error(`${res.status}${detail ? ': ' + detail : ''}`);
  }
  return String((await res.json()).text ?? '').trim();
}

export function mountCommandInput(el, store, controller) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canRecord = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  let menuOpen = false;
  let recorder = null;
  let stream = null;
  let recognition = null;
  let autoListening = false;
  let wakeArmed = false;
  let isSpeaking = false;
  let destroyed = false;
  let recognitionRestartTimer = null;

  el.innerHTML = `
    <form class="cc-cmd" data-form autocomplete="off">
      <label class="cc-sr" for="cc-input">Message XOFT</label>
      <textarea id="cc-input" rows="2" placeholder="Talk or type to XOFT…" aria-describedby="cc-hint"></textarea>
      <div class="cc-voice-status" data-voice-status data-state="idle" role="status" aria-live="polite">Ready · tap VOICE to talk, or enable AUTO LISTEN for “Hey XOFT”.</div>
      <div class="cc-cmd-bar">
        <span id="cc-hint" class="cc-muted cc-hint">Enter to send · Shift+Enter for newline</span>
        <div class="cc-actions">
          <button type="button" data-act="command" aria-haspopup="menu" aria-expanded="false" title="Quick commands">MORE</button>
          <button type="button" data-act="voice" ${canRecord ? '' : 'disabled title="Microphone recording is not available"'} aria-pressed="false">VOICE</button>
          <button type="button" data-act="auto-listen" ${Recognition ? '' : 'disabled title="Automatic listening is not supported by this browser; use VOICE"'} aria-pressed="false">AUTO LISTEN</button>
          <button type="button" data-act="speakout" aria-pressed="${isSpeakOutEnabled()}" ${canSpeakOut() ? '' : 'disabled'}>${isSpeakOutEnabled() ? 'SPEAK: ON' : 'SPEAK: OFF'}</button>
          <button type="button" data-act="stop-speaking" ${canSpeakOut() ? '' : 'disabled'} title="Stop spoken output">STOP</button>
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
  const autoBtn = el.querySelector('[data-act="auto-listen"]');
  const statusEl = el.querySelector('[data-voice-status]');
  menu.innerHTML = QUICK_COMMANDS.map((c) => `<li role="none"><button type="button" role="menuitem" data-cmd="${esc(c)}">${esc(c)}</button></li>`).join('');

  function setVoiceStatus(text, state = 'idle') {
    statusEl.textContent = text;
    statusEl.dataset.state = state;
  }
  function setMenu(open) {
    menuOpen = open;
    menu.hidden = !open;
    el.querySelector('[data-act="command"]').setAttribute('aria-expanded', String(open));
  }
  function scrollLatest() {
    requestAnimationFrame(() => {
      const last = exchangesEl.lastElementChild;
      if (last) last.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const content = document.getElementById('content');
      if (content) content.scrollTop = content.scrollHeight;
    });
  }
  function paintExchanges() {
    const { exchanges, pending } = store.get('chat');
    sendBtn.disabled = pending;
    exchangesEl.innerHTML = exchanges.slice(-8).map((x) => `
      <article class="cc-exchange" data-status="${esc(x.status)}">
        <div class="cc-you"><span class="cc-tag">YOU</span> <span class="cc-message-text">${esc(x.user)}</span></div>
        <div class="cc-reply"><span class="cc-tag">XOFT</span>
          ${x.status === 'sending' ? '<span class="cc-muted">thinking…</span>' : x.status === 'error' ? `<span class="cc-err">${esc(x.reply)}</span>` : `<span class="cc-pre">${esc(x.reply)}</span>`}
        </div>
        ${x.action ? `<div class="cc-muted cc-meta">route: ${esc(x.action)}${x.taskId ? ' · <a href="#tasks">open tasks</a>' : ''}</div>` : ''}
        ${x.awaiting && x === exchanges[exchanges.length - 1] ? '<div class="cc-actions"><button type="button" data-say="yes, go ahead" class="cc-primary">CONFIRM</button><button type="button" data-say="cancel that">CANCEL</button></div>' : ''}
      </article>`).join('');
    if (exchanges.length) scrollLatest();
  }

  function stopRecognition() {
    clearTimeout(recognitionRestartTimer);
    if (recognition) {
      try { recognition.onend = null; recognition.stop(); } catch { /* ignore */ }
      recognition = null;
    }
  }
  function startRecognition() {
    if (!Recognition || !autoListening || destroyed || isSpeaking || recognition) return;
    try {
      const instance = new Recognition();
      recognition = instance;
      instance.lang = 'en-NG';
      instance.continuous = true;
      instance.interimResults = false;
      instance.maxAlternatives = 1;
      instance.onstart = () => setVoiceStatus('AUTO LISTEN active · say “Hey XOFT” followed by your command.', 'listening');
      instance.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          if (!event.results[i].isFinal) continue;
          const heard = String(event.results[i][0]?.transcript ?? '').trim();
          if (!heard) continue;
          const match = WAKE_PATTERN.exec(heard);
          if (match) {
            const command = heard.slice(match.index + match[0].length).replace(/^[\s,.:;-]+/, '').trim();
            if (!command) {
              wakeArmed = true;
              setVoiceStatus('I’m listening · say your command now.', 'listening');
              continue;
            }
            wakeArmed = false;
            autoListening = false;
            autoBtn.setAttribute('aria-pressed', 'false');
            autoBtn.textContent = 'AUTO LISTEN';
            stopRecognition();
            void submit(command, { fromVoice: true });
            return;
          }
          if (wakeArmed) {
            wakeArmed = false;
            autoListening = false;
            autoBtn.setAttribute('aria-pressed', 'false');
            autoBtn.textContent = 'AUTO LISTEN';
            stopRecognition();
            void submit(heard, { fromVoice: true });
            return;
          }
        }
      };
      instance.onerror = (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          autoListening = false;
          autoBtn.setAttribute('aria-pressed', 'false');
          autoBtn.textContent = 'AUTO LISTEN';
          setVoiceStatus('Microphone permission denied. Allow mic access in browser settings.', 'error');
        } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
          setVoiceStatus(`Listening issue: ${event.error}. Tap AUTO LISTEN to retry.`, 'error');
        }
      };
      instance.onend = () => {
        if (recognition === instance) recognition = null;
        if (autoListening && !destroyed && !isSpeaking) {
          recognitionRestartTimer = setTimeout(startRecognition, 350);
        }
      };
      instance.start();
    } catch (err) {
      recognition = null;
      setVoiceStatus(`Could not start automatic listening: ${err.message}`, 'error');
    }
  }

  async function submit(text, { fromVoice = false } = {}) {
    text = String(text ?? '').trim();
    if (!text || store.get('chat').pending) return;
    const ex = { user: text, reply: '', status: 'sending', ts: Date.now() };
    store.set('chat', { pending: true, exchanges: [...store.get('chat').exchanges, ex].slice(-30) });
    input.value = '';
    if (fromVoice) setVoiceStatus('Command received · XOFT is thinking…', 'processing');
    let ok = true;
    try {
      const result = await api.post('/api/chat', { message: text, sessionId: sessionId() });
      if (result.__queued) { ex.reply = 'Offline — this command is queued and will be sent when you are back online.'; ex.status = 'queued'; }
      else {
        ex.reply = result.reply ?? JSON.stringify(result);
        ex.status = 'done';
        ex.action = result.action;
        ex.taskId = result.meta?.task?.id ?? null;
        ex.awaiting = Boolean(result.meta?.awaitingConfirmation);
      }
      store.set('chat', { pending: false, exchanges: [...store.get('chat').exchanges] });
      if (ok && ex.status === 'done' && isSpeakOutEnabled()) {
        setVoiceStatus('XOFT is speaking…', 'speaking');
        const spoke = await speakOut(ex.reply);
        if (!spoke) setVoiceStatus('Reply ready · audio unavailable. Tap SPEAK to retry.', 'error');
      } else if (fromVoice) {
        setVoiceStatus(ex.status === 'queued' ? 'Queued offline.' : 'Reply ready.', 'idle');
      }
    } catch (err) {
      ok = false;
      ex.reply = friendlyProviderError(err.message);
      ex.status = 'error';
      store.set('errorUntil', Date.now() + 6000);
      store.set('chat', { pending: false, exchanges: [...store.get('chat').exchanges] });
      toast(ex.reply, 'warn');
      if (fromVoice) setVoiceStatus('XOFT could not complete that request.', 'error');
    }
    if (ok) { controller.refresh('tasks'); controller.refresh('approvals'); controller.refresh('memory'); }
    if (autoListening && !isSpeaking) startRecognition();
  }

  async function toggleVoice() {
    if (recorder) { recorder.stop(); return; }
    if (!canRecord) { toast('Microphone recording is not available in this browser.', 'warn'); return; }
    try {
      stopRecognition();
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const preferredType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported?.(type));
      const options = preferredType ? { mimeType: preferredType } : undefined;
      const chunks = [];
      recorder = new MediaRecorder(stream, options);
      recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
      recorder.onerror = (event) => setVoiceStatus(`Recording failed: ${event.error?.message || 'unknown error'}`, 'error');
      recorder.onstop = async () => {
        stream?.getTracks().forEach((track) => track.stop());
        stream = null;
        recorder = null;
        voiceBtn.setAttribute('aria-pressed', 'false');
        voiceBtn.textContent = 'VOICE';
        setVoiceStatus('Transcribing your voice…', 'processing');
        try {
          const blob = new Blob(chunks, { type: chunks[0]?.type || preferredType || 'audio/webm' });
          const text = await transcribe(blob);
          if (!text) { setVoiceStatus('No speech recognised. Speak clearly and try again.', 'error'); toast('No speech recognised — try again closer to the microphone.', 'warn'); return; }
          input.value = text;
          input.focus({ preventScroll: true });
          setVoiceStatus('Voice recognised · sending to XOFT…', 'processing');
          await submit(text, { fromVoice: true });
        } catch (err) {
          setVoiceStatus(`Voice transcription failed: ${err.message}`, 'error');
          toast(`Voice transcription failed: ${err.message}`, 'err');
        } finally {
          if (autoListening && !isSpeaking) startRecognition();
        }
      };
      recorder.start();
      voiceBtn.setAttribute('aria-pressed', 'true');
      voiceBtn.textContent = 'STOP REC';
      setVoiceStatus('Recording · speak now, then tap STOP REC.', 'listening');
    } catch (err) {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      recorder = null;
      setVoiceStatus(`Microphone unavailable: ${err.message}`, 'error');
      toast(`Microphone unavailable: ${err.message}`, 'err');
    }
  }

  function toggleAutoListen() {
    if (!Recognition) {
      toast('Automatic listening needs browser speech recognition. Use VOICE for push-to-talk.', 'warn');
      return;
    }
    autoListening = !autoListening;
    wakeArmed = false;
    if (autoListening) {
      if (recorder) { try { recorder.stop(); } catch { /* ignore */ } }
      autoBtn.setAttribute('aria-pressed', 'true');
      autoBtn.textContent = 'LISTENING';
      setVoiceStatus('Starting microphone · say “Hey XOFT” to begin a command.', 'listening');
      startRecognition();
    } else {
      stopRecognition();
      autoBtn.setAttribute('aria-pressed', 'false');
      autoBtn.textContent = 'AUTO LISTEN';
      setVoiceStatus('Automatic listening is off.', 'idle');
    }
  }

  el.querySelector('[data-form]').addEventListener('submit', (event) => { event.preventDefault(); void submit(input.value); });
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submit(input.value); } });
  el.addEventListener('click', async (event) => {
    const cmd = event.target.closest('[data-cmd]');
    if (cmd) { input.value = cmd.dataset.cmd; setMenu(false); input.focus(); return; }
    const say = event.target.closest('[data-say]');
    if (say) { void submit(say.dataset.say); return; }
    const act = event.target.closest('[data-act]')?.dataset.act;
    if (act === 'command') { setMenu(!menuOpen); if (menuOpen) menu.querySelector('button')?.focus(); }
    if (act === 'voice') await toggleVoice();
    if (act === 'auto-listen') toggleAutoListen();
    if (act === 'speakout') {
      const enabled = !isSpeakOutEnabled();
      setSpeakOutEnabled(enabled);
      window.dispatchEvent(new CustomEvent('xoft:speakout-change'));
      const button = el.querySelector('[data-act="speakout"]');
      button.textContent = enabled ? 'SPEAK: ON' : 'SPEAK: OFF';
      button.setAttribute('aria-pressed', String(enabled));
      toast(enabled ? 'Speak Out enabled — XOFT replies will be read aloud.' : 'Speak Out disabled.', 'info');
    }
    if (act === 'stop-speaking') { stopSpeaking(); setVoiceStatus('Speech stopped.', 'idle'); }
  });
  el.addEventListener('keydown', (event) => { if (event.key === 'Escape' && menuOpen) { setMenu(false); el.querySelector('[data-act="command"]').focus(); } });

  const onSpeechState = (event) => {
    const state = event.detail?.state;
    isSpeaking = state === 'speaking' || state === 'loading';
    if (state === 'speaking') setVoiceStatus('XOFT is speaking…', 'speaking');
    if (state === 'error') setVoiceStatus(event.detail?.detail || 'Audio playback failed. Tap SPEAK to retry.', 'error');
    if (state === 'idle' && !recorder) {
      if (autoListening && !destroyed) {
        setVoiceStatus('Ready · say “Hey XOFT” followed by your command.', 'listening');
        startRecognition();
      } else if (!store.get('chat').pending) setVoiceStatus('Ready.', 'idle');
    }
  };
  window.addEventListener('xoft:speech-state', onSpeechState);

  paintExchanges();
  const unsub = store.subscribe('chat', paintExchanges);
  return () => {
    destroyed = true;
    autoListening = false;
    stopRecognition();
    window.removeEventListener('xoft:speech-state', onSpeechState);
    try { recorder?.stop(); } catch { /* ignore */ }
    stream?.getTracks().forEach((track) => track.stop());
    unsub();
  };
}
