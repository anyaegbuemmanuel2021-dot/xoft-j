import { api } from '../api.js';
import { esc, toast } from '../dom.js';
import { QUICK_COMMANDS } from './logic.js';
import { canSpeakOut, isSpeakOutEnabled, setSpeakOutEnabled, speakOut, stopSpeaking } from '../voice/speak-out.js';
import { transcribe as transcribeAudio } from '../voice/stt.js';
import { createServerListener, unlockAudio } from '../voice/listen.js';
import { currentSessionId, deleteSession, exchangesToMessages, filterRecent, mergeRemoteSessions, messagesToExchanges, pickNewestMessages, readMessages, recentSessions, saveMessages, startNewSession, switchSession, togglePin } from '../chatSessions.js';

const MAX_EXCHANGES = 300;
const WAKE_PATTERN = /\bxoft\b/i;

function friendlyProviderError(rawMessage) {
  const raw = String(rawMessage ?? '');
  let body = null;
  try {
    const candidate = raw.replace(/^\\s*\\d{3}\\s+/, '');
    body = JSON.parse(candidate);
  } catch { /* the server may return a plain-text/network error */ }

  if (body?.error !== 'AI_PROVIDERS_FAILED' && body?.error !== 'NO_AI_PROVIDER_AVAILABLE' && body?.error !== 'INVALID_PROVIDER_CONFIG') {
    if (/failed to fetch|networkerror|network request failed/i.test(raw)) {
      return 'XOFT could not reach its server. Enable internet access, check the Railway deployment is running, and retry. If the server is awake but still unreachable, check its deployment logs.';
    }
    return `XOFT could not complete this request: ${raw || 'unknown error'}. Check Runtime Settings and Diagnostics for the exact cause.`;
  }

  const labels = {
    openai: 'OpenAI', gemini: 'Gemini', claude: 'Claude', grok: 'Grok',
    ollama: 'Ollama (local)', experiential: 'Experiential Labs',
    freellmapi: 'FreeLLMAPI gateway', litellm: 'LiteLLM gateway',
  };
  const attempts = Array.isArray(body.attempts) ? body.attempts : [];
  const tried = Array.isArray(body.tried) ? body.tried : [];
  const names = [...new Set([...attempts.map((a) => a.provider), ...tried])].filter(Boolean);
  const readable = (name) => labels[name] ?? name;
  const advice = [];
  for (const attempt of attempts) {
    const name = readable(attempt.provider);
    if (attempt.errorType === 'rate_limit') advice.push(`${name}: quota/rate limit reached — add credits or wait for the provider's quota window to reset.`);
    else if (attempt.errorType === 'auth') advice.push(`${name}: credentials rejected — correct its API key in Railway Variables, then redeploy.`);
    else if (attempt.errorType === 'invalid_request') advice.push(`${name}: model/request rejected — choose a model supported by that API key.`);
    else if (attempt.errorType === 'timeout') advice.push(`${name}: timed out — check provider status/network or try a faster model.`);
    else if (attempt.errorType === 'unavailable' || attempt.errorType === 'server_error') advice.push(`${name}: provider unavailable — it will be tried again on a later request.`);
    else advice.push(`${name}: request failed — check its key, model, quota and provider status.`);
  }

  if (body.error === 'INVALID_PROVIDER_CONFIG') {
    return 'XOFT’s AI routing settings are invalid. Correct AI_PRIMARY_PROVIDER and AI_FALLBACK_PROVIDERS in Railway Variables, or remove the invalid override, then redeploy.';
  }
  if (body.error === 'NO_AI_PROVIDER_AVAILABLE') {
    return [
      'XOFT could not find a configured AI provider for this request.',
      'Enable at least one working provider in Railway Variables: OPENAI_API_KEY (OpenAI) or ANTHROPIC_API_KEY (Claude).',
      'Optional additional fallbacks: GEMINI_API_KEY, XAI_API_KEY, or EXPERIENTIAL_API_KEY / gateway credentials. Set AI_FALLBACK_ENABLED=true.',
      'For local fallback, OLLAMA_ENABLED=true only works if an Ollama service is actually reachable from the XOFT server.',
      names.length ? `Providers considered: ${names.map(readable).join(', ')}.` : '',
    ].filter(Boolean).join(' ');
  }
  return [
    'XOFT tried its configured AI providers, but none completed this request.',
    ...new Set(advice),
    names.length ? `Attempted: ${names.map(readable).join(', ')}.` : '',
    'To restore service, configure at least two independent providers for automatic fallback (for example OPENAI_API_KEY and ANTHROPIC_API_KEY), ensure their model names are valid, and check API credits/quotas in Railway Variables and provider dashboards.',
    'XOFT cannot bypass missing credentials, exhausted quotas, provider outages, or permissions; the fallback chain can only use providers and tools that are actually enabled.',
  ].filter(Boolean).join(' ');
}
function sessionId() { return currentSessionId(); }
async function transcribe(blob, onStatus = () => {}) {
  // One shared path: server Whisper (OpenAI, Gemini fallback) first, on-device Whisper second.
  return transcribeAudio(blob, onStatus);
}

