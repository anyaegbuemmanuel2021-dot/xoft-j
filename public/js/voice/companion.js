// companion.js — browser-only glue: microphone → local VAD → XOFT server STT (Gemini → OpenAI fallback) → VoicePipeline → /api/chat.
// STATUS: implemented, NOT verifiable in the build sandbox (needs a real microphone/browser). See docs/DEVICE_RUNTIME.md "Requires local testing".
import { EnergyVad, rmsOf } from './vad.js';
import { VoicePipeline } from './wake.js';
import { transcribe as transcribeAudioBlob, transcribeNativeAudio, warmVoiceServer } from './stt.js';
import { preferredRecorderOptions, unlockAudio } from './listen.js';
import { classifyMicInput } from './mic-diagnostics.js';
import { RollingAudioBuffer } from './segment-buffer.js';
import { hasNativeAudioCapture, startNativeAudioCapture, stopNativeAudioCapture } from './native-bridge.js';
import { speakOut, stopSpeaking } from './speak-out.js';
import { postVoiceCommand } from './command-request.js';

const $ = (id) => document.getElementById(id);
const SESSION = `voice-${crypto.randomUUID?.() ?? Date.now()}`;
const FRAME_MS = 30;
const selectedLanguage = () => $('language')?.value || 'auto';
const conversationEnabled = () => $('conversation-mode')?.checked ?? true;
const speechOutputEnabled = () => $('speak-replies')?.checked ?? true;

const BACKENDS = {
  ...(hasNativeAudioCapture() ? { 'native-android': { available: true, label: 'Native Android microphone + XOFT STT', note: 'Android AudioRecord captures PCM locally; XOFT server transcribes with Gemini first and OpenAI fallback.' } } : {}),
  'server-stt': { available: typeof MediaRecorder !== 'undefined', label: 'XOFT server STT (Gemini → OpenAI)', note: 'Speech is captured locally, detected with local VAD, then transcribed by XOFT server STT (Gemini primary, OpenAI fallback). Auto supports mixed Nigerian English/Pidgin/Igbo.' },

};

const ui = { log(t) { const el = $('log'); el.textContent += `[${new Date().toLocaleTimeString()}] ${t}\n`; el.scrollTop = el.scrollHeight; }, pill(id, text, cls = '') { const el = $(id); el.textContent = text; el.className = `pill ${cls}`; } };
const apiKey = () => localStorage.getItem('xoft_api_key') || '';
const headers = (extra = {}) => ({ ...(apiKey() ? { 'X-API-Key': apiKey() } : {}), ...extra });

let voiceSessionGeneration = 0;
let stream = null; let ctx = null; let analyser = null; let timer = null; let vad = null; let pipeline = null;
let recorder = null; let recorderSessionGeneration = 0; let captureBuffer = null; let nativeTranscriptionQueue = Promise.resolve(); let activeSttControllers = new Set(); let micDiagnosticTimer = null; let recognizerWanted = false; let activeSpeechAudio = null; let activeSpeechUrl = null; let activeSpeechCancel = null; let activeChatRequestController = null;

function makeBackendControls() {
  const sel = $('backend');
  for (const [id, b] of Object.entries(BACKENDS)) { const o = document.createElement('option'); o.value = id; o.textContent = b.label + (b.available ? '' : ' (unavailable in this browser)'); o.disabled = !b.available; sel.appendChild(o); }
  const first = Object.entries(BACKENDS).find(([, b]) => b.available)?.[0];
  if (first) sel.value = first; else ui.log('No speech recognition backend is available in this browser.');
  const note = () => { $('backend-note').textContent = BACKENDS[sel.value]?.note ?? ''; };
  sel.addEventListener('change', note);
  note();
}

