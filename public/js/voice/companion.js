// companion.js — browser-only glue: microphone → local VAD → recognizer backend → VoicePipeline → /api/chat.
// STATUS: implemented, NOT verifiable in the build sandbox (needs a real microphone/browser). See docs/DEVICE_RUNTIME.md "Requires local testing".
import { EnergyVad, rmsOf } from './vad.js';
import { VoicePipeline } from './wake.js';
import { transcribe as transcribeAudioBlob } from './stt.js';
import { preferredRecorderOptions, unlockAudio } from './listen.js';

const $ = (id) => document.getElementById(id);
const SESSION = `voice-${crypto.randomUUID?.() ?? Date.now()}`;
const FRAME_MS = 30;
const selectedLanguage = () => $('language')?.value || 'auto';
const conversationEnabled = () => $('conversation-mode')?.checked ?? true;
const speechOutputEnabled = () => $('speak-replies')?.checked ?? true;

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const BACKENDS = {
  'server-stt': { available: typeof MediaRecorder !== 'undefined', label: 'XOFT server STT (OpenAI → Gemini)', note: 'Speech segments are transcribed by XOFT server STT (OpenAI primary, Gemini fallback), then on-device Whisper if the server is unavailable. Choose Auto for mixed Nigerian English/Pidgin/Igbo, or explicitly select English or Igbo.' },
  'browser-speech': { available: Boolean(SR), label: 'Browser speech recognition (last resort)', note: 'Compatibility fallback only when server recording is unavailable. Browser recognition may send audio to the browser vendor cloud service; it is not fully local.' },
  // A fully on-device wake-word/STT engine (openWakeWord, Porcupine or Vosk compiled to WASM) can be added here as a third backend;
  // none is bundled because they require model files that are not part of this repository.
};

const ui = { log(t) { const el = $('log'); el.textContent += `[${new Date().toLocaleTimeString()}] ${t}\n`; el.scrollTop = el.scrollHeight; }, pill(id, text, cls = '') { const el = $(id); el.textContent = text; el.className = `pill ${cls}`; } };
const apiKey = () => localStorage.getItem('xoft_api_key') || '';
const headers = (extra = {}) => ({ ...(apiKey() ? { 'X-API-Key': apiKey() } : {}), ...extra });

let stream = null; let ctx = null; let analyser = null; let timer = null; let vad = null; let pipeline = null;
let recognizer = null; let recognizerWanted = false; let recorder = null; let chunks = [];

function makeBackendControls() {
  const sel = $('backend');
  for (const [id, b] of Object.entries(BACKENDS)) { const o = document.createElement('option'); o.value = id; o.textContent = b.label + (b.available ? '' : ' (unavailable in this browser)'); o.disabled = !b.available; sel.appendChild(o); }
  const first = Object.entries(BACKENDS).find(([, b]) => b.available)?.[0];
  if (first) sel.value = first; else ui.log('No speech recognition backend is available in this browser.');
  const note = () => { $('backend-note').textContent = BACKENDS[sel.value]?.note ?? ''; };
  sel.addEventListener('change', () => { note(); stopRecognizer(); });
  note();
}

// ---- backend: browser SpeechRecognition (opened only while VAD says someone is speaking) ----
function startBrowserSpeech() {
  if (recognizer || !SR) return;
  recognizer = new SR(); recognizer.continuous = true; recognizer.interimResults = true; recognizer.lang = selectedLanguage() === 'ig' ? 'ig-NG' : 'en-NG';
  recognizer.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = String(e.results[i][0]?.transcript || '').trim();
      if (!text) continue;
      $('transcript').textContent = text;
      if (e.results[i].isFinal) ui.log(`heard: ${text}`);
      pipeline.transcript(text, e.results[i].isFinal);
    }
  };
  recognizer.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') ui.log(`recognizer error: ${e.error}`); };
  recognizer.onend = () => { recognizer = null; if (recognizerWanted && $('backend').value === 'browser-speech') startBrowserSpeech(); }; // Chrome ends sessions on its own; restart only while wanted
  try { recognizer.start(); } catch (err) { ui.log(`could not start recognizer: ${err.message}`); recognizer = null; }
}
function stopRecognizer() {
  recognizerWanted = false;
  // stop(), unlike abort(), allows the recognizer to deliver its final transcript.
  try { recognizer?.stop(); } catch { /* already stopped */ }
}

