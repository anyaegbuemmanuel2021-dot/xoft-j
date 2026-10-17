// companion.js — browser-only glue: microphone → local VAD → recognizer backend → VoicePipeline → /api/chat.
// STATUS: implemented, NOT verifiable in the build sandbox (needs a real microphone/browser). See docs/DEVICE_RUNTIME.md "Requires local testing".
import { EnergyVad, rmsOf } from './vad.js';
import { VoicePipeline } from './wake.js';

const $ = (id) => document.getElementById(id);
const SESSION = `voice-${crypto.randomUUID?.() ?? Date.now()}`;
const FRAME_MS = 30;

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const BACKENDS = {
  'browser-speech': { available: Boolean(SR), label: 'Browser speech recognition', note: 'Uses your browser\'s built-in recognizer, opened ONLY while local VAD hears speech. In Chrome/Edge this audio is processed by the browser vendor\'s cloud service — it is NOT fully local. Wake phrase matching itself is local.' },
  'server-stt': { available: typeof MediaRecorder !== 'undefined', label: 'XOFT server speech-to-text', note: 'Each VAD-detected speech segment is uploaded to YOUR XOFT server (/api/voice/transcribe) and transcribed there (requires a speech-to-text provider configured on the server). Silence is never uploaded. Wake phrase matching is local, on the returned text.' },
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
  recognizer = new SR(); recognizer.continuous = true; recognizer.interimResults = true; recognizer.lang = navigator.language || 'en-US';
  recognizer.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) pipeline.transcript(e.results[i][0].transcript, e.results[i].isFinal); };
  recognizer.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') ui.log(`recognizer error: ${e.error}`); };
  recognizer.onend = () => { recognizer = null; if (recognizerWanted && $('backend').value === 'browser-speech') startBrowserSpeech(); }; // Chrome ends sessions on its own; restart only while wanted
  try { recognizer.start(); } catch (err) { ui.log(`could not start recognizer: ${err.message}`); recognizer = null; }
}
function stopRecognizer() { recognizerWanted = false; try { recognizer?.abort(); } catch { /* already stopped */ } recognizer = null; }

// ---- backend: server STT (records only VAD-detected segments) ----
function startSegmentRecording() {
  if (recorder || !stream || typeof MediaRecorder === 'undefined') return;
  chunks = []; recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' }); recorder = null; chunks = [];
    if (blob.size < 1500) return; // too small to be speech
    try {
      const res = await fetch('/api/voice/transcribe', { method: 'POST', headers: headers({ 'Content-Type': blob.type || 'audio/webm' }), body: blob });
      if (!res.ok) { ui.log(`server STT failed (${res.status}) — is a speech-to-text provider configured?`); return; }
      const { text } = await res.json(); if (text) pipeline.transcript(text, true);
    } catch (err) { ui.log(`server STT unreachable: ${err.message}`); }
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
async function sendCommand({ text }) {
  ui.log(`command: ${text}`);
  try {
    const res = await fetch('/api/chat', { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ sessionId: SESSION, message: text }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) ui.log(`XOFT error (${res.status}): ${body.error ?? 'request failed'}`);
    else ui.log(`XOFT: ${body.reply ?? body.message ?? body.response ?? JSON.stringify(body).slice(0, 300)}`);
  } catch (err) { ui.log(`could not reach XOFT (command NOT sent, not queued): ${err.message}`); }
  finally { pipeline.done(); }
}

function buildPipeline() {
  pipeline = new VoicePipeline({
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
  ctx = new (window.AudioContext || window.webkitAudioContext)(); analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser); // analysis only — never routed to the speakers
  vad = new EnergyVad({ frameMs: FRAME_MS }); buildPipeline();
  const buf = new Float32Array(analyser.fftSize);
  timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf); const rms = rmsOf(buf); const r = vad.process(rms, performance.now());
    $('level').style.width = `${Math.min(100, Math.round((rms / 0.3) * 100))}%`;
    if (r.event) pipeline.vad(r.event); pipeline.tick(Date.now());
  }, FRAME_MS);
  stream.getAudioTracks()[0].addEventListener('ended', () => { ui.log('microphone was disconnected or revoked'); stop(); });
  ui.pill('mic', 'mic: listening (local VAD)', 'ok'); $('start').disabled = true; $('stop').disabled = false;
  ui.log(`listening for "hey xoft" — backend: ${$('backend').value}`);
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
