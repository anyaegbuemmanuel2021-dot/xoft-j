// XOFT speech output uses server-generated audio (Gemini first, OpenAI fallback).
// No browser SpeechSynthesis fallback: provider and device behavior varies too much for dependable voice output.
import { apiHeaders, getVoiceStatus, peekVoiceStatus, invalidateVoiceStatus } from './voice-status.js';
const ENABLED_KEY = 'xoft_speak_out_enabled';
let currentAudio = null;
let currentAudioUrl = null;
let speechRun = 0;
const activeTtsControllers = new Set();

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
  // Audio playback is only the output device; all speech generation happens on XOFT's server.
  return typeof window !== 'undefined' && typeof Audio === 'function';
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
  for (const controller of activeTtsControllers) controller.abort();
  activeTtsControllers.clear();
  releaseAudio();
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

// --- Low-latency server-voice playback ------------------------------------------------------------
// Speaking a whole reply as ONE clip means waiting for every word to be synthesised before hearing anything.
// Instead the reply is split into sentence-sized chunks: chunk 1 is short so audio starts fast, and the next
// chunks are synthesised while the current one plays (at most 2 requests in flight, which is within
// the providers' free-plan concurrency limits).
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
  activeTtsControllers.add(controller);
  const timer = setTimeout(() => controller.abort(), 18000);
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
    activeTtsControllers.delete(controller);
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
    // play() rejects when the platform blocks autoplay; report the failure instead of switching engines.
    audio.play().catch(() => done(false));
  });
}

async function serverSpeak(text, runId) {
  if (typeof Audio !== 'function') return false;
  // Never block the first sound on the status call: use the cached answer and refresh it in the background.
  if (peekVoiceStatus()?.tts?.configured === false) return false;
  getVoiceStatus().catch(() => null);
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
    if (!blob) {
      // Keep one speech engine for the entire reply; never switch to browser TTS.
      if (index > 0) setSpeechState('error', 'Server voice failed before the reply finished.');
      return false;
    }
    const ok = await playSpeechBlob(blob, runId, index === chunks.length - 1);
    if (runId !== speechRun) return false;
    if (!ok) { setSpeechState('error', 'XOFT audio playback failed.'); return false; }
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

  // 1) Default: Gemini → OpenAI server voice through the XOFT server.
  const served = await serverSpeak(spoken, runId);
  if (served || runId !== speechRun) return served;

  if (!served) setSpeechState('error', 'XOFT server voice is unavailable. Check the voice provider configuration and connection.');
  return served;
}
