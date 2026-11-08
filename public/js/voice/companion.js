// companion.js — microphone capture + local VAD → XOFT server STT → VoicePipeline → /api/chat. Browser speech recognition and synthesis are not used.
// STATUS: implemented, NOT verifiable in the build sandbox (needs a real microphone/browser). See docs/DEVICE_RUNTIME.md "Requires local testing".
import { EnergyVad, rmsOf } from './vad.js';
import { VoicePipeline } from './wake.js';
import { transcribe as transcribeAudioBlob, warmVoiceServer } from './stt.js';
import { preferredRecorderOptions, unlockAudio } from './listen.js';
import { classifyMicInput } from './mic-diagnostics.js';
import { speakOut } from './speak-out.js';
import { hasNativeSpeechRecognition, startNativeListening, stopNativeListening } from './native-bridge.js';

const $ = (id) => document.getElementById(id);
const SESSION = `voice-${crypto.randomUUID?.() ?? Date.now()}`;
const FRAME_MS = 30;
const selectedLanguage = () => $('language')?.value || 'auto';
const conversationEnabled = () => $('conversation-mode')?.checked ?? true;
const speechOutputEnabled = () => $('speak-replies')?.checked ?? true;

const BACKENDS = {
  ...(hasNativeSpeechRecognition() ? {
    'native-android': {
      available: true,
      label: 'On-device Android speech recognition',
      note: 'Speech is recognized by Android on-device services. No browser speech-recognition service or cloud transcription API is used.',
    },
  } : {}),
  'server-stt': {
    available: typeof MediaRecorder !== 'undefined',
    label: 'XOFT server STT (Gemini → OpenAI fallback)',
    note: 'Audio is captured locally and transcribed by XOFT server STT. This fallback requires a configured provider and network access.',
  },
};

const ui = { log(t) { const el = $('log'); el.textContent += `[${new Date().toLocaleTimeString()}] ${t}\n`; el.scrollTop = el.scrollHeight; }, pill(id, text, cls = '') { const el = $(id); el.textContent = text; el.className = `pill ${cls}`; } };
const apiKey = () => localStorage.getItem('xoft_api_key') || '';
const headers = (extra = {}) => ({ ...(apiKey() ? { 'X-API-Key': apiKey() } : {}), ...extra });

let stream = null; let ctx = null; let analyser = null; let timer = null; let vad = null; let pipeline = null;
let recognizerWanted = false; let recorder = null; let micDiagnosticTimer = null;

function makeBackendControls() {
  const sel = $('backend');
  for (const [id, b] of Object.entries(BACKENDS)) { const o = document.createElement('option'); o.value = id; o.textContent = b.label + (b.available ? '' : ' (unavailable in this browser)'); o.disabled = !b.available; sel.appendChild(o); }
  const first = Object.entries(BACKENDS).find(([, b]) => b.available)?.[0];
  if (first) sel.value = first; else ui.log('No speech recognition backend is available in this browser.');
  const note = () => { $('backend-note').textContent = BACKENDS[sel.value]?.note ?? ''; };
  sel.addEventListener('change', () => { note(); stopRecognizer(); });
  note();
}

// There is deliberately no browser SpeechRecognition backend. Only captured audio is sent
// to XOFT's provider-managed STT endpoint; browser-vendor speech services are never invoked.
function stopRecognizer() {
  recognizerWanted = false;
  stopNativeListening();
}