// ---- backend: server STT (records only VAD-detected segments) ----
function startSegmentRecording() {
  if (recorder || !stream || typeof MediaRecorder === 'undefined') return;
  chunks = []; recorder = new MediaRecorder(stream, preferredRecorderOptions());
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' }); recorder = null; chunks = [];
    if (blob.size < 300) return; // reject only genuinely empty/tiny clips; short wake phrases must survive
    try {
      const transcript = await transcribeAudioBlob(blob, (message) => ui.log(message), selectedLanguage());
      if (transcript) {
        $('transcript').textContent = transcript;
        ui.log(`heard: ${transcript}`);
        pipeline.transcript(transcript, true);
      } else ui.log('No speech was recognized in this segment.');
    } catch (err) { ui.log(`STT failed (server OpenAI → Gemini, then local Whisper): ${err.message}`); }
  };
  recorder.start();
}
function stopSegmentRecording() { try { if (recorder?.state === 'recording') recorder.stop(); } catch { /* ignore */ } }

function wantRecognizer(on) {
  recognizerWanted = on;
  const b = $('backend').value;
  if (b === 'browser-speech') on ? startBrowserSpeech() : stopRecognizer();
  if (b === 'server-stt') on ? startSegmentRecording() : stopSegmentRecording();
}

// ---- command submission: SAME entry point as typed chat. Deliberately NOT api.js (which queues offline POSTs for replay later —
// a stale voice command must never be replayed minutes/hours after it was spoken). ----
function speakReply(text) {
  if (!speechOutputEnabled() || !('speechSynthesis' in window) || !text) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(String(text).slice(0, 4000));
      const lang = selectedLanguage() === 'ig' ? 'ig-NG' : 'en-NG';
      utterance.lang = lang;
      const voices = window.speechSynthesis.getVoices();
      utterance.voice = voices.find((v) => v.lang?.toLowerCase() === lang.toLowerCase())
        || voices.find((v) => v.lang?.toLowerCase().startsWith(selectedLanguage() === 'ig' ? 'ig' : 'en-ng'))
        || voices.find((v) => v.lang?.toLowerCase().startsWith('en'));
      utterance.onend = resolve; utterance.onerror = resolve;
      window.speechSynthesis.speak(utterance);
    } catch { resolve(); }
  });
}

async function sendCommand({ text }) {
  ui.log(`command: ${text}`);
  let reply = '';
  try {
    const res = await fetch('/api/chat', { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ sessionId: SESSION, message: text }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) ui.log(`XOFT error (${res.status}): ${body.error ?? 'request failed'}`);
    else {
      reply = String(body.reply ?? body.message ?? body.response ?? '').trim();
      if (!reply) reply = JSON.stringify(body).slice(0, 300);
      ui.log(`XOFT: ${reply}`);
      $('transcript').textContent = `You: ${text}\nXOFT: ${reply}`;
    }
  } catch (err) { ui.log(`could not reach XOFT (command NOT sent, not queued): ${err.message}`); }
  finally {
    if (reply) await speakReply(reply);
    pipeline.done();
  }
}

