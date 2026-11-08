import { api } from '../api.js';
import { esc, toast, onDelegate } from '../dom.js';
import { canSpeakOut, isSpeakOutEnabled, setSpeakOutEnabled, speakOut, stopSpeaking } from '../voice/speak-out.js';
import { claimAutoVoiceStart } from '../voice/auto-start.js';

export const title = 'Live Conversation';
export let cleanup = null;

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
  const navList = document.querySelector('#nav-recent-chat-list');
  if (!list && !navList) return;
  const navSearch = document.querySelector('#nav-recent-chat-search');
  const q = String(query || navSearch?.value || '').trim().toLowerCase();
  const sessions = recentSessions().filter(item => !q || item.title.toLowerCase().includes(q));
  const empty = '<div class="empty">No saved chats yet.</div>';
  if (list) list.innerHTML = sessions.map(item => '<button type="button" class="recent-chat-item ' + (item.id === sessionId() ? 'active' : '') + '" data-recent-session="' + esc(item.id) + '"><strong>' + esc(item.title) + '</strong><small>' + esc(new Date(item.updatedAt).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})) + '</small></button>').join('') || empty;
  if (navList) navList.innerHTML = sessions.slice(0, 30).map(item => '<button type="button" class="nav-recent-item ' + (item.id === sessionId() ? 'active' : '') + '" data-nav-recent-session="' + esc(item.id) + '"><span>' + esc(item.title) + '</span></button>').join('') || empty;
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

if (!window.__xoftNavRecentSearchBound) {
  window.__xoftNavRecentSearchBound = true;
  document.addEventListener('input', (event) => {
    if (event.target?.id !== 'nav-recent-chat-search') return;
    renderRecentChats(document.querySelector('#content'), event.target.value);
  });
}

if (!window.__xoftNavRecentBound) {
  window.__xoftNavRecentBound = true;
  document.addEventListener('click', (event) => {
    const item = event.target.closest('[data-nav-recent-session]');
    if (!item) return;
    const id = item.dataset.navRecentSession;
    if (!id) return;
    localStorage.setItem(SESSION_KEY, id);
    history = readHistory(id);
    const content = document.querySelector('#content');
    if (location.hash.split('?')[0] === '#chat') render(content);
    else location.hash = 'chat';
  });
}

if (!window.__xoftNewChatBound) {
  window.__xoftNewChatBound = true;
  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-new-chat]')) return;
    const id = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, id);
    history = [];
    persistHistory();
    const content = document.querySelector('#content');
    if (location.hash.split('?')[0] === '#chat') render(content);
    else location.hash = 'chat';
  });
}