// ---- backend: server STT (records only VAD-detected segments) ----
function startSegmentRecording() {
  if (recorder || !stream || typeof MediaRecorder === 'undefined') return;
  const options = preferredRecorderOptions();
  let activeRecorder;
  try {
    activeRecorder = new MediaRecorder(stream, options);
  } catch (error) {
    ui.log('MediaRecorder could not start: ' + (error.name || 'Error') + ' — ' + error.message);
    return;
  }

  const segmentChunks = [];
  recorder = activeRecorder;
  activeRecorder.ondataavailable = (e) => { if (e.data?.size) segmentChunks.push(e.data); };
  activeRecorder.onerror = (event) => {
    const error = event.error;
    ui.log('MediaRecorder error: ' + (error?.name || 'UnknownError') + ' — ' + (error?.message || 'audio capture failed'));
    if (recorder === activeRecorder) recorder = null;
  };
  activeRecorder.onstop = async () => {
    const type = activeRecorder.mimeType || options?.mimeType || 'audio/webm';
    const capturedChunks = segmentChunks;
    if (recorder === activeRecorder) recorder = null;
    const blob = new Blob(capturedChunks, { type });
    ui.log('audio segment captured: ' + blob.size + ' bytes (' + type + ')');
    if (blob.size < 300) {
      ui.log('audio segment was too small to transcribe; check microphone input and speech gate');
      return; // reject only genuinely empty/tiny clips; short wake phrases must survive
    }
    try {
      const transcript = await transcribeAudioBlob(blob, (message) => ui.log(message), selectedLanguage());
      if (transcript) {
        $('transcript').textContent = transcript;
        ui.log('heard: ' + transcript);
        pipeline.transcript(transcript, true);
      } else ui.log('No speech was recognized in this segment.');
    } catch (err) { ui.log('XOFT server STT failed (Gemini → OpenAI fallback): ' + err.message); }
  };

  try {
    activeRecorder.start();
    ui.log('recording started: ' + (activeRecorder.mimeType || options?.mimeType || 'browser default'));
  } catch (error) {
    if (recorder === activeRecorder) recorder = null;
    ui.log('MediaRecorder start failed: ' + (error.name || 'Error') + ' — ' + error.message);
  }
}
function stopSegmentRecording() {
  const activeRecorder = recorder;
  if (!activeRecorder || activeRecorder.state !== 'recording') return;
  try {
    activeRecorder.stop();
    ui.log('recording stopped; final audio chunk is being prepared');
  } catch (error) {
    ui.log('MediaRecorder stop failed: ' + (error.name || 'Error') + ' — ' + error.message);
  }
}

function wantRecognizer(on) {
  recognizerWanted = on;
  const b = $('backend').value;
  if (b === 'native-android') {
    if (on && !startNativeListening(selectedLanguage())) ui.log('Android on-device speech recognition could not start. Check the installed offline language pack and microphone permission.');
    if (!on) stopNativeListening();
    return;
  }
  if (b === 'server-stt') on ? startSegmentRecording() : stopSegmentRecording();
}

window.addEventListener('xoft:native-transcript', (event) => {
  const detail = event.detail || {};
  if (detail.error) { ui.log('on-device STT: ' + detail.error); return; }
  const text = String(detail.text || '').trim();
  if (!text) return;
  $('transcript').textContent = text;
  ui.log('heard (Android on-device): ' + text);
  pipeline?.transcript(text, detail.isFinal !== false);
});