function buildPipeline() {
  pipeline = new VoicePipeline({
    conversationMode: conversationEnabled(),
    onState: (s) => ui.pill('state', `state: ${s.replace('_', ' ')}`, s === 'idle' ? '' : 'ok'),
    onWake: (p) => ui.log(`wake phrase heard ("${p}")`),
    onCommand: sendCommand,
    onNeedConfirm: (c) => { $('confirm-text').textContent = c; $('confirm-box').style.display = 'block'; ui.log(`awaiting confirmation: ${c}`); },
    onCancel: (r) => { $('confirm-box').style.display = 'none'; ui.log(`cancelled (${r})`); },
    onTimeout: () => ui.log('no command heard — back to listening'),
    wantRecognizer,
  });
  const hideConfirm = () => { $('confirm-box').style.display = 'none'; };
  const origSubmit = pipeline._submit.bind(pipeline); pipeline._submit = (c) => { hideConfirm(); origSubmit(c); };
}

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) { ui.pill('mic', 'mic: unsupported', 'err'); ui.log('getUserMedia is unavailable (needs HTTPS or localhost).'); return; }
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (err) { ui.pill('mic', err.name === 'NotAllowedError' ? 'mic: permission denied' : 'mic: unavailable', 'err'); ui.log(`microphone: ${err.name} — ${err.message}`); return; }
  // Unlock/resume AudioContext directly inside the Start button gesture. Creating a fresh context
  // after awaiting getUserMedia can leave it suspended on mobile; the analyser then reads zeros
  // and VAD never starts a recording, making STT appear completely dead.
  try {
    ctx = unlockAudio();
    if (!ctx) {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (AudioContextCtor) ctx = new AudioContextCtor();
    }
    if (!ctx) throw new Error('This browser does not support AudioContext.');
    if (ctx.state === 'suspended') await ctx.resume();
    if (ctx.state !== 'running') throw new Error(`AudioContext is ${ctx.state}; tap Start listening again and allow audio access.`);
    analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser); // analysis only — never routed to the speakers
  } catch (err) {
    stream?.getTracks().forEach((t) => t.stop()); stream = null;
    try { await ctx?.close(); } catch { /* ignore */ } ctx = null;
    ui.pill('mic', 'mic: audio engine unavailable', 'err');
    ui.log(`audio capture setup failed: ${err.message}`);
    return;
  }
  // Lower adaptive threshold helps quiet speech, while two frames reduce the chance of clipping
  // the start of short wake phrases. Ambient-noise adaptation remains enabled.
  vad = new EnergyVad({ minThreshold: 0.008, floorMultiplier: 2.5, startFrames: 2, frameMs: FRAME_MS }); buildPipeline();
  const buf = new Float32Array(analyser.fftSize);
  timer = setInterval(() => {
    if (ctx?.state === 'suspended') {
      ctx.resume().catch((err) => ui.log(`audio context resume failed: ${err.message}`));
    }
    analyser.getFloatTimeDomainData(buf); const rms = rmsOf(buf); const r = vad.process(rms, performance.now());
    $('level').style.width = `${Math.min(100, Math.round((rms / 0.18) * 100))}%`;
    if (r.event) pipeline.vad(r.event); pipeline.tick(Date.now());
  }, FRAME_MS);
  stream.getAudioTracks()[0].addEventListener('ended', () => { ui.log('microphone was disconnected or revoked'); stop(); });
  ui.pill('mic', 'mic: listening (local VAD)', 'ok'); $('start').disabled = true; $('stop').disabled = false;
  ui.log(`listening for "hey xoft" — backend: ${$('backend').value}; language: ${selectedLanguage()}; follow-up conversation: ${conversationEnabled() ? 'on' : 'off'}`);
}

function stop() {
  clearInterval(timer); timer = null; stopRecognizer(); stopSegmentRecording();
  stream?.getTracks().forEach((t) => t.stop()); stream = null; try { ctx?.close(); } catch { /* ignore */ } ctx = null;
  $('level').style.width = '0'; $('confirm-box').style.display = 'none';
  ui.pill('mic', 'mic: off'); ui.pill('state', 'state: idle'); $('start').disabled = false; $('stop').disabled = true; ui.log('stopped — microphone released');
}

makeBackendControls();
$('start').addEventListener('click', start); $('stop').addEventListener('click', stop);
$('confirm-yes').addEventListener('click', () => pipeline?.confirm()); $('confirm-no').addEventListener('click', () => pipeline?.cancel('cancelled by tap'));
window.addEventListener('pagehide', stop);
