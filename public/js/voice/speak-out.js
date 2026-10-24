// XOFT speech output: ElevenLabs (via POST /api/voice/speak) by default, browser/device speechSynthesis as the fallback.
// The browser voice is used when ElevenLabs is not configured, fails, times out, or playback is blocked (e.g. mobile autoplay policy).
import { apiHeaders, getVoiceStatus, invalidateVoiceStatus } from './voice-status.js';
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

function canBrowserSpeak() {
  return typeof window !== 'undefined'
    && ('speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function');
}

export function canSpeakOut() {
  // The server voice needs only an <audio> element; the browser voice needs speechSynthesis.
  return typeof window !== 'undefined' && (canBrowserSpeak() || typeof Audio === 'function');
}

// Resolves the in-flight playback promise when audio is stopped from outside (user interrupts XOFT).
// Without this the promise never settled, so anything awaiting speech (the voice-conversation loop) hung forever.
let currentPlaybackDone = null;

function releaseAudio() {
  const interrupted = currentPlaybackDone;
  currentPlaybackDone = null;
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
  interrupted?.(false);
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

function speechChunks(text, limit = 650) {
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
    let watchdog = null;
    const finish = (success) => {
      if (finished) return;
      finished = true;
      clearTimeout(watchdog);
      if (runId === speechRun) {
        currentUtterance = null;
        setSpeechState(success ? 'idle' : 'error', success ? '' : 'Browser speech failed or timed out.');
      }
      resolve(success);
    };
    const next = () => {
      if (runId !== speechRun) return finish(false);
      if (index >= chunks.length) return finish(true);
      const utterance = new SpeechSynthesisUtterance(chunks[index++]);
      utterance.lang = 'en-NG';
      utterance.rate = 1.04;
      utterance.pitch = 1;
      utterance.volume = 1;
      const voices = synth.getVoices?.() ?? [];
      const preferred = voices.find((v) => /^en-NG$/i.test(v.lang))
        ?? voices.find((v) => /^en-GB$/i.test(v.lang))
        ?? voices.find((v) => /^en-US$/i.test(v.lang))
        ?? voices.find((v) => /^en/i.test(v.lang));
      if (preferred) { utterance.voice = preferred; utterance.lang = preferred.lang; }
      currentUtterance = utterance;
      // Some mobile browsers silently stall speechSynthesis without firing onstart/onend.
      // Bound each chunk so browser/device speech cannot leave XOFT stuck forever.
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        try { synth.cancel(); } catch { /* best effort */ }
        finish(false);
      }, 20000);
      utterance.onstart = () => { if (runId === speechRun) setSpeechState('speaking'); };
      utterance.onend = () => {
        clearTimeout(watchdog);
        if (runId === speechRun) next();
      };
      utterance.onerror = (event) => {
        clearTimeout(watchdog);
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

// --- Low-latency ElevenLabs playback ------------------------------------------------------------
// Speaking a whole reply as ONE clip means waiting for every word to be synthesised before hearing anything.
// Instead the reply is split into sentence-sized chunks: chunk 1 is short so audio starts fast, and the next
// chunks are synthesised while the current one plays (at most 2 requests in flight, which is within
// ElevenLabs' concurrency limit on free plans).
const FIRST_CHUNK_MAX = 130;
const CHUNK_MAX = 320;
const MAX_CHUNKS = 8;

/** Splits text into speakable chunks at sentence boundaries. Exported for tests. */
export function splitForSpeech(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = (clean.match(/[^.!?\u2026]+(?:[.!?\u2026]+["')\]]*|$)\s*/g) ?? [clean]).map((x) => x.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    const limit = chunks.length === 0 ? FIRST_CHUNK_MAX : CHUNK_MAX;
    if (current && (current + ' ' + sentence).length > limit) {
      chunks.push(current);
      current = sentence;
    } else current = current ? current + ' ' + sentence : sentence;
  }
  if (current) chunks.push(current);

  // A very long first sentence would delay the first sound: break it at a comma/semicolon if there is one.
  if (chunks[0] && chunks[0].length > 200) {
    const head = chunks[0].slice(0, 190);
    const cut = Math.max(head.lastIndexOf(','), head.lastIndexOf(';'), head.lastIndexOf(':'));
    if (cut >= 50) chunks.splice(0, 1, chunks[0].slice(0, cut + 1).trim(), chunks[0].slice(cut + 1).trim());
  }
  // Any other oversized chunk is split on word boundaries.
  const sized = chunks.flatMap((chunk, index) => (index > 0 && chunk.length > CHUNK_MAX ? speechChunks(chunk, CHUNK_MAX) : [chunk])).filter(Boolean);
  // Bound the number of requests per reply.
  if (sized.length > MAX_CHUNKS) sized.splice(MAX_CHUNKS - 1, sized.length, sized.slice(MAX_CHUNKS - 1).join(' '));
  return sized;
}

async function fetchSpeechBlob(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch('/api/voice/speak', {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ text }),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) {
      if (res.status === 503) invalidateVoiceStatus();
      return null;
    }
    const blob = await res.blob();
    return blob?.size ? blob : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Plays one clip. `final` controls whether the idle state is announced when it ends (not between chunks).
function playSpeechBlob(blob, runId, final) {
  return new Promise((resolve) => {
    releaseAudio();
    currentAudioUrl = URL.createObjectURL(blob);
    const audio = new Audio(currentAudioUrl);
    currentAudio = audio;
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      if (currentPlaybackDone === done) currentPlaybackDone = null;
      if (currentAudio === audio) releaseAudio();
      if (runId === speechRun && ok && final) setSpeechState('idle');
      resolve(ok);
    };
    currentPlaybackDone = done;
    audio.onended = () => done(true);
    audio.onerror = () => done(false);
    audio.onplaying = () => { if (runId === speechRun) setSpeechState('speaking'); };
    // play() rejects when the platform blocks autoplay; the caller then falls back to the browser voice.
    audio.play().catch(() => done(false));
  });
}

async function elevenLabsSpeak(text, runId) {
  if (typeof Audio !== 'function') return false;
  const status = await getVoiceStatus();
  if (status?.tts?.configured === false) return false;
  const chunks = splitForSpeech(text);
  if (!chunks.length) return false;

  const pending = new Map();
  const ensure = (index) => {
    if (index < chunks.length && !pending.has(index)) pending.set(index, fetchSpeechBlob(chunks[index]));
    return pending.get(index);
  };
  ensure(0);
  ensure(1);

  for (let index = 0; index < chunks.length; index += 1) {
    const blob = await ensure(index);
    if (runId !== speechRun) return false;
    ensure(index + 2); // keep the pipeline two chunks ahead of playback
    const rest = () => chunks.slice(index).join(' ');
    if (!blob) {
      // Nothing played yet: let the caller use the browser voice for the whole reply.
      // Already speaking: finish the remainder with the device voice rather than going silent.
      return index === 0 ? false : browserSpeak(rest(), runId);
    }
    const ok = await playSpeechBlob(blob, runId, index === chunks.length - 1);
    if (runId !== speechRun) return false;
    if (!ok) return index === 0 ? false : browserSpeak(rest(), runId);
  }
  return true;
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

  // 1) Default: ElevenLabs through the XOFT server.
  const served = await elevenLabsSpeak(spoken, runId);
  if (served || runId !== speechRun) return served;

  // 2) Fallback: the device/browser voice (no network request).
  if (!canBrowserSpeak()) {
    setSpeechState('error', 'Server voice is unavailable and this browser has no text-to-speech.');
    return false;
  }
  const browserPlayed = await browserSpeak(spoken, runId);
  if (browserPlayed || runId !== speechRun) return browserPlayed;
  setSpeechState('error', 'Speech output failed. Check ELEVENLABS_API_KEY or enable text-to-speech in your browser or device settings.');
  return false;
}
