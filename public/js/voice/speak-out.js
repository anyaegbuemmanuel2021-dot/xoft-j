// Reliable XOFT speech output: ElevenLabs when available, browser TTS fallback.
const ENABLED_KEY = 'xoft_speak_out_enabled';
let currentAudio = null;
let currentAudioUrl = null;
let currentUtterance = null;
let speechRun = 0;

function setSpeechState(state, detail = '') {
  window.dispatchEvent(new CustomEvent('xoft:speech-state', { detail: { state, detail } }));
}

export function isSpeakOutEnabled() {
  try {
    const saved = localStorage.getItem(ENABLED_KEY);
    return saved === null ? true : saved === 'true';
  } catch { return true; }
}

export function setSpeakOutEnabled(enabled) {
  try { localStorage.setItem(ENABLED_KEY, String(Boolean(enabled))); } catch { /* storage may be unavailable */ }
  if (!enabled) stopSpeaking();
  return Boolean(enabled);
}

export function canSpeakOut() {
  return typeof window !== 'undefined'
    && (typeof window.Audio === 'function'
      || ('speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function'));
}

function releaseAudio() {
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio.removeAttribute('src');
    currentAudio.load?.();
    currentAudio = null;
  }
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
}

export function stopSpeaking() {
  speechRun += 1;
  releaseAudio();
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try { window.speechSynthesis.cancel(); } catch { /* browser TTS is best effort */ }
  }
  currentUtterance = null;
  setSpeechState('idle');
}

function speechChunks(text, limit = 220) {
  const words = text.split(/\s+/);
  const chunks = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > limit && current) {
      chunks.push(current);
      current = word;
    } else current = (current ? current + ' ' : '') + word;
  }
  if (current) chunks.push(current);
  return chunks;
}

function browserSpeak(text, runId) {
  if (!('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance !== 'function') {
    setSpeechState('error', 'Text-to-speech is not supported by this browser.');
    return Promise.resolve(false);
  }
  const synth = window.speechSynthesis;
  const chunks = speechChunks(text, 220);
  return new Promise((resolve) => {
    let index = 0;
    let finished = false;
    const finish = (success) => {
      if (finished) return;
      finished = true;
      if (runId === speechRun) {
        currentUtterance = null;
        setSpeechState(success ? 'idle' : 'error', success ? '' : 'Browser speech failed.');
      }
      resolve(success);
    };
    const next = () => {
      if (runId !== speechRun) return finish(false);
      if (index >= chunks.length) return finish(true);
      const utterance = new SpeechSynthesisUtterance(chunks[index++]);
      utterance.lang = 'en-NG';
      utterance.rate = 0.96;
      utterance.pitch = 1;
      utterance.volume = 1;
      const voices = synth.getVoices?.() ?? [];
      const preferred = voices.find((v) => /^en-NG$/i.test(v.lang))
        ?? voices.find((v) => /^en-GB$/i.test(v.lang))
        ?? voices.find((v) => /^en-US$/i.test(v.lang))
        ?? voices.find((v) => /^en/i.test(v.lang));
      if (preferred) { utterance.voice = preferred; utterance.lang = preferred.lang; }
      currentUtterance = utterance;
      utterance.onstart = () => { if (runId === speechRun) setSpeechState('speaking'); };
      utterance.onend = () => { if (runId === speechRun) next(); };
      utterance.onerror = (event) => {
        // A cancel caused by STOP is expected; don't report it as a failure.
        if (runId !== speechRun || event.error === 'canceled' || event.error === 'interrupted') return finish(false);
        finish(false);
      };
      try { synth.speak(utterance); }
      catch { finish(false); }
    };
    // A few mobile browsers expose voices asynchronously.
    if (!synth.getVoices?.().length) {
      const onVoices = () => { synth.removeEventListener?.('voiceschanged', onVoices); next(); };
      synth.addEventListener?.('voiceschanged', onVoices, { once: true });
      setTimeout(() => {
        synth.removeEventListener?.('voiceschanged', onVoices);
        if (index === 0 && !finished) next();
      }, 350);
    } else next();
  });
}

async function elevenLabsSpeak(text, runId) {
  const headers = { 'Content-Type': 'application/json' };
  try {
    const key = localStorage.getItem('xoft_api_key');
    if (key) headers['X-API-Key'] = key;
  } catch { /* optional client key */ }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch('/api/voice/speak', {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ text }),
    });
    if (!response.ok || !(response.headers.get('content-type') || '').toLowerCase().includes('audio')) return false;
    const blob = await response.blob();
    if (!blob.size || runId !== speechRun) return false;
    releaseAudio();
    currentAudioUrl = URL.createObjectURL(blob);
    const audio = new Audio();
    currentAudio = audio;
    audio.preload = 'auto';
    audio.src = currentAudioUrl;
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        if (runId === speechRun) {
          releaseAudio();
          setSpeechState(ok ? 'idle' : 'error', ok ? '' : 'Audio playback failed.');
        }
        resolve(ok);
      };
      audio.onended = () => finish(true);
      audio.onerror = () => finish(false);
      audio.onplaying = () => { if (runId === speechRun) setSpeechState('speaking'); };
      Promise.resolve(audio.play()).then(() => {
        if (runId === speechRun) setSpeechState('speaking');
      }).catch(() => finish(false));
    });
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function speakOut(text) {
  const message = String(text ?? '').trim();
  if (!message || !isSpeakOutEnabled() || !canSpeakOut()) return false;
  const spoken = message
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/\s+/g, ' ')
    .slice(0, 4000);
  if (!spoken) return false;
  stopSpeaking();
  const runId = speechRun;
  setSpeechState('loading');
  // Free-first: use the device/browser voice by default, without making a network request.
  const browserPlayed = await browserSpeak(spoken, runId);
  if (browserPlayed || runId !== speechRun) return browserPlayed;
  // Optional quality fallback: if browser speech is unsupported or fails, try configured ElevenLabs.
  const audioPlayed = await elevenLabsSpeak(spoken, runId);
  if (audioPlayed || runId !== speechRun) return audioPlayed;
  setSpeechState('error', 'Browser speech and ElevenLabs were unavailable.');
  return false;
}