// ---- backend: continuous capture with a bounded pre-roll for VAD segments ----
async function transcribeCapturedChunks(chunks, type, sessionGeneration = voiceSessionGeneration) {
  if (sessionGeneration !== voiceSessionGeneration) { ui.log('discarded audio from an earlier voice session'); return; }
  const blob = new Blob(chunks, { type });
  ui.log('audio segment captured: ' + blob.size + ' bytes (' + type + ')');
  if (blob.size < 300) {
    ui.log('audio segment was too small to transcribe; check microphone input and speech gate');
    return;
  }
  const controller = new AbortController();
  activeSttControllers.add(controller);
  try {
    const transcript = await transcribeAudioBlob(blob, (message) => ui.log(message), selectedLanguage(), { signal: controller.signal });
    if (sessionGeneration !== voiceSessionGeneration) return;
    if (transcript) {
      $('transcript').textContent = transcript;
      ui.log('heard: ' + transcript);
      pipeline?.transcript(transcript, true);
    } else ui.log('No speech was recognized in this segment.');
  } catch (err) {
    if (sessionGeneration === voiceSessionGeneration && err?.name !== 'AbortError') ui.log('XOFT server STT failed (Gemini → OpenAI fallback): ' + err.message);
  } finally {
    activeSttControllers.delete(controller);
  }
}

function startAudioCapture() {
  if (recorder || !stream || typeof MediaRecorder === 'undefined') return;
  const options = preferredRecorderOptions();
  const sessionGeneration = voiceSessionGeneration;
  recorderSessionGeneration = sessionGeneration;
  let activeRecorder;
  try {
    activeRecorder = new MediaRecorder(stream, options);
  } catch (error) {
    ui.log('MediaRecorder could not start: ' + (error.name || 'Error') + ' — ' + error.message);
    return;
  }

  captureBuffer = new RollingAudioBuffer({ preRollMs: 500 });
  recorder = activeRecorder;
  activeRecorder.ondataavailable = (event) => {
    if (event.data?.size) captureBuffer?.push(event.data);
  };
  activeRecorder.onerror = (event) => {
    const error = event.error;
    ui.log('MediaRecorder error: ' + (error?.name || 'UnknownError') + ' — ' + (error?.message || 'audio capture failed'));
  };
  activeRecorder.onstop = () => {
    const type = activeRecorder.mimeType || options?.mimeType || 'audio/webm';
    const chunks = captureBuffer?.active ? captureBuffer.finish() : [];
    captureBuffer?.discard();
    captureBuffer = null;
    if (recorder === activeRecorder) recorder = null;
    if (chunks.length) void transcribeCapturedChunks(chunks, type, sessionGeneration);
  };

  try {
    // Keep one recorder running so the first speech chunk is already in flight when VAD opens.
    // 200 ms chunks bound pre-roll latency while retaining the opening syllable.
    activeRecorder.start(200);
    ui.log('continuous audio capture started: ' + (activeRecorder.mimeType || options?.mimeType || 'browser default'));
  } catch (error) {
    if (recorder === activeRecorder) recorder = null;
    captureBuffer?.discard();
    captureBuffer = null;
    ui.log('MediaRecorder start failed: ' + (error.name || 'Error') + ' — ' + error.message);
  }
}

function startSegmentRecording() {
  if (!recorder || recorder.state !== 'recording' || !captureBuffer) return;
  if (captureBuffer.begin()) ui.log('speech segment opened with 500 ms audio pre-roll');
}

function stopSegmentRecording() {
  if (!captureBuffer?.active) return;
  const activeRecorder = recorder;
  const type = activeRecorder?.mimeType || 'audio/webm';
  const chunks = captureBuffer.finish();
  if (chunks.length) void transcribeCapturedChunks(chunks, type, recorderSessionGeneration);
}

function fallbackToServerStt(reason) {
  if ($('backend').value !== 'native-android') return;
  ui.log('Android on-device STT unavailable: ' + reason + ' — switching to XOFT server STT.');
  $('backend').value = 'server-stt';
  stopNativeAudioCapture();
  stop();
  void start();
}

