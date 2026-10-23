// Shared microphone capture helpers. These do NOT depend on the browser Web Speech service, so they work in
// Brave, Firefox, PWAs/WebViews and offline-from-Google setups. Audio segments are sent to XOFT's server STT.
//
// Fixes over the old inline code:
//  - one AudioContext, unlocked from a user gesture (a context created later from a timer stays "suspended" on
//    mobile and reads all-zero samples, so every utterance looked like silence and was dropped)
//  - adaptive speech threshold (noise floor x3) instead of a fixed RMS that missed quiet voices
//  - a fixed-rate timer instead of animation frames (those pause when the screen dims or the tab is backgrounded)
//  - if the analyser cannot run, segments are still sent (time-capped) instead of silently discarded

let sharedContext = null;

/** Call from a click/tap handler. Safe to call repeatedly. */
export function unlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!sharedContext || sharedContext.state === 'closed') sharedContext = new Ctx();
    if (sharedContext.state === 'suspended') sharedContext.resume().catch(() => {});
  } catch { /* unsupported */ }
  return sharedContext;
}

export function preferredRecorderOptions() {
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    .find((t) => window.MediaRecorder?.isTypeSupported?.(t));
  return type ? { mimeType: type } : undefined;
}

/** Opens the mic with the constraints that give the cleanest speech. */
export function openMicrophone() {
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
}

/**
 * Level meter over a stream. Returns { read(): rms|null, close() }. read() is null when the analyser is not running.
 */
export function createLevelMeter(stream) {
  const ctx = unlockAudio();
  if (!ctx) return { read: () => null, close() {}, running: () => false };
  let source = null;
  let analyser = null;
  try {
    source = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
  } catch {
    return { read: () => null, close() {}, running: () => false };
  }
  const samples = new Float32Array(analyser.fftSize);
  return {
    running: () => ctx.state === 'running',
    read() {
      if (ctx.state !== 'running') return null;
      analyser.getFloatTimeDomainData(samples);
      let squares = 0;
      for (let i = 0; i < samples.length; i += 1) squares += samples[i] * samples[i];
      return Math.sqrt(squares / samples.length);
    },
    close() { try { source.disconnect(); } catch { /* ignore */ } },
  };
}

/** Adaptive speech gate: learns the room noise floor for ~0.5 s, then requires 3x that (minimum 0.008). */
export function createSpeechGate() {
  const floorSamples = [];
  let threshold = 0.012;
  let calibrated = false;
  const startedAt = Date.now();
  return {
    update(rms) {
      if (!calibrated) {
        floorSamples.push(rms);
        if (Date.now() - startedAt > 500 && floorSamples.length >= 5) {
          const sorted = [...floorSamples].sort((a, b) => a - b);
          const floor = sorted[Math.floor(sorted.length / 2)];
          threshold = Math.min(0.05, Math.max(0.008, floor * 3));
          calibrated = true;
        }
      }
      return rms > threshold;
    },
    get threshold() { return threshold; },
  };
}

/**
 * Continuous listener: keeps the mic open, records, and emits one Blob per spoken phrase.
 * Silence-only audio is never emitted. Call stop() to release the microphone.
 */
export function createServerListener({ onSegment, onLevel = () => {}, onError = () => {}, silenceMs = 1100, idleResetMs = 7000, maxMs = 20000 }) {
  let stream = null;
  let meter = null;
  let recorder = null;
  let timer = null;
  let stopped = false;
  let busy = false;

  async function start() {
    if (stream) return;
    unlockAudio();
    try {
      stream = await openMicrophone();
    } catch (error) {
      onError(error);
      return;
    }
    if (stopped) { stream.getTracks().forEach((t) => t.stop()); stream = null; return; }
    meter = createLevelMeter(stream);
    cycle();
  }

  function cycle() {
    if (stopped || !stream || busy) return;
    const chunks = [];
    const options = preferredRecorderOptions();
    try { recorder = new MediaRecorder(stream, options); } catch (error) { onError(error); return; }
    const gate = createSpeechGate();
    let heard = false;
    let lastVoiceAt = 0;
    const startedAt = Date.now();
    recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      clearInterval(timer);
      const type = recorder?.mimeType || options?.mimeType || 'audio/webm';
      recorder = null;
      if (stopped) return;
      const blob = new Blob(chunks, { type });
      if (heard && blob.size > 0) {
        busy = true;
        try { await onSegment(blob); } catch (error) { onError(error); }
        busy = false;
      }
      cycle();
    };
    recorder.start(250);
    timer = setInterval(() => {
      if (!recorder || recorder.state === 'inactive') return;
      const now = Date.now();
      const rms = meter.read();
      if (rms === null) {
        // Analyser unavailable: cannot detect silence, so send time-capped segments rather than dropping everything.
        heard = true;
        if (now - startedAt > 6000) recorder.stop();
        return;
      }
      onLevel(Math.min(1, rms / 0.18));
      if (gate.update(rms)) { heard = true; lastVoiceAt = now; }
      const elapsed = now - startedAt;
      if ((heard && now - lastVoiceAt > silenceMs) || (!heard && elapsed > idleResetMs) || elapsed > maxMs) recorder.stop();
    }, 50);
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
    try { if (recorder && recorder.state !== 'inactive') { recorder.onstop = null; recorder.stop(); } } catch { /* ignore */ }
    recorder = null;
    meter?.close();
    meter = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  return { start, stop };
}