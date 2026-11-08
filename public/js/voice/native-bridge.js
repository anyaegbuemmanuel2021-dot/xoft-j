// native-bridge.js — optional hand-off to the XOFT Android companion.
// A web page cannot draw over the phone's home screen, so when XOFT runs inside the companion's WebView the
// companion exposes `window.XoftNative`. This module mirrors the live-voice state to it; the companion shows
// its floating XOFT bubble when the user leaves the app mid-conversation. Without the bridge this does nothing.
const LIVE_STATES = new Set(['listening', 'thinking', 'speaking']);
let lastState = '';

function bridge() {
  const native = typeof window !== 'undefined' ? window.XoftNative : null;
  return native && typeof native.onVoiceState === 'function' ? native : null;
}

export function pushVoiceState(state) {
  const next = LIVE_STATES.has(state) ? state : 'idle';
  if (next === lastState) return;
  lastState = next;
  try { bridge()?.onVoiceState(next); } catch { /* the native bridge is best effort */ }
}

if (typeof window !== 'undefined' && !window.__xoftNativeBridgeBound) {
  window.__xoftNativeBridgeBound = true;
  window.addEventListener('xoft:voice-state', (e) => pushVoiceState(e.detail?.state || 'idle'));
  window.addEventListener('xoft:speech-state', (e) => { if (e.detail?.state === 'speaking') pushVoiceState('speaking'); });
  window.addEventListener('xoft:native-speech-state', (e) => {
    const state = e.detail?.state || 'idle';
    window.dispatchEvent(new CustomEvent('xoft:speech-state', { detail: { state } }));
    pushVoiceState(state === 'speaking' ? 'speaking' : 'idle');
  });
}

/** Speak through Android's native TextToSpeech service when XOFT is inside the companion. */
export function speakNative(text) {
  const native = bridge();
  if (!native || typeof native.speak !== 'function') return false;
  try { return native.speak(String(text ?? '').slice(0, 4000)) === true; } catch { return false; }
}

export function stopNativeSpeech() {
  const native = bridge();
  try { native?.stopSpeaking?.(); } catch { /* best effort */ }
}

export function hasNativeSpeech() { const native = bridge(); return Boolean(native && typeof native.speak === 'function'); }

/** True only when Android exposes its on-device recognizer and microphone permission is granted. */
export function hasNativeSpeechRecognition() {
  const native = bridge();
  try { return Boolean(native && typeof native.canListenOffline === 'function' && native.canListenOffline() === true); }
  catch { return false; }
}

export function startNativeListening(language = 'auto') {
  const native = bridge();
  if (!native || typeof native.startListening !== 'function') return false;
  try { return native.startListening(language) === true; } catch { return false; }
}

export function stopNativeListening() {
  const native = bridge();
  try { native?.stopListening?.(); } catch { /* best effort */ }
}
