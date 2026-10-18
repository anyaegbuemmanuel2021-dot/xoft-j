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
function persistHistory() {
  try {
    localStorage.setItem(historyKey(), JSON.stringify(history.slice(-300)));
    const list = recentSessions().filter(item => item.id !== sessionId());
    list.unshift({ id: sessionId(), title: history.find(m => m.role === 'user')?.content?.slice(0, 44) || 'New chat', updatedAt: new Date().toISOString() });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 40)));
    renderRecentChats(document.querySelector('#content'));
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
  container.innerHTML = `
    <div class="chat-layout"><aside class="chat-history-panel"><div class="chat-history-heading"><strong>Recent chats</strong><button id="chat-new" type="button" class="primary">+ New chat</button></div><input id="recent-chat-search" type="search" placeholder="Search recent chats…" aria-label="Search recent chats"><div id="recent-chat-list"></div><p class="chat-history-note">Saved locally. Opening a chat does not call AI or use tokens.</p></aside><section class="chat-main-panel">
    <div class="tabs">
      <button data-mode="chat" class="${mode === 'chat' ? 'active' : ''}">Chat</button>
      <button data-mode="advise" class="${mode === 'advise' ? 'active' : ''}">Advisor</button>
    </div>
    <div id="chat-view">
      <div id="chat-log"></div>
      <div id="chat-input-row">
        <textarea id="chat-input" placeholder="${mode === 'chat' ? 'Ask XOFT to do something…' : 'Describe a problem to reason through…'}"></textarea>
        <button id="chat-send" class="primary">Send</button>
        <button id="chat-mic" type="button" title="Speak to XOFT" aria-label="Speak to XOFT">🎙️ Voice Input</button>
        <button id="chat-speak-toggle" type="button" aria-pressed="${isSpeakOutEnabled()}" ${canSpeakOut() ? '' : 'disabled'}>${isSpeakOutEnabled() ? 'Speak Out: ON' : 'Speak Out: OFF'}</button>
        <button id="chat-speak-stop" type="button" ${canSpeakOut() ? '' : 'disabled'}>Stop Speaking</button>
      </div>
    </div></section></div>
  `;
  renderLog(container);
  renderRecentChats(container);

  onDelegate(container, 'click', '#chat-new', () => { const id = crypto.randomUUID(); localStorage.setItem(SESSION_KEY, id); history = []; persistHistory(); render(container); });
  onDelegate(container, 'click', '[data-recent-session]', (el) => { localStorage.setItem(SESSION_KEY, el.dataset.recentSession); history = readHistory(el.dataset.recentSession); render(container); });
  onDelegate(container, 'input', '#recent-chat-search', (el) => renderRecentChats(container, el.value));
  onDelegate(container, 'click', '[data-mode]', (el) => {
    mode = el.dataset.mode;
    render(container);
  });

  onDelegate(container, 'click', '#chat-send', () => send(container));
  onDelegate(container, 'click', '#chat-mic', () => toggleVoiceInput(container));
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


// Free-first STT: browser recognition first; local Whisper fallback if unsupported.
import { transcribeAudioBlob } from '../voice/whisper-fallback.js';
let activeRecognition = null;
let whisperRecorder = null;
let whisperStream = null;
let whisperChunks = [];
let whisperBusy = false;

function setMicButton(container, label, pressed = false) {
  const button = container.querySelector('#chat-mic');
  if (button) {
    button.textContent = label;
    button.setAttribute('aria-pressed', String(pressed));
  }
}

async function startWhisperRecording(container) {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    toast('Voice input needs a supported browser with microphone access. Try Chrome over HTTPS.', 'warn');
    return;
  }
  try {
    whisperStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    whisperChunks = [];
    whisperRecorder = new MediaRecorder(whisperStream);
    whisperRecorder.ondataavailable = (event) => { if (event.data?.size) whisperChunks.push(event.data); };
    whisperRecorder.onstop = async () => {
      const blob = new Blob(whisperChunks, { type: whisperRecorder?.mimeType || 'audio/webm' });
      whisperStream?.getTracks().forEach(track => track.stop());
      whisperStream = null;
      whisperRecorder = null;
      whisperBusy = true;
      setMicButton(container, '⏳ Loading Whisper…', true);
      toast('Transcribing locally with Whisper. First use downloads a model and may take a few minutes.', 'info');
      try {
        const transcript = await transcribeAudioBlob(blob);
        const input = container.querySelector('#chat-input');
        if (input && transcript) {
          input.value = [input.value.trim(), transcript].filter(Boolean).join(' ').trim();
          input.focus();
          toast('Whisper transcription ready. Review it, then tap Send.', 'success');
        } else toast('Whisper did not detect speech. Try recording again.', 'warn');
      } catch (error) {
        console.error('[XOFT] Local Whisper failed:', error);
        toast('Local Whisper failed. Check internet for the first model download, available memory, and microphone permission.', 'warn');
      } finally {
        whisperBusy = false;
        whisperChunks = [];
        setMicButton(container, '🎙️ Voice Input');
      }
    };
    whisperRecorder.start();
    setMicButton(container, '🔴 Recording for Whisper… tap to stop', true);
    toast('Recording started. Tap the microphone button again to stop and transcribe.', 'info');
  } catch {
    toast('Microphone permission was denied or unavailable. Allow microphone access and retry.', 'warn');
  }
}

