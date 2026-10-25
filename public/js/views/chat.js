import { api } from '../api.js';
import { esc, toast, onDelegate } from '../dom.js';
import { canSpeakOut, isSpeakOutEnabled, setSpeakOutEnabled, speakOut, stopSpeaking } from '../voice/speak-out.js';

export const title = 'Chat';

const SESSION_KEY = 'xoft_chat_session';
function sessionId() {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(SESSION_KEY, id); }
  return id;
}

let mode = 'chat'; // 'chat' | 'advise'
const RECENT_KEY = 'xoft_recent_chat_sessions_v1';
function historyKey(id = sessionId()) { return 'xoft_chat_history_' + id; }
function readHistory(id = sessionId()) { try { return JSON.parse(localStorage.getItem(historyKey(id)) || '[]'); } catch { return []; } }
let history = readHistory();
function recentSessions() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } }
let serverHistoryReady = false;
let serverHistorySaveTimer = null;
function persistHistory() {
  try {
    const messages = history.slice(-300);
    localStorage.setItem(historyKey(), JSON.stringify(messages));
    const list = recentSessions().filter(item => item.id !== sessionId());
    list.unshift({ id: sessionId(), title: history.find(m => m.role === 'user')?.content?.slice(0, 44) || 'New chat', updatedAt: new Date().toISOString() });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 40)));
    renderRecentChats(document.querySelector('#content'));
    if (serverHistoryReady) {
      clearTimeout(serverHistorySaveTimer);
      const id = sessionId();
      serverHistorySaveTimer = setTimeout(() => {
        void api.put('/api/chats/' + encodeURIComponent(id), { messages })
          .catch(error => console.warn('[XOFT] Server chat sync failed; local history remains saved:', error));
      }, 250);
    }
  } catch { /* preserve chat usability when storage is full */ }
}
function renderRecentChats(root, query = '') {
  const list = root?.querySelector('#recent-chat-list');
  if (!list) return;
  const q = query.trim().toLowerCase();
  const sessions = recentSessions().filter(item => !q || item.title.toLowerCase().includes(q));
  list.innerHTML = sessions.map(item => '<button type="button" class="recent-chat-item ' + (item.id === sessionId() ? 'active' : '') + '" data-recent-session="' + esc(item.id) + '"><strong>' + esc(item.title) + '</strong><small>' + esc(new Date(item.updatedAt).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})) + '</small></button>').join('') || '<div class="empty">No saved chats yet.</div>';
}
function formatChatText(value) {
  let text = esc(String(value ?? '').replace(/\r\n?/g, '\n'));
  const code = [];
  text = text.replace(/```([\w.+-]*)\n?([\s\S]*?)```/g, (_, lang, body) => `%%CODE${code.push('<pre class="chat-code"><code>' + body.trimEnd() + '</code></pre>') - 1}%%`);
  text = text.replace(/`([^`\n]+)`/g, '<code class="chat-inline-code">$1</code>');
  text = text.replace(/^###\s+(.+)$/gm, '<h4>$1</h4>').replace(/^##\s+(.+)$/gm, '<h3>$1</h3>').replace(/^#\s+(.+)$/gm, '<h2>$1</h2>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  text = text.replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>');
  text = text.replace(/(<li>.*<\/li>\n?)+/g, match => '<ul>' + match.replace(/\n/g, '') + '</ul>');
  text = text.replace(/%%CODE(\d+)%%/g, (_, i) => code[Number(i)] || '');
  return text.split(/\n{2,}/).map(p => /^\s*<(h[234]|ul|pre)/.test(p.trim()) ? p : p.replace(/\n/g, '<br>')).join('');
}

export function render(container) {
  if (voiceConversationActive) stopVoiceConversation(container, true);
  container.innerHTML = `
    <div class="chat-layout"><aside class="chat-history-panel"><div class="chat-history-heading"><strong>Recent chats</strong><button id="chat-new" type="button" class="primary">+ New chat</button></div><input id="recent-chat-search" type="search" placeholder="Search recent chats…" aria-label="Search recent chats"><div id="recent-chat-list"></div><p class="chat-history-note">Saved locally. Opening a chat does not call AI or use tokens.</p></aside><section class="chat-main-panel">
    <div class="tabs">
      <button data-mode="chat" class="${mode === 'chat' ? 'active' : ''}">Chat</button>
      <button data-mode="advise" class="${mode === 'advise' ? 'active' : ''}">Advisor</button>
    </div>
    <div id="xoft-voice-status" class="xoft-voice-status" data-state="idle" role="status" aria-live="polite" aria-label="XOFT voice status: standby"><span class="xoft-voice-orb" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span class="xoft-voice-status-copy"><strong class="xoft-voice-status-label">VOICE STANDBY</strong><small>Live microphone and speech status</small></span><span class="xoft-voice-live-dot" aria-hidden="true"></span></div>
    <div id="chat-view">
      <div id="chat-log"></div>
      <div id="chat-input-row">
        <textarea id="chat-input" placeholder="${mode === 'chat' ? 'Ask XOFT to do something…' : 'Describe a problem to reason through…'}"></textarea>
        <button id="chat-send" class="primary">Send</button>
        <button id="chat-mic" type="button" title="Transcribe speech into the message box" aria-label="Voice input">🎙️ Voice Input</button>
        <button id="chat-voice-conversation" type="button" aria-pressed="false" title="Start a hands-free voice conversation">🗣️ Start Voice Conversation</button>
        <button id="chat-speak-toggle" type="button" aria-pressed="${isSpeakOutEnabled()}" ${canSpeakOut() ? '' : 'disabled'}>${isSpeakOutEnabled() ? 'Speak Out: ON' : 'Speak Out: OFF'}</button>
        <button id="chat-speak-stop" type="button" ${canSpeakOut() ? '' : 'disabled'}>Stop Speaking</button>
      </div>
    </div></section></div>
  `;
  renderLog(container);
  renderRecentChats(container);
  // Pull the owner's server-side chat index so saved conversations also appear
  // on another browser/device using the same XOFT API credentials.
  void api.get('/api/chats')
    .then((result) => {
      const remote = Array.isArray(result.sessions) ? result.sessions : [];
      if (!remote.length) return;
      const local = recentSessions();
      const merged = new Map(local.map((item) => [item.id, item]));
      for (const item of remote) {
        if (!item || typeof item.sessionId !== 'string') continue;
        const current = merged.get(item.sessionId);
        merged.set(item.sessionId, {
          id: item.sessionId,
          title: item.title || current?.title || 'Saved chat',
          updatedAt: item.updatedAt || current?.updatedAt || new Date().toISOString(),
        });
      }
      const sorted = [...merged.values()].sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0)).slice(0, 100);
      localStorage.setItem(RECENT_KEY, JSON.stringify(sorted));
      renderRecentChats(container);
    })
    .catch((error) => console.warn('[XOFT] Server recent chats unavailable; showing local chats:', error));
  serverHistoryReady = false;
  const openingSessionId = sessionId();
  void api.get('/api/chats/' + encodeURIComponent(openingSessionId))
    .then(saved => {
      if (sessionId() !== openingSessionId) return;
      const local = readHistory(openingSessionId);
      const remote = Array.isArray(saved.messages)
        ? saved.messages.filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').slice(-300)
        : [];
      const localLastAt = Date.parse(local.at(-1)?.at || '') || 0;
      const remoteLastAt = Date.parse(remote.at(-1)?.at || saved.updatedAt || '') || 0;

      // Restore the newest known copy instead of letting an old local cache silently
      // hide newer messages saved from another browser/device.
      if (remote.length && (!local.length || remoteLastAt > localLastAt)) {
        history = remote;
        localStorage.setItem(historyKey(openingSessionId), JSON.stringify(history));
        renderLog(container);
      } else {
        history = local;
      }
      renderRecentChats(container);
    })
    .catch(error => console.warn('[XOFT] Server chat history unavailable; using local copy:', error))
    .finally(() => {
      if (sessionId() !== openingSessionId) return;
      serverHistoryReady = true;
      // Upload an existing local-only/newer copy once the initial fetch has finished.
      // This also repairs a previous failed sync without requiring another user message.
      if (history.length) persistHistory();
    });

  onDelegate(container, 'click', '#chat-new', () => { const id = crypto.randomUUID(); localStorage.setItem(SESSION_KEY, id); history = []; persistHistory(); render(container); });
  onDelegate(container, 'click', '[data-recent-session]', (el) => { localStorage.setItem(SESSION_KEY, el.dataset.recentSession); history = readHistory(el.dataset.recentSession); render(container); });
  onDelegate(container, 'input', '#recent-chat-search', (el) => renderRecentChats(container, el.value));
  onDelegate(container, 'click', '[data-mode]', (el) => {
    mode = el.dataset.mode;
    render(container);
  });

  onDelegate(container, 'click', '#chat-send', () => send(container));
  onDelegate(container, 'click', '#chat-mic', () => toggleVoiceInput(container));
  onDelegate(container, 'click', '#chat-voice-conversation', () => toggleVoiceConversation(container));
  onDelegate(container, 'click', '#chat-speak-toggle', (button) => {
    const enabled = !isSpeakOutEnabled();
    setSpeakOutEnabled(enabled);
    window.dispatchEvent(new CustomEvent('xoft:speakout-change'));
    button.textContent = enabled ? 'Speak Out: ON' : 'Speak Out: OFF';
    button.setAttribute('aria-pressed', String(enabled));
    toast(enabled ? 'Speak Out enabled — XOFT replies will be read aloud.' : 'Speak Out disabled.', 'info');
  });
  onDelegate(container, 'click', '#chat-speak-stop', () => stopSpeaking());
  container.querySelector('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(container); }
  });
}

function renderLog(container) {
  history = readHistory();
  const log = container.querySelector('#chat-log');
  log.innerHTML = history.map((m) => `
    <div class="msg ${m.role}">
      <div class="meta">${m.role === 'user' ? 'You' : 'XOFT'}</div>
      <div class="message-content">${formatChatText(m.content)}</div>
    </div>
  `).join('') || '<div class="empty">Say something to get started.</div>';
  log.scrollTop = log.scrollHeight;
}


// STT: server Whisper (OpenAI, Gemini fallback) first; on-device Whisper only if the server path fails.
import { transcribe as transcribeAudioBlob } from '../voice/stt.js';
import { createLevelMeter, createSpeechGate, preferredRecorderOptions, unlockAudio } from '../voice/listen.js';
let activeRecognition = null;
let whisperRecorder = null;
let whisperStream = null;
let whisperChunks = [];
let whisperBusy = false;
let voiceConversationActive = false;
let voiceConversationTimer = null;
let voiceFallbackNoticeShown = false;

function setVoiceStatus(state, label) {
  window.dispatchEvent(new CustomEvent('xoft:voice-state', { detail: { state, label } }));
}

// Bind once: navigation/rerendering must not stack event listeners.
if (!window.__xoftVoiceStatusBound) {
  window.__xoftVoiceStatusBound = true;
  const paint = (state, label) => {
    const el = document.querySelector('#xoft-voice-status');
    if (!el) return;
    el.dataset.state = state;
    const text = el.querySelector('.xoft-voice-status-label');
    if (text) text.textContent = label;
    el.setAttribute('aria-label', 'XOFT voice status: ' + label);
  };
  window.addEventListener('xoft:voice-state', (e) => paint(e.detail?.state || 'idle', e.detail?.label || 'VOICE STANDBY'));
  window.addEventListener('xoft:voice-level', (e) => { const el = document.querySelector('#xoft-voice-status'); if (el && el.dataset.state === 'listening') el.style.setProperty('--voice-level', String(Math.max(0, Math.min(1, Number(e.detail?.level) || 0)))); });
  window.addEventListener('xoft:speech-state', (e) => {
    if (e.detail?.state === 'speaking') paint('speaking', 'XOFT IS SPEAKING');
    else if (e.detail?.state === 'loading') paint('thinking', 'PREPARING VOICE');
    else if (e.detail?.state === 'idle' && !document.querySelector('#chat-voice-conversation.voice-conversation-active')) paint('idle', 'VOICE STANDBY');
  });
}

function setMicButton(container, label, pressed = false) {
  const button = container.querySelector('#chat-mic');
  if (button) {
    button.textContent = label;
    button.setAttribute('aria-pressed', String(pressed));
  }
}

async function startWhisperRecording(container, { autoSegment = false } = {}) {
  const conversationSegment = Boolean(autoSegment && voiceConversationActive);
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    toast('Voice input needs microphone access in a supported browser. Open XOFT over HTTPS and allow microphone permission.', 'warn');
    if (conversationSegment) stopVoiceConversation(container, true);
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const chunks = [];
    const recorder = new MediaRecorder(stream, preferredRecorderOptions());
    let meter = null;
    let levelTimer = null;
    let audioContext = null;
    let rafId = null;
    let detectedSpeech = false;
    let lastVoiceAt = 0;
    const startedAt = Date.now();
    let finished = false;

    whisperStream = stream;
    whisperChunks = chunks;
    whisperRecorder = recorder;

    const cleanupAudio = async () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      clearInterval(levelTimer);
      meter?.close();
      meter = null;
      stream.getTracks().forEach(track => track.stop());
      if (audioContext && audioContext.state !== 'closed') {
        await audioContext.close().catch(() => {});
      }
      if (whisperRecorder === recorder) whisperRecorder = null;
      if (whisperStream === stream) whisperStream = null;
      if (whisperChunks === chunks) whisperChunks = [];
    };

    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };

    recorder.onstop = async () => {
      if (finished) return;
      finished = true;
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      await cleanupAudio();

      if (conversationSegment && !voiceConversationActive) {
        whisperBusy = false;
        return;
      }
      if (conversationSegment && !detectedSpeech) {
        whisperBusy = false;
        setMicButton(container, '🎙️ Voice Input');
        scheduleConversationListen(container, 450);
        return;
      }
      if (!blob.size) {
        whisperBusy = false;
        setMicButton(container, '🎙️ Voice Input');
        if (conversationSegment && voiceConversationActive) scheduleConversationListen(container, 450);
        else toast('The recording was empty. Please try again.', 'warn');
        return;
      }

      whisperBusy = true;
      setVoiceStatus('thinking', 'TRANSCRIBING YOUR VOICE');
      setMicButton(container, '⏳ Transcribing your voice…', true);
      if (!conversationSegment) {
        toast('Transcribing with Whisper. If the server provider is unavailable, XOFT falls back to on-device Whisper.', 'info');
      } else {
        setConversationButton(container, true, '⏳ Transcribing your voice…');
      }

      let voiceText = '';
      try {
        const transcript = await transcribeAudioBlob(blob, (message) => {
          if (/on-device Whisper/i.test(message)) {
            setVoiceStatus('thinking', 'SERVER UNAVAILABLE · LOCAL WHISPER');
          } else if (/Transcribing on XOFT server/i.test(message)) {
            setVoiceStatus('thinking', 'TRANSCRIBING ON XOFT SERVER');
          }
        });
        const input = container.querySelector('#chat-input');
        if (conversationSegment && voiceConversationActive && transcript) {
          voiceText = transcript.trim();
        } else if (!conversationSegment && input && transcript) {
          input.value = [input.value.trim(), transcript].filter(Boolean).join(' ').trim();
          input.focus();
          toast('Transcription ready. Review it, then tap Send.', 'success');
        } else if (!conversationSegment) {
          toast('Whisper did not detect speech. Try recording again.', 'warn');
        }
      } catch (error) {
        console.error('[XOFT] Speech recognition failed:', error);
        toast(`Speech recognition failed: ${String(error?.message || 'unknown error').slice(0, 220)}`, 'warn');
        if (conversationSegment && voiceConversationActive) stopVoiceConversation(container, true);
      } finally {
        whisperBusy = false;
        setMicButton(container, '🎙️ Voice Input');
      }

      if (voiceText && voiceConversationActive) {
        await send(container, voiceText, { voiceTurn: true });
      } else if (conversationSegment && voiceConversationActive) {
        scheduleConversationListen(container, 450);
      }
    };

    recorder.start();

    if (conversationSegment) {
      setVoiceStatus('listening', 'LISTENING · MICROPHONE ACTIVE');
      setConversationButton(container, true, '🟢 Listening for your voice…');
      setMicButton(container, '🟢 Listening for your voice…', true);
      // Endpointing: stop 1.2 s after speech ends, after 8 s with no speech, or after 15 s total.
      // Uses the shared unlocked AudioContext and an adaptive noise-floor threshold (see voice/listen.js).
      unlockAudio();
      meter = createLevelMeter(stream);
      const gate = createSpeechGate();
      levelTimer = setInterval(() => {
        if (!voiceConversationActive || recorder.state === 'inactive') { clearInterval(levelTimer); return; }
        const now = Date.now();
        const elapsed = now - startedAt;
        const rms = meter.read();
        if (rms === null) {
          // Analyser not running (suspended audio context): cannot detect silence, so send a time-capped clip instead of dropping it.
          detectedSpeech = true;
          if (elapsed > 6000) recorder.stop();
          return;
        }
        window.dispatchEvent(new CustomEvent('xoft:voice-level', { detail: { level: Math.min(1, rms / 0.18) } }));
        if (gate.update(rms)) { detectedSpeech = true; lastVoiceAt = now; }
        if ((detectedSpeech && now - lastVoiceAt > 1200) || (!detectedSpeech && elapsed > 8000) || elapsed > 15000) recorder.stop();
      }, 50);
    } else {
      setMicButton(container, '🔴 Recording for Whisper… tap to stop', true);
      toast('Recording started. Tap the microphone button again to stop and transcribe.', 'info');
    }
  } catch (error) {
    console.error('[XOFT] Microphone capture failed:', error);
    setMicButton(container, '🎙️ Voice Input');
    toast('Microphone permission was denied or unavailable. Allow microphone access and try again.', 'warn');
    if (conversationSegment && voiceConversationActive) stopVoiceConversation(container, true);
  }
}

function toggleVoiceInput(container) {
  unlockAudio();
  if (voiceConversationActive) stopVoiceConversation(container, true);
  if (whisperBusy) return;
  if (whisperRecorder && whisperRecorder.state !== 'inactive') {
    whisperRecorder.stop();
    return;
  }
  // Prefer the local Whisper engine over browser speech recognition. Browser
  // recognition varies by browser/vendor, often requires a network service, and
  // has been unreliable on mobile. Recording and transcription stay in this tab.
  if (activeRecognition) {
    try { activeRecognition.abort(); } catch {}
    activeRecognition = null;
  }
  startWhisperRecording(container);
  return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    startWhisperRecording(container);
    return;
  }
  const recognition = new SpeechRecognition();
  activeRecognition = recognition;
  recognition.lang = navigator.language || 'en-NG';
  recognition.continuous = false;
  recognition.interimResults = true;
  let finalText = '';
  let fallbackToWhisper = false;

  setVoiceStatus('listening', 'LISTENING · SPEAK NOW');
  setMicButton(container, '🔴 Listening… tap to stop', true);
  recognition.onresult = (event) => {
    const finalParts = [];
    const interimParts = [];
    for (let i = 0; i < event.results.length; i += 1) {
      const transcript = event.results[i][0]?.transcript || '';
      if (event.results[i].isFinal) finalParts.push(transcript);
      else interimParts.push(transcript);
    }
    finalText = finalParts.join(' ').trim();
    const input = container.querySelector('#chat-input');
    if (input) input.value = [finalText, interimParts.join(' ')].filter(Boolean).join(' ').trim();
  };
  recognition.onerror = (event) => {
    if (['network', 'service-not-allowed', 'language-not-supported'].includes(event.error)) {
      fallbackToWhisper = true;
      toast('Browser speech recognition is unavailable. Trying free on-device Whisper…', 'warn');
    } else if (['not-allowed', 'audio-capture'].includes(event.error)) {
      toast('Microphone access is blocked. Allow microphone permission in your browser settings.', 'warn');
    } else if (event.error === 'no-speech') {
      toast('No speech detected. Tap Voice Input and try again.', 'info');
    } else if (event.error !== 'aborted') {
      fallbackToWhisper = true;
      toast('Browser speech recognition failed. Trying free local Whisper…', 'warn');
    }
  };
  recognition.onend = () => {
    if (activeRecognition === recognition) activeRecognition = null;
    setMicButton(container, '🎙️ Voice Input');
    const input = container.querySelector('#chat-input');
    if (input && input.value.trim()) input.focus();
    if (fallbackToWhisper && !voiceConversationActive) startWhisperRecording(container);
  };
  try {
    recognition.start();
  } catch {
    activeRecognition = null;
    setMicButton(container, '🎙️ Voice Input');
    toast('Browser recognition could not start. Trying free local Whisper…', 'warn');
    startWhisperRecording(container);
  }
}

function setConversationButton(container, active, label = '') {
  const button = container.querySelector('#chat-voice-conversation');
  if (!button) return;
  button.setAttribute('aria-pressed', String(active));
  button.textContent = label || (active ? '⏹ Stop Voice Conversation' : '🗣️ Start Voice Conversation');
  button.classList.toggle('voice-conversation-active', active);
}

function stopVoiceConversation(container, silent = false) {
  voiceConversationActive = false;
  if (voiceConversationTimer) clearTimeout(voiceConversationTimer);
  voiceConversationTimer = null;
  if (activeRecognition) {
    const recognition = activeRecognition;
    activeRecognition = null;
    try { recognition.abort(); } catch {}
  }
  if (whisperRecorder && whisperRecorder.state !== 'inactive') {
    try { whisperRecorder.stop(); } catch {}
  }
  setConversationButton(container, false);
  setVoiceStatus('idle', 'VOICE STANDBY');
  setMicButton(container, '🎙️ Voice Input');
  if (!silent) toast('Voice conversation stopped.', 'info');
}

function scheduleConversationListen(container, delay = 500) {
  if (voiceConversationTimer) clearTimeout(voiceConversationTimer);
  voiceConversationTimer = setTimeout(() => {
    voiceConversationTimer = null;
    listenForConversationTurn(container);
  }, delay);
}

function listenForConversationTurn(container) {
  if (!voiceConversationActive || whisperBusy || (whisperRecorder && whisperRecorder.state !== 'inactive')) return;
  if (activeRecognition) return;

  // Hands-free mode uses the same local Whisper path as push-to-talk.
  // This avoids relying on vendor-specific browser recognition services.
  if (!voiceFallbackNoticeShown) {
    voiceFallbackNoticeShown = true;
    toast('Voice conversation uses XOFT server transcription (OpenAI → Gemini fallback); local Whisper is the offline fallback.', 'info');
  }
  startWhisperRecording(container, { autoSegment: true });
  return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    startWhisperRecording(container, { autoSegment: true });
    return;
  }
  const recognition = new SpeechRecognition();
  activeRecognition = recognition;
  recognition.lang = navigator.language || 'en-NG';
  recognition.continuous = false;
  recognition.interimResults = true;
  let finalText = '';
  let fallbackToWhisper = false;
  let permissionDenied = false;
  setVoiceStatus('listening', 'LISTENING · SPEAK NATURALLY');
  setConversationButton(container, true, '🟢 Listening… speak naturally');

  recognition.onresult = (event) => {
    const finalParts = [];
    const interimParts = [];
    for (let i = 0; i < event.results.length; i += 1) {
      const transcript = event.results[i][0]?.transcript || '';
      if (event.results[i].isFinal) finalParts.push(transcript);
      else interimParts.push(transcript);
    }
    finalText = finalParts.join(' ').trim();
    const input = container.querySelector('#chat-input');
    if (input) input.value = [finalText, interimParts.join(' ')].filter(Boolean).join(' ').trim();
    setVoiceStatus('listening', 'HEARING YOU');
    setConversationButton(container, true, '🟢 Hearing you…');
  };

  recognition.onerror = (event) => {
    if (['network', 'service-not-allowed', 'language-not-supported'].includes(event.error)) {
      fallbackToWhisper = true;
    } else if (['not-allowed', 'audio-capture'].includes(event.error)) {
      permissionDenied = true;
      toast('Microphone access is blocked. Allow microphone permission, then start Voice Conversation again.', 'warn');
    } else if (event.error === 'no-speech') {
      // Normal in a conversation: a silent turn just starts a fresh listen.
    } else if (event.error !== 'aborted') {
      fallbackToWhisper = true;
    }
  };

  recognition.onend = () => {
    if (activeRecognition === recognition) activeRecognition = null;
    if (!voiceConversationActive) return;
    if (permissionDenied) {
      stopVoiceConversation(container, true);
      return;
    }
    if (fallbackToWhisper) {
      if (!voiceFallbackNoticeShown) {
        voiceFallbackNoticeShown = true;
        toast('Browser speech service is unavailable. Switching to free local Whisper.', 'warn');
      }
      startWhisperRecording(container, { autoSegment: true });
      return;
    }
    if (finalText.trim()) {
      const input = container.querySelector('#chat-input');
      if (input) input.value = '';
      setVoiceStatus('thinking', 'XOFT IS THINKING');
      setConversationButton(container, true, '⏳ XOFT is thinking…');
      void send(container, finalText.trim(), { voiceTurn: true });
      return;
    }
    setConversationButton(container, true, '🟢 Listening… speak naturally');
    scheduleConversationListen(container, 500);
  };

  try {
    recognition.start();
  } catch {
    activeRecognition = null;
    if (!voiceFallbackNoticeShown) {
      voiceFallbackNoticeShown = true;
      toast('Starting free local Whisper as the browser speech service could not start.', 'warn');
    }
    startWhisperRecording(container, { autoSegment: true });
  }
}

function toggleVoiceConversation(container) {
  unlockAudio();
  if (voiceConversationActive) {
    stopVoiceConversation(container);
    return;
  }
  if (activeRecognition) {
    const previous = activeRecognition;
    activeRecognition = null;
    try { previous.abort(); } catch {}
  }
  // Voice conversation must have speech output enabled, and all Speak Out controls
  // must immediately reflect the same persisted setting.
  setSpeakOutEnabled(true);
  window.dispatchEvent(new CustomEvent('xoft:speakout-change'));
  const speakToggle = container.querySelector('#chat-speak-toggle');
  if (speakToggle) {
    speakToggle.textContent = 'Speak Out: ON';
    speakToggle.setAttribute('aria-pressed', 'true');
  }
  voiceFallbackNoticeShown = false;
  voiceConversationActive = true;
  setVoiceStatus('listening', 'STARTING MICROPHONE');
  setConversationButton(container, true, '🟢 Starting voice conversation…');
  toast('Voice conversation is on. Speak naturally; XOFT will answer aloud and then listen again. Tap Stop Voice Conversation to finish.', 'success');
  listenForConversationTurn(container);
}
async function send(container, textOverride = null, { voiceTurn = false } = {}) {
  const input = container.querySelector('#chat-input');
  if (!input) return;
  const text = String(textOverride ?? input.value).trim();
  if (!text) {
    if (voiceTurn && voiceConversationActive) scheduleConversationListen(container, 500);
    return;
  }
  input.value = '';
  if (voiceTurn) setVoiceStatus('thinking', 'XOFT IS THINKING');
  history.push({ role: 'user', content: text, at: new Date().toISOString() });
  persistHistory();
  renderLog(container);

  let responseToSpeak = '';
  try {
    const endpoint = mode === 'chat' ? '/api/chat' : '/api/advise';
    const body = mode === 'chat' ? { message: text, sessionId: sessionId() } : { problem: text };
    const result = await api.post(endpoint, body);
    if (result.__queued) {
      responseToSpeak = '(offline — this message is queued and will send once back online)';
      history.push({ role: 'assistant', content: responseToSpeak, at: new Date().toISOString() });
      persistHistory();
    } else {
      responseToSpeak = String(result.reply ?? result.advice ?? JSON.stringify(result));
      history.push({ role: 'assistant', content: responseToSpeak, at: new Date().toISOString() });
      persistHistory();
    }
  } catch (err) {
    // Turn provider failures into readable messages without hiding real errors.
    let friendly = null;
    try {
      const body = JSON.parse(String(err.message).replace(/^\d{3}\s+/, ''));
      if (body?.error === 'NO_AI_PROVIDER_AVAILABLE') {
        friendly = 'No AI model is available right now. Voice input and speech output are free, but XOFT still needs an available AI model to answer. Connect a free-tier provider or a free model gateway in Settings → AI providers.';
      } else if (body?.error === 'AI_PROVIDERS_FAILED') {
        const providerAdvice = (body.attempts ?? []).map((attempt) => {
          const name = ({ openai: 'OpenAI', gemini: 'Gemini', claude: 'Claude', grok: 'Grok', ollama: 'Ollama', experiential: 'Experiential Labs', freellmapi: 'FreeLLMAPI', litellm: 'LiteLLM' })[attempt.provider] ?? attempt.provider;
          if (attempt.errorType === 'rate_limit') return name + ' hit a rate, usage, or quota limit.';
          if (attempt.errorType === 'auth') return name + ' rejected its credentials.';
          if (attempt.errorType === 'invalid_request') return name + ' rejected its model or request.';
          if (['timeout', 'unavailable', 'server_error'].includes(attempt.errorType)) return name + ' is temporarily unavailable.';
          return name + ' failed; check its configuration.';
        });
        friendly = ['XOFT is running, but its configured AI providers could not answer.', ...providerAdvice, 'XOFT still needs at least one working AI provider for replies.'].join(' ');
      }
    } catch { /* not a structured AI error */ }
    responseToSpeak = friendly ?? ('Error: ' + err.message);
    history.push({ role: 'assistant', content: responseToSpeak, at: new Date().toISOString() });
    persistHistory();
    toast(friendly ? 'AI is unavailable' : err.message, friendly ? 'warn' : 'err');
  }

  renderLog(container);
  if (responseToSpeak && isSpeakOutEnabled()) {
    const spoke = await speakOut(responseToSpeak);
    if (voiceTurn && voiceConversationActive && !spoke && canSpeakOut()) {
      // Speech output may be disabled by device/browser policy; do not block the listening loop.
      console.info('[XOFT] Speech output was unavailable; continuing voice conversation.');
    }
  }
  if (voiceTurn && voiceConversationActive) {
    setVoiceStatus('listening', 'LISTENING · YOUR TURN');
    setConversationButton(container, true, '🟢 Listening… speak naturally');
    scheduleConversationListen(container, 500);
  }
}