function wantRecognizer(on) {
  recognizerWanted = on;
  const backend = $('backend').value;
  if (backend === 'native-android') {
    if (on && !startNativeAudioCapture(selectedLanguage())) fallbackToServerStt('native audio capture could not start');
    if (!on) stopNativeAudioCapture();
    return;
  }
  if (backend === 'server-stt') on ? startSegmentRecording() : stopSegmentRecording();
}

// ---- command submission: SAME entry point as typed chat. Deliberately NOT api.js (which queues offline POSTs for replay later —
// a stale voice command must never be replayed minutes/hours after it was spoken). ----
async function speakReply(text) {
  if (!speechOutputEnabled() || !text) return;
  const spoken = await speakOut(text);
  if (!spoken) ui.log('XOFT speech output unavailable; check Android text-to-speech or configure server TTS.');
}

async function sendCommand({ text }) {
  const commandGeneration = voiceSessionGeneration;
  const commandPipeline = pipeline;
  ui.log(`command: ${text}`);
  let reply = '';
  const controller = new AbortController();
  activeChatRequestController = controller;
  try {
    const body = await postVoiceCommand({
      fetchImpl: fetch,
      headers: headers({ 'Content-Type': 'application/json' }),
      sessionId: SESSION,
      message: text,
      signal: controller.signal,
    });
    if (commandGeneration !== voiceSessionGeneration) return;
    reply = String(body.reply ?? body.message ?? body.response ?? '').trim();
    if (!reply) reply = JSON.stringify(body).slice(0, 300);
    ui.log(`XOFT: ${reply}`);
    $('transcript').textContent = `You: ${text}\nXOFT: ${reply}`;
  } catch (err) {
    if (commandGeneration === voiceSessionGeneration) {
      if (err?.name === 'AbortError') ui.log('voice command cancelled because the live session stopped');
      else ui.log(`XOFT chat request failed; execution status may be unknown: ${err.message}`);
    }
  } finally {
    if (activeChatRequestController === controller) activeChatRequestController = null;
    // A reply from an older/stopped session must never speak or resume a newer pipeline.
    if (commandGeneration === voiceSessionGeneration) {
      if (reply) await speakReply(reply);
      if (commandGeneration === voiceSessionGeneration) commandPipeline?.done();
    }
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

window.addEventListener('xoft:native-audio-error', (event) => {
  const reason = String(event.detail?.error || 'native microphone capture failed');
  ui.log('Android AudioRecord: ' + reason);
  fallbackToServerStt(reason);
});

window.addEventListener('xoft:native-audio', (event) => {
  const detail = event.detail || {};
  if ($('backend').value !== 'native-android' || !recognizerWanted || !detail.base64) return;
  // Keep segments ordered; overlapping provider calls can return out of order and confuse the wake pipeline.
  const sessionGeneration = voiceSessionGeneration;
  nativeTranscriptionQueue = nativeTranscriptionQueue.then(async () => {
    if ($('backend').value !== 'native-android' || !recognizerWanted || sessionGeneration !== voiceSessionGeneration) return;
    const controller = new AbortController();
    activeSttControllers.add(controller);
    try {
      ui.log('native Android PCM segment captured; sending WAV to XOFT Gemini → OpenAI STT');
      const transcript = await transcribeNativeAudio(detail.base64, detail.language || selectedLanguage(), (message) => ui.log(message), { signal: controller.signal });
      if (sessionGeneration !== voiceSessionGeneration || !recognizerWanted) return;
      if (transcript) {
        $('transcript').textContent = transcript;
        ui.log('heard (native audio / server STT): ' + transcript);
        pipeline?.transcript(transcript, true);
      }
    } catch (error) {
      if (sessionGeneration === voiceSessionGeneration && error?.name !== 'AbortError') ui.log('native audio transcription failed: ' + error.message);
    } finally {
      activeSttControllers.delete(controller);
    }
  }).catch((error) => ui.log('native STT queue error: ' + error.message));
});

async function start() {
  const startGeneration = ++voiceSessionGeneration;
  $('start').disabled = true;
  $('stop').disabled = false;

  if ($('backend').value === 'native-android') {
    // Wake the server while Android is already listening; this hides free-instance cold-start latency.
    void warmVoiceServer();
    buildPipeline(true);
    pipeline.start();
    if (startGeneration !== voiceSessionGeneration || $('backend').value !== 'native-android') return;
    timer = setInterval(() => pipeline?.tick(Date.now()), 250);
    ui.pill('mic', 'mic: on-device Android', 'ok');
    ui.log('Android AudioRecord capture started; local VAD sends audio segments to Gemini-first server STT.');
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    if (startGeneration === voiceSessionGeneration) {
      ui.pill('mic', 'mic: unsupported', 'err');
      ui.log('getUserMedia is unavailable (needs HTTPS or localhost).');
      $('start').disabled = false; $('stop').disabled = true;
    }
    return;
  }

  // Resume/create AudioContext synchronously during the Start button gesture, BEFORE
  // getUserMedia yields. Mobile browsers may discard user activation after the permission await.
  const startContext = unlockAudio();
  ctx = startContext;
  try {
    const acquiredStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (startGeneration !== voiceSessionGeneration) {
      acquiredStream.getTracks().forEach((track) => track.stop());
      try { await startContext?.close(); } catch { /* already closed by Stop */ }
      if (ctx === startContext) ctx = null;
      return;
    }
    stream = acquiredStream;
  } catch (err) {
    if (startGeneration !== voiceSessionGeneration) return;
    try { await startContext?.close(); } catch { /* ignore */ }
    if (ctx === startContext) ctx = null;
    ui.pill('mic', err.name === 'NotAllowedError' ? 'mic: permission denied' : 'mic: unavailable', 'err');
    ui.log(`microphone: ${err.name} — ${err.message}`);
    $('start').disabled = false; $('stop').disabled = true;
    return;
  }

  // Wake the cloud service while the user is getting ready to speak, not after the first utterance.
  // This overlaps Render cold-start latency with local audio setup and keeps the first STT request faster.
  if ($('backend').value === 'server-stt') void warmVoiceServer();

  // Resume the context that was unlocked in the click handler; check generation after every await.
  try {
    if (!startContext) throw new Error('This browser does not support AudioContext.');
    if (startContext.state === 'suspended') await startContext.resume();
    if (startGeneration !== voiceSessionGeneration) {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      try { await startContext.close(); } catch { /* already closed by Stop */ }
      if (ctx === startContext) ctx = null;
      return;
    }
    if (startContext.state !== 'running') throw new Error(`AudioContext is ${startContext.state}; tap Start listening again and allow audio access.`);
    analyser = startContext.createAnalyser();
    analyser.fftSize = 1024;
    startContext.createMediaStreamSource(stream).connect(analyser); // analysis only — never routed to the speakers
  } catch (err) {
    if (startGeneration !== voiceSessionGeneration) return;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    try { await startContext?.close(); } catch { /* ignore */ }
    if (ctx === startContext) ctx = null;
    ui.pill('mic', 'mic: audio engine unavailable', 'err');
    ui.log(`audio capture setup failed: ${err.message}`);
    $('start').disabled = false; $('stop').disabled = true;
    return;
  }

  // Lower adaptive threshold helps quiet speech, while two frames reduce the chance of clipping
  // the start of short wake phrases. Ambient-noise adaptation remains enabled.
  // Mobile microphones can deliver normal speech below 0.008 RMS. Keep a low floor so quiet voices
  // are not discarded before server STT can hear them; the adaptive noise floor still rises in noisy rooms.
  vad = new EnergyVad({ minThreshold: 0.003, floorMultiplier: 2.5, startFrames: 2, frameMs: FRAME_MS });
  buildPipeline();
  if ($('backend').value === 'server-stt') startAudioCapture();
  const buf = new Float32Array(analyser.fftSize);
  let peakMicRms = 0;
  let speechStartEvents = 0;
  timer = setInterval(() => {
    if (startGeneration !== voiceSessionGeneration || !analyser) return;
    if (startContext.state === 'suspended') {
      startContext.resume().catch((err) => ui.log(`audio context resume failed: ${err.message}`));
    }
    analyser.getFloatTimeDomainData(buf);
    const rms = rmsOf(buf);
    peakMicRms = Math.max(peakMicRms, rms);
    const result = vad.process(rms, performance.now());
    $('level').style.width = `${Math.min(100, Math.round((rms / 0.18) * 100))}%`;
    if (result.event) {
      if (result.event === 'start') speechStartEvents += 1;
      ui.log('voice activity ' + result.event + ' (RMS ' + result.rms.toFixed(4) + ', gate ' + result.threshold.toFixed(4) + ')');
      pipeline.vad(result.event);
    }
    pipeline.tick(Date.now());
  }, FRAME_MS);

  micDiagnosticTimer = setTimeout(() => {
    micDiagnosticTimer = null;
    if (!stream || startGeneration !== voiceSessionGeneration) return;
    const diagnostic = classifyMicInput({ peakRms: peakMicRms, speechEvents: speechStartEvents, threshold: vad?.threshold ?? 0.003 });
    ui.log(`microphone check: ${diagnostic.message} (peak RMS ${peakMicRms.toFixed(4)}, speech starts ${speechStartEvents})`);
  }, 5000);

  stream.getAudioTracks()[0].addEventListener('ended', () => {
    if (startGeneration === voiceSessionGeneration) {
      ui.log('microphone was disconnected or revoked');
      stop();
    }
  });
  ui.log('Speak now for the 5-second microphone signal check.');
  ui.pill('mic', 'mic: listening (local VAD)', 'ok');
  const audioTrackSettings = stream.getAudioTracks()[0]?.getSettings?.() ?? {};
  ui.log('microphone ready; AudioContext ' + startContext.state + '; sample rate ' + (audioTrackSettings.sampleRate ?? startContext.sampleRate ?? 'unknown') + ' Hz; channels ' + (audioTrackSettings.channelCount ?? 'unknown'));
  ui.log(`listening for "hey xoft" — backend: ${$('backend').value}; language: ${selectedLanguage()}; follow-up conversation: ${conversationEnabled() ? 'on' : 'off'}`);
}

function stop() {
  voiceSessionGeneration += 1;
  clearInterval(timer); timer = null; pipeline?.stop(); stopNativeAudioCapture(); stopSpeaking(); recognizerWanted = false; clearTimeout(micDiagnosticTimer); micDiagnosticTimer = null;
  activeChatRequestController?.abort(); activeChatRequestController = null;
  for (const controller of activeSttControllers) controller.abort();
  activeSttControllers.clear();
  nativeTranscriptionQueue = Promise.resolve();
  activeSpeechCancel?.(); activeSpeechCancel = null;
  activeSpeechAudio?.pause(); activeSpeechAudio = null;
  if (activeSpeechUrl) URL.revokeObjectURL(activeSpeechUrl); activeSpeechUrl = null;
  // Let MediaRecorder emit its final dataavailable chunk before its onstop handler flushes any active segment.
  if (recorder?.state === 'recording') { try { recorder.stop(); } catch { /* already stopping */ } }
  else { captureBuffer?.discard(); captureBuffer = null; }
  stream?.getTracks().forEach((t) => t.stop()); stream = null; try { ctx?.close(); } catch { /* ignore */ } ctx = null;
  $('level').style.width = '0'; $('confirm-box').style.display = 'none';
  ui.pill('mic', 'mic: off'); ui.pill('state', 'state: idle'); $('start').disabled = false; $('stop').disabled = true; ui.log('stopped — microphone released');
}

makeBackendControls();
$('start').addEventListener('click', start); $('stop').addEventListener('click', stop);
$('confirm-yes').addEventListener('click', () => pipeline?.confirm()); $('confirm-no').addEventListener('click', () => pipeline?.cancel('cancelled by tap'));
window.addEventListener('pagehide', stop);
