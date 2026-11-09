// XOFT speech output: local Android TextToSpeech first, server TTS second.
// Browser-provided speech synthesis is intentionally not used: it is inconsistent across mobile browsers/WebViews.
import { apiHeaders, getVoiceStatus, peekVoiceStatus, invalidateVoiceStatus } from './voice-status.js';
import { hasNativeSpeech, speakNative, stopNativeSpeech } from './native-bridge.js';

const ENABLED_KEY = 'xoft_speak_out_enabled';
let currentAudio = null;
let currentAudioUrl = null;
let speechRun = 0;

function setSpeechState(state, detail = '') {
  window.dispatchEvent(new CustomEvent('xoft:speech-state', { detail: { state, detail } }));
}

export function isSpeakOutEnabled() {
  try { const saved = localStorage.getItem(ENABLED_KEY); return saved === null ? true : saved === 'true'; }
  catch { return true; }
}

export function setSpeakOutEnabled(enabled) {
  try { localStorage.setItem(ENABLED_KEY, String(Boolean(enabled))); } catch { /* storage may be unavailable */ }
  if (!enabled) stopSpeaking();
  return Boolean(enabled);
}

export function canSpeakOut() {
  return typeof window !== 'undefined' && (hasNativeSpeech() || typeof Audio === 'function');
}

function releaseAudio() {
  if (!currentAudio) return;
  currentAudio.onended = null;
  currentAudio.onerror = null;
  currentAudio.pause();
  currentAudio.removeAttribute('src');
  currentAudio.load?.();
  currentAudio = null;
  if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
  currentAudioUrl = null;
}

export function stopSpeaking() {
  speechRun += 1;
  stopNativeSpeech();
  releaseAudio();
  setSpeechState('idle');
}

export function splitForSpeech(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = (clean.match(/[^.!?\u2026]+(?:[.!?\u2026]+["')\]]*|$)\s*/g) ?? [clean]).map((x) => x.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    const limit = chunks.length === 0 ? 130 : 320;
    if (current && (current + ' ' + sentence).length > limit) { chunks.push(current); current = sentence; }
    else current = current ? current + ' ' + sentence : sentence;
  }
  if (current) chunks.push(current);
  return chunks.slice(0, 8);
}

function waitForNativeSpeech(text, runId) {
  if (!hasNativeSpeech()) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let started = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('xoft:speech-state', onState);
      resolve(ok);
    };
    const onState = (event) => {
      const state = event.detail?.state;
      if (state === 'speaking') { started = true; if (runId === speechRun) setSpeechState('speaking'); }
      if (state === 'error') finish(false);
      if (state === 'idle' && started) finish(true);
    };
    window.addEventListener('xoft:speech-state', onState);
    const timer = setTimeout(() => finish(false), Math.max(15000, Math.min(60000, text.length * 90)));
    if (!speakNative(text)) finish(false);
    else setSpeechState('loading');
  });
}

async function fetchSpeechBlob(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch('/api/voice/speak', {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ text }),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) { if (res.status === 503) invalidateVoiceStatus(); return null; }
    const blob = await res.blob();
    return blob?.size ? blob : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function playBlob(blob, runId) {
  return new Promise((resolve) => {
    releaseAudio();
    currentAudioUrl = URL.createObjectURL(blob);
    const audio = new Audio(currentAudioUrl);
    currentAudio = audio;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (currentAudio === audio) releaseAudio();
      resolve(ok);
    };
    audio.onended = () => finish(true);
    audio.onerror = () => finish(false);
    audio.onplaying = () => { if (runId === speechRun) setSpeechState('speaking'); };
    audio.play().catch(() => finish(false));
  });
}

async function serverSpeak(text, runId) {
  if (typeof Audio !== 'function') return false;
  if (peekVoiceStatus()?.tts?.configured === false) return false;
  getVoiceStatus().catch(() => null);
  const chunks = splitForSpeech(text);
  for (const chunk of chunks) {
    if (runId !== speechRun) return false;
    const blob = await fetchSpeechBlob(chunk);
    if (!blob || runId !== speechRun) return false;
    if (!await playBlob(blob, runId)) return false;
  }
  return true;
}

export async function speakOut(text) {
  const message = String(text ?? '').trim();
  if (!message || !isSpeakOutEnabled() || !canSpeakOut()) return false;
  const spoken = message.replace(/https?:\/\/\S+/g, 'link').replace(/\s+/g, ' ').slice(0, 4000);
  if (!spoken) return false;
  stopSpeaking();
  const runId = speechRun;
  setSpeechState('loading');

  // Prefer deterministic local OS speech. It requires no API key or AI model.
  const nativePlayed = await waitForNativeSpeech(spoken, runId);
  if (nativePlayed || runId !== speechRun) {
    if (nativePlayed) setSpeechState('idle');
    return nativePlayed;
  }

  // Optional server TTS remains available when no native OS voice is installed.
  const served = await serverSpeak(spoken, runId);
  if (served || runId !== speechRun) { if (served) setSpeechState('idle'); return served; }
  setSpeechState('error', 'Speech output is unavailable. Install/enable a native device voice or configure a server TTS provider.');
  return false;
}