export function mountCommandInput(el, store, controller) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canRecord = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  let menuOpen = false;
  let recorder = null;
  let stream = null;
  let recognition = null;
  let serverListener = null;
  // AUTO LISTEN uses Whisper (server: OpenAI, Gemini fallback, then on-device Whisper) by default.
  // Browser Web Speech is used only when this browser cannot record audio.
  let serverMode = canRecord || !Recognition;
  let autoListening = false;
  let wakeArmed = false;
  let isSpeaking = false;
  let destroyed = false;
  let serverHistoryReady = false;
  let historySaveTimer = null;
  let recognitionRestartTimer = null;
  // Start with the Nigeria-specific locale, then fall back to widely supported English if the browser rejects it.
  let recognitionLanguage = 'en-NG';

  el.innerHTML = `
    <form class="cc-cmd" data-form autocomplete="off">
      <label class="cc-sr" for="cc-input">Message XOFT</label>
      <textarea id="cc-input" rows="2" placeholder="Talk or type to XOFT…" aria-describedby="cc-hint"></textarea>
      <div class="cc-voice-status" data-voice-status data-state="idle" role="status" aria-live="polite">Ready · tap VOICE, or enable AUTO LISTEN and say “XOFT”.</div>
      <div class="cc-cmd-bar">
        <span id="cc-hint" class="cc-muted cc-hint">Enter to send · Shift+Enter for newline</span>
        <div class="cc-actions">
          <button type="button" data-act="recent" aria-expanded="false" title="Find your saved chats">RECENT</button>
          <button type="button" data-act="command" aria-haspopup="menu" aria-expanded="false" title="Quick commands">MORE</button>
          <button type="button" data-act="voice" ${canRecord ? '' : 'disabled title="Microphone recording is not available"'} aria-pressed="false">VOICE</button>
          <button type="button" data-act="auto-listen" ${(canRecord || Recognition) ? '' : 'disabled title="Automatic listening needs microphone access in a supported browser (HTTPS)"'} aria-pressed="false">WHISPER AUTO LISTEN</button>
          <button type="button" data-act="speakout" aria-pressed="${isSpeakOutEnabled()}" ${canSpeakOut() ? '' : 'disabled'}>${isSpeakOutEnabled() ? 'SPEAK: ON' : 'SPEAK: OFF'}</button>
          <button type="button" data-act="stop-speaking" ${canSpeakOut() ? '' : 'disabled'} title="Stop spoken output">STOP</button>
          <button type="submit" class="cc-primary" data-act="send">SEND</button>
        </div>
      </div>
      <ul class="cc-menu" role="menu" aria-label="Quick commands" hidden></ul>
    </form>
    <section class="cc-recent" data-recent hidden aria-label="Recent chats">
      <div class="cc-recent-head"><strong>RECENT CHATS</strong><button type="button" data-act="new-chat" class="cc-primary">+ NEW CHAT</button></div>
      <input type="search" data-recent-search placeholder="Search your chats…" aria-label="Search recent chats" autocomplete="off">
      <div class="cc-recent-list" data-recent-list></div>
      <p class="cc-muted cc-recent-note">Chats are saved on this device and synced to XOFT when available. ☆ pins a chat; ✕ deletes it. Opening a chat does not call AI.</p>
    </section>
    <div class="cc-exchanges" aria-live="polite" aria-relevant="additions text" data-exchanges></div>`;

  const input = el.querySelector('#cc-input');
  const menu = el.querySelector('.cc-menu');
  const exchangesEl = el.querySelector('[data-exchanges]');
  const sendBtn = el.querySelector('[data-act="send"]');
  const voiceBtn = el.querySelector('[data-act="voice"]');
  const autoBtn = el.querySelector('[data-act="auto-listen"]');
  const statusEl = el.querySelector('[data-voice-status]');
  const recentBtn = el.querySelector('[data-act="recent"]');
  const recentPanel = el.querySelector('[data-recent]');
  const recentList = el.querySelector('[data-recent-list]');
  const recentSearch = el.querySelector('[data-recent-search]');
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
    queueMicrotask(() => {
      // Keep the command centre in place; scroll the chat history pane itself.
      exchangesEl.scrollTo({ top: exchangesEl.scrollHeight, behavior: 'smooth' });
    });
  }
  function paintRecent() {
    if (!recentList || !recentSearch) return;
    const active = sessionId();
    const items = filterRecent(recentSearch.value);
    recentList.innerHTML = items.map((item) => {
      const d = new Date(item.updatedAt);
      const when = Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `<div class="cc-recent-row${item.id === active ? ' is-active' : ''}${item.pinned ? ' is-pinned' : ''}">
        <button type="button" class="cc-recent-item" data-session="${esc(item.id)}"><strong>${esc(item.title || 'Saved chat')}</strong><small>${esc(when)}</small></button>
        <button type="button" class="cc-recent-act" data-pin="${esc(item.id)}" aria-pressed="${item.pinned ? 'true' : 'false'}" aria-label="${item.pinned ? 'Unpin chat' : 'Pin chat to the top'}" title="${item.pinned ? 'Unpin' : 'Pin to top'}">${item.pinned ? '★' : '☆'}</button>
        <button type="button" class="cc-recent-act cc-recent-del" data-delete="${esc(item.id)}" aria-label="Delete chat" title="Delete chat">✕</button>
      </div>`;
    }).join('') || '<div class="cc-muted cc-recent-empty">No saved chats yet. Send a message and it will appear here.</div>';
  }
  function toggleRecent(force) {
    const open = typeof force === 'boolean' ? force : recentPanel.hidden;
    recentPanel.hidden = !open;
    recentBtn?.setAttribute('aria-expanded', String(open));
    if (!open) return;
    paintRecent();
    recentSearch?.focus();
    void api.get('/api/chats')
      .then((result) => { mergeRemoteSessions(result?.sessions); if (!recentPanel.hidden) paintRecent(); })
      .catch(() => { /* offline: local recent chats remain available */ });
  }
  function hydrateFromStorage() {
    const messages = readMessages(sessionId());
    if (messages.length) store.set('chat', { pending: false, exchanges: messagesToExchanges(messages).slice(-MAX_EXCHANGES) });
    else {
      try {
        const legacy = JSON.parse(localStorage.getItem('xoft_command_center_history_' + sessionId()) || '[]');
        if (Array.isArray(legacy) && legacy.length) store.set('chat', { pending: false, exchanges: legacy.filter((x) => x && typeof x.user === 'string').slice(-MAX_EXCHANGES) });
      } catch { /* ignore malformed legacy history */ }
    }
  }
  function removeRecentChat(id) {
    const item = recentSessions().find((entry) => entry.id === id);
    if (id === sessionId() && store.get('chat').pending) { toast('XOFT is still answering. Delete this chat in a moment.', 'info'); return; }
    if (!window.confirm(`Delete "${item?.title || 'this chat'}"?`)) return;
    deleteSession(id);
    void api.del('/api/chats/' + encodeURIComponent(id)).catch(() => { /* local deletion still stands */ });
    if (id === sessionId()) {
      startNewSession();
      serverHistoryReady = true;
      store.set('chat', { pending: false, exchanges: [] });
      paintExchanges();
    }
    paintRecent();
    toast('Chat deleted.', 'info');
  }
  function openRecentChat(id) {
    if (!id || id === sessionId()) { toggleRecent(false); return; }
    if (store.get('chat').pending) { toast('XOFT is still answering. Switch chats in a moment.', 'info'); return; }
    switchSession(id);
    hydrateFromStorage();
    toggleRecent(false);
    void api.get('/api/chats/' + encodeURIComponent(id)).then((saved) => {
      if (sessionId() !== id || store.get('chat').pending) return;
      const local = readMessages(id);
      const best = pickNewestMessages(local, Array.isArray(saved?.messages) ? saved.messages : [], saved?.updatedAt);
      if (best !== local) { saveMessages(id, best); store.set('chat', { pending: false, exchanges: messagesToExchanges(best).slice(-MAX_EXCHANGES) }); }
    }).catch(() => { /* local copy is enough when offline */ });
  }
  function startRecentChat() {
    if (store.get('chat').pending) { toast('XOFT is still answering. Start a new chat in a moment.', 'info'); return; }
    startNewSession();
    serverHistoryReady = true;
    store.set('chat', { pending: false, exchanges: [] });
    toggleRecent(false);
    paintRecent();
    input.focus();
  }
  function paintExchanges() {
    const { exchanges, pending } = store.get('chat');
    sendBtn.disabled = pending;
    // Keep completed exchanges on this device across refreshes and page navigation.
    try {
      const saved = exchanges.filter((x) => x && x.status !== 'sending').slice(-100);
      localStorage.setItem('xoft_chat_history_v1', JSON.stringify(saved));
      localStorage.setItem('xoft_command_center_history_' + sessionId(), JSON.stringify(saved));

      // Keep Command Centre and the Chat page on the same conversation timeline.
      // The Chat page uses role/content messages; the dashboard stores exchanges.
      // Synchronize both formats locally so typed and transcribed voice turns appear
      // under Recent chats immediately, without extra AI calls or API credits.
      const id = sessionId();
      const messages = saved.flatMap((x) => {
        const at = new Date(Number(x.ts) || Date.now()).toISOString();
        const user = { role: 'user', content: String(x.user ?? ''), at };
        if (x.status === 'queued') {
          return [user, { role: 'assistant', content: String(x.reply || 'Queued offline.'), at }];
        }
        if (x.status === 'error' || x.status === 'done') {
          return [user, { role: 'assistant', content: String(x.reply ?? ''), at }];
        }
        return [user];
      }).filter((m) => m.content.trim()).slice(-300);
      localStorage.setItem('xoft_chat_history_' + id, JSON.stringify(messages));

      if (messages.length) saveMessages(id, messages);
      if (recentPanel && !recentPanel.hidden) paintRecent();
      if (serverHistoryReady) {
        clearTimeout(historySaveTimer);
        historySaveTimer = setTimeout(() => {
          void api.put('/api/chats/' + encodeURIComponent(id), { messages, userId: 'web-user' })
            .catch((error) => console.warn('[XOFT] Could not sync conversation history to server:', error));
        }, 250);
      }
    } catch { /* disabled or full browser storage must not block chat */ }
    exchangesEl.innerHTML = exchanges.map((x) => `
      <article class="cc-exchange" data-status="${esc(x.status)}">
        <div class="cc-you"><span class="cc-tag">YOU</span> <span class="cc-message-text">${esc(x.user)}</span></div>
        <div class="cc-reply"><span class="cc-tag">XOFT</span>
          ${x.status === 'sending' ? '<span class="cc-muted">thinking…</span>' : x.status === 'error' ? `<span class="cc-err">${esc(String(x.reply ?? '').replace(/\\r\\n?/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim())}</span>` : `<span class="cc-pre">${esc(String(x.reply ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim())}</span>`}
        </div>
        ${x.action ? `<div class="cc-muted cc-meta">route: ${esc(x.action)}${x.taskId ? ' · <a href="#tasks">open tasks</a>' : ''}</div>` : ''}
        ${x.awaiting && x === exchanges[exchanges.length - 1] ? '<div class="cc-actions"><button type="button" data-say="yes, go ahead" class="cc-primary">CONFIRM</button><button type="button" data-say="cancel that">CANCEL</button></div>' : ''}
      </article>`).join('');
    if (exchanges.length) scrollLatest();
  }

  function stopRecognition() {
    clearTimeout(recognitionRestartTimer);
    if (serverListener) { serverListener.stop(); serverListener = null; }
    if (recognition) {
      try { recognition.onend = null; recognition.stop(); } catch { /* ignore */ }
      recognition = null;
    }
  }
  // Wake-word handling shared by browser Web Speech and server STT. Returns true when a command was submitted.
  function handleHeard(heard) {
    heard = String(heard ?? '').trim();
    if (!heard) return false;
    const match = WAKE_PATTERN.exec(heard);
    if (match) {
      const command = heard.slice(match.index + match[0].length).replace(/^[\s,.:;-]+/, '').trim();
      if (!command) {
        wakeArmed = true;
        setVoiceStatus('I’m listening · say your command now.', 'listening');
        return false;
      }
      wakeArmed = false;
      stopRecognition();
      void submit(command, { fromVoice: true });
      return true;
    }
    if (wakeArmed) {
      wakeArmed = false;
      stopRecognition();
      void submit(heard, { fromVoice: true });
      return true;
    }
    setVoiceStatus(`Heard “${heard.slice(0, 60)}” · say “XOFT” first.`, 'listening');
    return false;
  }

  function startServerListening() {
    if (!autoListening || destroyed || isSpeaking || serverListener) return;
    serverListener = createServerListener({
      onSegment: async (blob) => {
        setVoiceStatus('Transcribing…', 'processing');
        let text = '';
        try {
          text = await transcribeAudio(blob);
        } catch (error) {
          setVoiceStatus(`Speech recognition failed: ${String(error?.message || 'unknown error').slice(0, 160)}`, 'error');
          return;
        }
        if (!handleHeard(text) && autoListening) setVoiceStatus('AUTO LISTEN active · say “XOFT”, then your command.', 'listening');
      },
      onLevel: (level) => window.dispatchEvent(new CustomEvent('xoft:voice-level', { detail: { level } })),
      onError: (error) => {
        autoListening = false;
        autoBtn.setAttribute('aria-pressed', 'false');
        autoBtn.textContent = 'WHISPER AUTO LISTEN';
        setVoiceStatus(`Microphone unavailable: ${error?.message || 'permission denied'}. Allow mic access, then tap AUTO LISTEN.`, 'error');
        stopRecognition();
      },
    });
    setVoiceStatus('AUTO LISTEN active (Whisper) · say “XOFT”, then your command.', 'listening');
    void serverListener.start();
  }

  function startRecognition() {
    if (serverMode) { startServerListening(); return; }
    if (!Recognition || !autoListening || destroyed || isSpeaking || recognition) return;
    try {
      const instance = new Recognition();
      recognition = instance;
      instance.lang = recognitionLanguage;
      instance.continuous = true;
      instance.interimResults = false;
      instance.maxAlternatives = 1;
      instance.onstart = () => setVoiceStatus('AUTO LISTEN active · say “XOFT”, then your command. “Hey XOFT” also works.', 'listening');
      instance.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          if (!event.results[i].isFinal) continue;
          if (handleHeard(event.results[i][0]?.transcript)) return;
        }
      };
      instance.onerror = (event) => {
        if (event.error === 'language-not-supported' && recognitionLanguage !== 'en-US') {
          recognitionLanguage = 'en-US';
          setVoiceStatus('Switching speech recognition language for browser compatibility…', 'processing');
          try { instance.stop(); } catch { /* onend restarts with the fallback locale */ }
        } else if (event.error === 'network' || event.error === 'service-not-allowed') {
          // The browser's cloud speech service is unreachable or blocked: keep listening through XOFT server STT.
          serverMode = true;
          recognition = null;
          setVoiceStatus('Browser speech service unavailable · switching to XOFT server listening…', 'processing');
          startRecognition();
        } else if (event.error === 'not-allowed') {
          autoListening = false;
          autoBtn.setAttribute('aria-pressed', 'false');
          autoBtn.textContent = 'WHISPER AUTO LISTEN';
          setVoiceStatus('Microphone or browser speech permission denied. Allow mic access, then use VOICE for local Whisper transcription.', 'error');
        } else if (event.error === 'network') {
          // Web Speech often depends on a vendor cloud service. Don't restart it forever
          // on a network failure; push-to-talk uses local Whisper and can work independently.
          autoListening = false;
          wakeArmed = false;
          autoBtn.setAttribute('aria-pressed', 'false');
          autoBtn.textContent = 'WHISPER AUTO LISTEN';
          setVoiceStatus('AUTO LISTEN needs the browser speech service, which is unreachable right now. AUTO LISTEN is off; tap VOICE to record and transcribe with local Whisper instead.', 'error');
        } else if (event.error === 'audio-capture') {
          autoListening = false;
          autoBtn.setAttribute('aria-pressed', 'false');
          autoBtn.textContent = 'WHISPER AUTO LISTEN';
          setVoiceStatus('No microphone was detected. Check Android microphone permission and close other apps using the mic.', 'error');
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
    unlockAudio();
    if (recorder) { recorder.stop(); return; }
    if (!canRecord) { toast('Microphone recording is not available in this browser.', 'warn'); return; }
    try {
      stopRecognition();
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const preferredType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported?.(type));
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
        setVoiceStatus('Transcribing your voice locally…', 'processing');
        try {
          const blob = new Blob(chunks, { type: chunks[0]?.type || preferredType || 'audio/webm' });
          const text = await transcribe(blob, (message) => setVoiceStatus(message, 'processing'));
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
    if (!Recognition && !canRecord) {
      toast('Automatic listening needs microphone access in a supported browser (HTTPS).', 'warn');
      return;
    }
    unlockAudio();
    autoListening = !autoListening;
    wakeArmed = false;
    if (autoListening) {
      if (recorder) { try { recorder.stop(); } catch { /* ignore */ } }
      autoBtn.setAttribute('aria-pressed', 'true');
      autoBtn.textContent = 'LISTENING';
      setVoiceStatus('Starting microphone · say “XOFT” to begin a command.', 'listening');
      startRecognition();
    } else {
      stopRecognition();
      autoBtn.setAttribute('aria-pressed', 'false');
      autoBtn.textContent = 'WHISPER AUTO LISTEN';
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
    if (act === 'recent') toggleRecent();
    if (act === 'new-chat') startRecentChat();
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
    const session = event.target.closest('[data-session]');
    if (session) { openRecentChat(session.dataset.session); return; }
    const pin = event.target.closest('[data-pin]');
    if (pin) { togglePin(pin.dataset.pin); paintRecent(); return; }
    const del = event.target.closest('[data-delete]');
    if (del) { removeRecentChat(del.dataset.delete); return; }
  });
  recentSearch?.addEventListener('input', paintRecent);
  el.addEventListener('keydown', (event) => { if (event.key === 'Escape' && menuOpen) { setMenu(false); el.querySelector('[data-act="command"]').focus(); } });

  const onSpeechState = (event) => {
    const state = event.detail?.state;
    isSpeaking = state === 'speaking' || state === 'loading';
    if (isSpeaking) stopRecognition();
    if (state === 'loading') setVoiceStatus('Preparing XOFT voice…', 'processing');
    if (state === 'speaking') setVoiceStatus('XOFT is speaking…', 'speaking');
    if (state === 'error') setVoiceStatus(event.detail?.detail || 'Audio playback failed. Tap SPEAK to retry.', 'error');
    if (state === 'idle' && !recorder) {
      if (autoListening && !destroyed) {
        setVoiceStatus('Ready · say “XOFT”, then your command.', 'listening');
        startRecognition();
      } else if (!store.get('chat').pending) setVoiceStatus('Ready.', 'idle');
    }
  };
  window.addEventListener('xoft:speech-state', onSpeechState);

  // Restore the latest saved conversation before the first render.
  hydrateFromStorage();
  paintExchanges();
  const unsub = store.subscribe('chat', paintExchanges);
  // Restore server history when local storage is empty. This request is background-only
  // so opening the Command Centre remains responsive and never calls an AI model.
  void api.get('/api/chats/' + encodeURIComponent(sessionId()))
    .then((saved) => {
      if (!store.get('chat').exchanges.length && Array.isArray(saved.messages) && saved.messages.length) {
        const restored = [];
        for (const msg of saved.messages) {
          if (!msg || typeof msg.content !== 'string') continue;
          if (msg.role === 'user') {
            restored.push({ user: msg.content, reply: '', status: 'done', ts: Date.parse(msg.at) || Date.now() });
          } else if (msg.role === 'assistant') {
            const last = restored[restored.length - 1];
            if (last && !last.reply) last.reply = msg.content;
            else restored.push({ user: '', reply: msg.content, status: 'done', ts: Date.parse(msg.at) || Date.now() });
          }
        }
        store.set('chat', { pending: false, exchanges: restored.filter((x) => x.user || x.reply).slice(-100) });
      }
    })
    .catch((error) => console.warn('[XOFT] Server history unavailable; keeping local history:', error))
    .finally(() => { serverHistoryReady = true; });
  return () => {
    destroyed = true;
    autoListening = false;
    stopRecognition();
    window.removeEventListener('xoft:speech-state', onSpeechState);
    clearTimeout(historySaveTimer);
    try { recorder?.stop(); } catch { /* ignore */ }
    stream?.getTracks().forEach((track) => track.stop());
    unsub();
  };
}