export function render(container) {
  const resumeVoice = voiceConversationActive;
  stopLiveVideo(container, true);
  if (voiceConversationActive) stopVoiceConversation(container, true);
  container.innerHTML = `
    <div class="chat-layout chat-voice-home">
      <section class="chat-main-panel">
        <header class="chat-home-heading">
          <div class="tabs" aria-label="Conversation mode">
            <button data-mode="chat" class="${mode === 'chat' ? 'active' : ''}">Chat</button>
            <button data-mode="advise" class="${mode === 'advise' ? 'active' : ''}">Advisor</button>
          </div>
        </header>

        <section class="xoft-voice-stage" aria-label="Live voice conversation">
          <div id="xoft-voice-status" class="xoft-voice-status" data-state="idle" role="status" aria-live="polite" aria-label="XOFT voice status: standby">
            <span class="xoft-voice-orb" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
            <span class="xoft-voice-status-copy">
              <strong class="xoft-voice-status-label">VOICE STARTING</strong>
              <small>Checking microphone and voice services</small>
            </span>
            <span class="xoft-voice-live-dot" aria-hidden="true"></span>
          </div>
          <div class="xoft-voice-stage-copy">
            <h3>I'm listening.</h3>
          </div>
        </section>

        <section id="chat-view" aria-label="Conversation transcript and message composer">
          <section id="xoft-live-video" class="xoft-live-video" hidden aria-label="XOFT live video conversation">
            <div class="xoft-live-video-frame"><video id="xoft-live-camera" autoplay playsinline muted></video><div class="xoft-live-video-overlay"><span class="xoft-live-badge"><i></i> LIVE CONVERSATION</span><strong id="xoft-live-video-state">Speak naturally. XOFT is listening.</strong><small>Your words are saved to Chats, not shown over the video.</small></div></div>
            <div class="xoft-live-video-controls"><span id="xoft-live-video-caption">Camera ready · waiting for microphone</span><button id="chat-live-video-stop" type="button" class="primary">End Live Conversation</button></div>
          </section>
          <div class="chat-transcript-heading"><strong>Conversation</strong></div>
          <div id="chat-log"></div>
          <div class="chat-voice-tools" aria-label="Additional voice controls">
            <button id="chat-mic" type="button" title="Dictate a message into the composer" aria-label="Voice input">Dictate</button>
            <button id="chat-live-video" type="button" title="Start a camera-based live voice conversation" aria-label="Start live video">Live video</button>
            <button id="chat-speak-toggle" type="button" aria-pressed="${isSpeakOutEnabled()}" ${canSpeakOut() ? '' : 'disabled'}>${isSpeakOutEnabled() ? 'Speak Out: ON' : 'Speak Out: OFF'}</button>
            <button id="chat-speak-stop" type="button" ${canSpeakOut() ? '' : 'disabled'}>Stop audio</button>
          </div>
          <div id="chat-input-row">
            <textarea id="chat-input" placeholder="${mode === 'chat' ? 'Ask XOFT' : 'Describe a problem'}" aria-label="Message XOFT" rows="1"></textarea>
            <button id="chat-send" class="primary" aria-label="Send message" title="Send message">↑</button>
            <button id="chat-voice-conversation" type="button" aria-pressed="false" aria-label="Start live voice" title="Start or pause live voice">Voice</button>
            <button id="chat-voice-end" type="button" aria-label="End live voice" title="End live voice">×</button>
          </div>
        </section>
      </section>




    </div>
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

  onDelegate(container, 'click', '[data-recent-session]', (el) => { localStorage.setItem(SESSION_KEY, el.dataset.recentSession); history = readHistory(el.dataset.recentSession); render(container); });
  onDelegate(container, 'click', '[data-mode]', (el) => {
    mode = el.dataset.mode;
    render(container);
  });

  onDelegate(container, 'click', '#chat-send', () => send(container));
  onDelegate(container, 'click', '#chat-mic', () => toggleVoiceInput(container));
  onDelegate(container, 'click', '#chat-voice-conversation', () => toggleVoiceConversation(container));
  onDelegate(container, 'click', '#chat-voice-end', () => stopVoiceConversation(container));
  onDelegate(container, 'click', '#chat-live-video', () => startLiveVideo(container));
  onDelegate(container, 'click', '#chat-live-video-stop', () => stopLiveVideo(container));
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

  cleanup = () => {
    stopLiveVideo(container, true);
    if (voiceConversationActive) stopVoiceConversation(container, true);
    cleanup = null;
  };

  // Start live voice on each fresh app load. If the user is already in a live
  // session and the chat view rerenders, resume it after the DOM is rebuilt.
  const shouldStartVoice = resumeVoice || claimAutoVoiceStart();
  if (shouldStartVoice) {
    const startVoice = () => {
      if (!container.isConnected || voiceConversationActive) return;
      toggleVoiceConversation(container);
    };
    if (document.visibilityState === 'hidden') {
      const onVisible = () => {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', onVisible);
        startVoice();
      };
      document.addEventListener('visibilitychange', onVisible);
    } else {
      queueMicrotask(startVoice);
    }
  }
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


// STT: XOFT server transcription (Gemini primary, OpenAI fallback).
import { transcribe as transcribeAudioBlob, warmVoiceServer } from '../voice/stt.js';
import { createLevelMeter, createSpeechGate, preferredRecorderOptions, unlockAudio } from '../voice/listen.js';
let voiceRecorder = null;
let voiceStream = null;
let voiceChunks = [];
let voiceBusy = false;
let voiceConversationActive = false;
let voiceConversationTimer = null;
let voiceFallbackNoticeShown = false;
let liveVideoStream = null;

function setVoiceStatus(state, label) {
  window.dispatchEvent(new CustomEvent('xoft:voice-state', { detail: { state, label } }));
  // Live video shows only listening/thinking/speaking state; never show recognized words or interim captions.
  if (liveVideoStream) {
    const caption = document.querySelector('#xoft-live-video-caption');
    if (caption) {
      const statusText = {
        listening: 'Listening · speak naturally',
        thinking: 'XOFT is thinking · preparing a reply',
        speaking: 'XOFT is speaking · your turn next',
        idle: 'Live conversation paused',
      };
      caption.textContent = statusText[state] || 'Live conversation active';
      const overlayState = document.querySelector('#xoft-live-video-state');
      if (overlayState) overlayState.textContent = statusText[state] || 'Live conversation active';
    }
  }
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

async function startVoiceRecording(container, { autoSegment = false } = {}) {
  void warmVoiceServer();
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

    voiceStream = stream;
    voiceChunks = chunks;
    voiceRecorder = recorder;

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
      if (voiceRecorder === recorder) voiceRecorder = null;
      if (voiceStream === stream) voiceStream = null;
      if (voiceChunks === chunks) voiceChunks = [];
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
        voiceBusy = false;
        return;
      }
      if (conversationSegment && !detectedSpeech) {
        voiceBusy = false;
        setMicButton(container, 'Voice Input');
        scheduleConversationListen(container, 450);
        return;
      }
      if (!blob.size) {
        voiceBusy = false;
        setMicButton(container, 'Voice Input');
        if (conversationSegment && voiceConversationActive) scheduleConversationListen(container, 450);
        else toast('The recording was empty. Please try again.', 'warn');
        return;
      }

      voiceBusy = true;
      setVoiceStatus('thinking', 'TRANSCRIBING YOUR VOICE');
      setMicButton(container, 'Transcribing your voice…', true);
      if (!conversationSegment) {
        toast('Sending audio to XOFT for transcription.', 'info');
      } else {
        setConversationButton(container, true, 'Transcribing your voice…');
      }

      let voiceText = '';
      try {
        const transcript = await transcribeAudioBlob(blob, (message) => {
          if (/Sending audio to XOFT/i.test(message)) {
            setVoiceStatus('thinking', 'SENDING AUDIO TO XOFT');
          } else if (/Transcribed by XOFT/i.test(message)) {
            setVoiceStatus('thinking', 'TRANSCRIPTION READY · XOFT');
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
          toast('XOFT did not detect speech. Try recording again.', 'warn');
        }
      } catch (error) {
        console.error('[XOFT] Speech recognition failed:', error);
        toast(`Speech recognition failed: ${String(error?.message || 'unknown error').slice(0, 220)}`, 'warn');
        if (conversationSegment && voiceConversationActive) stopVoiceConversation(container, true);
      } finally {
        voiceBusy = false;
        setMicButton(container, 'Voice Input');
      }

      if (voiceText && voiceConversationActive) {
        await send(container, voiceText, { voiceTurn: true });
      } else if (conversationSegment && voiceConversationActive) {
        scheduleConversationListen(container, 450);
      }
    };

    // A short timeslice makes mobile MediaRecorder flush audio reliably during long sessions.
    recorder.start(250);

    if (conversationSegment) {
      setVoiceStatus('listening', 'LISTENING · MICROPHONE ACTIVE');
      setConversationButton(container, true, 'Listening for your voice…');
      setMicButton(container, 'Listening for your voice…', true);
      // Endpointing: stop after 650 ms of silence, after 8 s with no speech, or after 15 s total.
      // Uses the shared unlocked AudioContext and an adaptive noise-floor threshold (see voice/listen.js).
      unlockAudio();
      meter = createLevelMeter(stream);
      const gate = createSpeechGate({ minThreshold: 0.002, floorMultiplier: 2.5 });
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
        if ((detectedSpeech && now - lastVoiceAt > 650) || (!detectedSpeech && elapsed > 8000) || elapsed > 15000) recorder.stop();
      }, 50);
    } else {
      setMicButton(container, 'Recording… tap to stop', true);
      toast('Recording started. Tap the microphone button again to stop and transcribe.', 'info');
    }
  } catch (error) {
    console.error('[XOFT] Microphone capture failed:', error);
    setMicButton(container, 'Voice Input');
    toast('Microphone permission was denied or unavailable. Allow microphone access and try again.', 'warn');
    if (conversationSegment && voiceConversationActive) stopVoiceConversation(container, true);
  }
}

function toggleVoiceInput(container) {
  unlockAudio();
  if (voiceConversationActive) stopVoiceConversation(container, true);
  if (voiceBusy) return;
  if (voiceRecorder && voiceRecorder.state !== 'inactive') {
    voiceRecorder.stop();
    return;
  }
  // Use only local microphone capture and XOFT server transcription.
  startVoiceRecording(container);
}

function stopLiveVideo(container, silent = false) {
  const panel = container.querySelector('#xoft-live-video');
  const video = container.querySelector('#xoft-live-camera');
  if (liveVideoStream) {
    liveVideoStream.getTracks().forEach((track) => track.stop());
    liveVideoStream = null;
  }
  if (video) video.srcObject = null;
  if (panel) panel.hidden = true;
  container.querySelector('.chat-layout')?.classList.remove('xoft-video-active');
  const log = container.querySelector('#chat-log');
  const inputRow = container.querySelector('#chat-input-row');
  if (log) log.hidden = false;
  if (inputRow) inputRow.hidden = false;
  if (voiceConversationActive) stopVoiceConversation(container, true);
  if (!silent && panel) toast('Live video conversation ended. Your conversation is available in Chats.', 'info');
}

async function startLiveVideo(container) {
  if (liveVideoStream) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Live video needs camera access in a supported HTTPS browser.', 'warn');
    return;
  }
  const button = container.querySelector('#chat-live-video');
  if (button) { button.disabled = true; button.textContent = 'Opening camera…'; }
  try {
    // Keep camera capture separate from microphone capture so the existing STT pipeline
    // can apply its Gemini → OpenAI server transcription fallback without recording video.
    liveVideoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    const panel = container.querySelector('#xoft-live-video');
    const video = container.querySelector('#xoft-live-camera');
    if (!panel || !video) throw new Error('Live video panel is unavailable.');
    video.srcObject = liveVideoStream;
    panel.hidden = false;
    container.querySelector('.chat-layout')?.classList.add('xoft-video-active');
    const log = container.querySelector('#chat-log');
    const inputRow = container.querySelector('#chat-input-row');
    if (log) log.hidden = true;
    if (inputRow) inputRow.hidden = true;
    const caption = container.querySelector('#xoft-live-video-caption');
    if (caption) caption.textContent = 'Camera on · enabling hands-free conversation';
    // toggleVoiceConversation enables speak-out and starts the established server-first STT loop.
    toggleVoiceConversation(container);
    if (caption) caption.textContent = 'Listening · your words are saved in Chats, not displayed over video';
  } catch (error) {
    console.error('[XOFT] Could not start live video conversation:', error);
    stopLiveVideo(container, true);
    toast(error?.name === 'NotAllowedError'
      ? 'Camera permission was denied. Allow camera access and try again.'
      : 'Could not start live video. Check camera permission and try again.', 'warn');
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Live Video'; }
  }
}

function setConversationButton(container, active, label = '') {
  const button = container.querySelector('#chat-voice-conversation');
  if (!button) return;
  button.setAttribute('aria-pressed', String(active));
  button.textContent = label || (active ? 'Stop Voice Conversation' : 'Start Voice Conversation');
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
  if (voiceRecorder && voiceRecorder.state !== 'inactive') {
    try { voiceRecorder.stop(); } catch {}
  }
  setConversationButton(container, false);
  setVoiceStatus('idle', 'VOICE STANDBY');
  setMicButton(container, 'Voice Input');
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
  if (!voiceConversationActive || voiceBusy || (voiceRecorder && voiceRecorder.state !== 'inactive')) return;
  if (activeRecognition) return;

  // Hands-free mode uses the same local voice path as push-to-talk.
  // This avoids relying on vendor-specific browser recognition services.
  if (!voiceFallbackNoticeShown) {
    voiceFallbackNoticeShown = true;
    toast('Voice conversation uses XOFT server transcription (Gemini → OpenAI fallback).', 'info');
  }
  startVoiceRecording(container, { autoSegment: true });
  return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    startVoiceRecording(container, { autoSegment: true });
    return;
  }
  const recognition = new SpeechRecognition();
  activeRecognition = recognition;
  recognition.lang = navigator.language || 'en-NG';
  recognition.continuous = false;
  recognition.interimResults = true;
  let finalText = '';
  let fallbackToVoice = false;
  let permissionDenied = false;
  setVoiceStatus('listening', 'LISTENING · SPEAK NATURALLY');
  setConversationButton(container, true, 'Listening… speak naturally');

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
    setConversationButton(container, true, 'Hearing you…');
  };

  recognition.onerror = (event) => {
    if (['network', 'service-not-allowed', 'language-not-supported'].includes(event.error)) {
      fallbackToVoice = true;
    } else if (['not-allowed', 'audio-capture'].includes(event.error)) {
      permissionDenied = true;
      toast('Microphone access is blocked. Allow microphone permission, then start Voice Conversation again.', 'warn');
    } else if (event.error === 'no-speech') {
      // Normal in a conversation: a silent turn just starts a fresh listen.
    } else if (event.error !== 'aborted') {
      fallbackToVoice = true;
    }
  };

  recognition.onend = () => {
    if (activeRecognition === recognition) activeRecognition = null;
    if (!voiceConversationActive) return;
    if (permissionDenied) {
      stopVoiceConversation(container, true);
      return;
    }
    if (fallbackToVoice) {
      if (!voiceFallbackNoticeShown) {
        voiceFallbackNoticeShown = true;
        toast('Browser speech service is unavailable. Switching to direct XOFT microphone capture.', 'warn');
      }
      startVoiceRecording(container, { autoSegment: true });
      return;
    }
    if (finalText.trim()) {
      const input = container.querySelector('#chat-input');
      if (input) input.value = '';
      setVoiceStatus('thinking', 'XOFT IS THINKING');
      setConversationButton(container, true, 'XOFT is thinking…');
      void send(container, finalText.trim(), { voiceTurn: true });
      return;
    }
    setConversationButton(container, true, 'Listening… speak naturally');
    scheduleConversationListen(container, 500);
  };

  try {
    recognition.start();
  } catch {
    activeRecognition = null;
    if (!voiceFallbackNoticeShown) {
      voiceFallbackNoticeShown = true;
      toast('Starting direct XOFT microphone capture because browser speech could not start.', 'warn');
    }
    startVoiceRecording(container, { autoSegment: true });
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
  setVoiceStatus('thinking', 'REQUESTING MICROPHONE');
  setConversationButton(container, true, 'Allow microphone access…');
  toast('Voice conversation is on. Speak naturally; XOFT will answer aloud and then listen again. Tap Stop Voice Conversation to finish.', 'success');
  listenForConversationTurn(container);
}
async function captureLiveVideoContext(container, question) {
  const video = container.querySelector('#xoft-live-camera');
  if (!liveVideoStream || !video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return '';
  try {
    const canvas = document.createElement('canvas');
    const sourceWidth = video.videoWidth || 640;
    const sourceHeight = video.videoHeight || 480;
    const scale = Math.min(1, 640 / sourceWidth, 480 / sourceHeight);
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return '';
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.62);
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const result = await api.post('/api/vision/live-frame', { base64, mimeType: 'image/jpeg', question });
    return String(result?.summary || '').trim().slice(0, 1200);
  } catch (error) {
    console.info('[XOFT] Live vision is unavailable for this turn; continuing voice-only:', error?.message || error);
    const caption = container.querySelector('#xoft-live-video-caption');
    if (caption) caption.textContent = 'Voice conversation active · visual understanding unavailable';
    return '';
  }
}

async function send(container, textOverride = null, { voiceTurn = false } = {}) {
  const input = container.querySelector('#chat-input');
  if (!input) return;
  const typedText = input.value.trim();
  const text = textOverride !== null && voiceTurn
    ? [typedText, String(textOverride).trim()].filter(Boolean).join(' ')
    : String(textOverride ?? input.value).trim();
  const continueLiveVoice = voiceConversationActive;
  if (!text) {
    if (voiceTurn && voiceConversationActive) scheduleConversationListen(container, 500);
    return;
  }
  input.value = '';
  if (voiceTurn || continueLiveVoice) setVoiceStatus('thinking', 'XOFT IS THINKING');
  history.push({ role: 'user', content: text, at: new Date().toISOString() });
  persistHistory();
  renderLog(container);

  let responseToSpeak = '';
  try {
    const endpoint = mode === 'chat' ? '/api/chat' : '/api/advise';
    const body = mode === 'chat' ? { message: text, sessionId: sessionId() } : { problem: text };
    if (mode === 'chat' && liveVideoStream) {
      const visualContext = await captureLiveVideoContext(container, text);
      if (visualContext) body.message = text + '\n\n[Current camera-frame context, for this turn only: ' + visualContext + ']';
    }
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
  if ((voiceTurn || continueLiveVoice) && voiceConversationActive) {
    setVoiceStatus('listening', 'LISTENING · YOUR TURN');
    setConversationButton(container, true, 'Listening… speak naturally');
    scheduleConversationListen(container, 500);
  }
}