function toggleVoiceInput(container) {
  if (whisperBusy) return;
  if (whisperRecorder && whisperRecorder.state !== 'inactive') {
    whisperRecorder.stop();
    return;
  }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    startWhisperRecording(container);
    return;
  }
  if (activeRecognition) {
    activeRecognition.stop();
    activeRecognition = null;
    setMicButton(container, '🎙️ Voice Input');
    return;
  }
  const recognition = new SpeechRecognition();
  activeRecognition = recognition;
  recognition.lang = navigator.language || 'en-NG';
  recognition.continuous = false;
  recognition.interimResults = true;
  let finalText = '';
  setMicButton(container, '🔴 Listening… tap to stop', true);
  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const transcript = event.results[i][0]?.transcript || '';
      if (event.results[i].isFinal) finalText += transcript;
      else interim += transcript;
    }
    const input = container.querySelector('#chat-input');
    if (input) input.value = [finalText, interim].filter(Boolean).join(' ').trim();
  };
  recognition.onerror = (event) => {
    if (event.error !== 'aborted' && event.error !== 'no-speech') {
      toast('Browser speech recognition failed. If unavailable, use the local Whisper fallback by reopening Voice Input in a browser without Web Speech support.', 'warn');
    }
  };
  recognition.onend = () => {
    if (activeRecognition === recognition) activeRecognition = null;
    setMicButton(container, '🎙️ Voice Input');
    const input = container.querySelector('#chat-input');
    if (input && input.value.trim()) input.focus();
  };
  try { recognition.start(); }
  catch {
    activeRecognition = null;
    setMicButton(container, '🎙️ Voice Input');
    toast('Browser recognition could not start. Try again or use a browser without Web Speech support for local Whisper.', 'warn');
  }
}

async function send(container) {
  const input = container.querySelector('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  history.push({ role: 'user', content: text, at: new Date().toISOString() });
  persistHistory();
  renderLog(container);

  try {
    const endpoint = mode === 'chat' ? '/api/chat' : '/api/advise';
    const body = mode === 'chat' ? { message: text, sessionId: sessionId() } : { problem: text };
    const result = await api.post(endpoint, body);
    if (result.__queued) {
      history.push({ role: 'assistant', content: '(offline — this message is queued and will send once back online)', at: new Date().toISOString() });
      persistHistory();
    } else {
      history.push({ role: 'assistant', content: result.reply ?? result.advice ?? JSON.stringify(result), at: new Date().toISOString() });
      persistHistory();
      speakOut(result.reply ?? result.advice ?? JSON.stringify(result));
    }
  } catch (err) {
    // The server answers AI outages with a structured body ({success:false,error:'NO_AI_PROVIDER_AVAILABLE'|'AI_PROVIDERS_FAILED',...});
    // api.js wraps it as "<status> <json>". Show a calm explanation instead of raw JSON — the rest of Xoft is unaffected.
    let friendly = null;
    try {
      const body = JSON.parse(String(err.message).replace(/^\d{3}\s+/, ''));
      if (body?.error === 'NO_AI_PROVIDER_AVAILABLE') {
        friendly = 'No AI provider is currently configured or available. Everything else in Xoft still works — add a provider (API key, Ollama, FreeLLMAPI or LiteLLM) in Settings → AI providers to chat.';
      } else if (body?.error === 'AI_PROVIDERS_FAILED') {
        const providerAdvice = (body.attempts ?? []).map((attempt) => {
          const name = ({ openai: 'OpenAI', gemini: 'Gemini', claude: 'Claude', grok: 'Grok', ollama: 'Ollama', experiential: 'Experiential Labs', freellmapi: 'FreeLLMAPI', litellm: 'LiteLLM' })[attempt.provider] ?? attempt.provider;
          if (attempt.errorType === 'rate_limit') return `${name} hit a rate, usage, or quota limit; check its API usage, billing/credits, and rate limits.`;
          if (attempt.errorType === 'auth') return `${name} rejected its credentials; check the API key in deployment settings.`;
          if (attempt.errorType === 'invalid_request') return `${name} rejected the configured model or request; check its model name.`;
          if (['timeout', 'unavailable', 'server_error'].includes(attempt.errorType)) return `${name} is temporarily unavailable; try again shortly.`;
          return `${name} failed; check its API key and model configuration.`;
        });
        friendly = ['XOFT is running, but its configured AI providers could not answer.', ...providerAdvice, 'Fix the provider issue, then retry. Check Settings → AI providers for configuration and connection tests.'].join(' ');
      }
    } catch { /* not a structured AI error */ }
    history.push({ role: 'assistant', content: friendly ?? `Error: ${err.message}`, at: new Date().toISOString() });
    persistHistory();
    toast(friendly ? 'AI is unavailable' : err.message, friendly ? 'warn' : 'err');
  }
  renderLog(container);
}