// ---- command submission: SAME entry point as typed chat. Deliberately NOT api.js (which queues offline POSTs for replay later —
// a stale voice command must never be replayed minutes/hours after it was spoken). ----
function speakReply(text) {
  if (!speechOutputEnabled() || !text) return Promise.resolve(false);
  return speakOut(String(text).slice(0, 4000));
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

function buildPipeline(continuousRecognition = false) {
  pipeline = new VoicePipeline({
    conversationMode: conversationEnabled(),
    continuousRecognition,
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
  if ($('backend').value === 'native-android') {
    buildPipeline(true);
    pipeline.start();
    timer = setInterval(() => pipeline?.tick(Date.now()), 250);
    ui.pill('mic', 'mic: on-device Android', 'ok');
    $('start').disabled = true; $('stop').disabled = false;
    ui.log('Android on-device recognizer started; waiting for the wake phrase.');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) { ui.pill('mic', 'mic: unsupported', 'err'); ui.log('getUserMedia is unavailable (needs HTTPS or localhost).'); return; }
  // Resume/create AudioContext synchronously during the Start button gesture, BEFORE
  // getUserMedia yields. Mobile browsers may discard user activation after the permission await.
  ctx = unlockAudio();
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (err) {
    try { await ctx?.close(); } catch { /* ignore */ } ctx = null;
    ui.pill('mic', err.name === 'NotAllowedError' ? 'mic: permission denied' : 'mic: unavailable', 'err');
    ui.log(`microphone: ${err.name} — ${err.message}`);
    return;
  }
  // Wake the cloud service while the user is getting ready to speak, not after the first utterance.
  // This overlaps Render cold-start latency with local audio setup and keeps the first STT request faster.
  if ($('backend').value === 'server-stt') void warmVoiceServer();
  // The context was already unlocked in the click handler; finish any pending resume before VAD starts.
  try {
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
  // Mobile microphones can deliver normal speech below 0.008 RMS. Keep a low floor so quiet voices
  // are not discarded before server STT can hear them; the adaptive noise floor still rises in noisy rooms.
  vad = new EnergyVad({ minThreshold: 0.003, floorMultiplier: 2.5, startFrames: 2, frameMs: FRAME_MS }); buildPipeline();
  const buf = new Float32Array(analyser.fftSize);
  let peakMicRms = 0;
  let speechStartEvents = 0;
  timer = setInterval(() => {
    if (ctx?.state === 'suspended') {
      ctx.resume().catch((err) => ui.log(`audio context resume failed: ${err.message}`));
    }
    analyser.getFloatTimeDomainData(buf); const rms = rmsOf(buf); peakMicRms = Math.max(peakMicRms, rms); const r = vad.process(rms, performance.now());
    $('level').style.width = `${Math.min(100, Math.round((rms / 0.18) * 100))}%`;
    if (r.event) {
      if (r.event === 'start') speechStartEvents += 1;
      ui.log('voice activity ' + r.event + ' (RMS ' + r.rms.toFixed(4) + ', gate ' + r.threshold.toFixed(4) + ')');
      pipeline.vad(r.event);
    }
    pipeline.tick(Date.now());
  }, FRAME_MS);
  micDiagnosticTimer = setTimeout(() => {
    micDiagnosticTimer = null;
    if (!stream) return;
    const diagnostic = classifyMicInput({ peakRms: peakMicRms, speechEvents: speechStartEvents, threshold: vad?.threshold ?? 0.003 });
    ui.log(`microphone check: ${diagnostic.message} (peak RMS ${peakMicRms.toFixed(4)}, speech starts ${speechStartEvents})`);
  }, 5000);
  stream.getAudioTracks()[0].addEventListener('ended', () => { ui.log('microphone was disconnected or revoked'); stop(); });
  ui.log('Speak now for the 5-second microphone signal check.');
  ui.pill('mic', 'mic: listening (local VAD)', 'ok'); $('start').disabled = true; $('stop').disabled = false;
  const audioTrackSettings = stream.getAudioTracks()[0]?.getSettings?.() ?? {};
  ui.log('microphone ready; AudioContext ' + ctx.state + '; sample rate ' + (audioTrackSettings.sampleRate ?? ctx.sampleRate ?? 'unknown') + ' Hz; channels ' + (audioTrackSettings.channelCount ?? 'unknown'));
  ui.log(`listening for "hey xoft" — backend: ${$('backend').value}; language: ${selectedLanguage()}; follow-up conversation: ${conversationEnabled() ? 'on' : 'off'}`);
}

function stop() {
  clearInterval(timer); timer = null; clearTimeout(micDiagnosticTimer); micDiagnosticTimer = null; stopRecognizer(); stopSegmentRecording();
  stream?.getTracks().forEach((t) => t.stop()); stream = null; try { ctx?.close(); } catch { /* ignore */ } ctx = null;
  $('level').style.width = '0'; $('confirm-box').style.display = 'none';
  ui.pill('mic', 'mic: off'); ui.pill('state', 'state: idle'); $('start').disabled = false; $('stop').disabled = true; ui.log('stopped — microphone released');
}

makeBackendControls();
$('start').addEventListener('click', start); $('stop').addEventListener('click', stop);
$('confirm-yes').addEventListener('click', () => pipeline?.confirm()); $('confirm-no').addEventListener('click', () => pipeline?.cancel('cancelled by tap'));
window.addEventListener('pagehide', stop);
