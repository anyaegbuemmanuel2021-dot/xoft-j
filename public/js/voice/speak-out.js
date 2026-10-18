// XOFT speech output: use the configured server-side ElevenLabs voice (including ELEVENLABS_VOICE_ID)
// when available, with browser speech as a graceful no-key fallback.
const ENABLED_KEY = 'xoft_speak_out_enabled';
let currentAudio = null;
let currentUtterance = null;

export function isSpeakOutEnabled() {
  const saved = localStorage.getItem(ENABLED_KEY);
  return saved === null ? true : saved === 'true';
}

export function setSpeakOutEnabled(enabled) {
  localStorage.setItem(ENABLED_KEY, String(Boolean(enabled)));
  if (!enabled) stopSpeaking();
  return Boolean(enabled);
}

export function canSpeakOut() {
  return typeof window !== 'undefined'
    && (typeof window.Audio === 'function'
      || ('speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function'));
}

export function stopSpeaking() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  currentUtterance = null;
}

function browserSpeak(spoken) {
  if (!('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance !== 'function') return false;
  const utterance = new SpeechSynthesisUtterance(spoken);
  utterance.lang = 'en-NG';
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.volume = 1;
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find((voice) => /^en-NG$/i.test(voice.lang))
    ?? voices.find((voice) => /^en-GB$/i.test(voice.lang))
    ?? voices.find((voice) => /^en-US$/i.test(voice.lang))
    ?? voices.find((voice) => /^en/i.test(voice.lang));
  if (preferred) { utterance.voice = preferred; utterance.lang = preferred.lang; }
  currentUtterance = utterance;
  utterance.onend = () => { if (currentUtterance === utterance) currentUtterance = null; };
  utterance.onerror = () => { if (currentUtterance === utterance) currentUtterance = null; };
  window.speechSynthesis.speak(utterance);
  return true;
}

export async function speakOut(text) {
  const message = String(text ?? '').trim();
  if (!message || !isSpeakOutEnabled() || !canSpeakOut()) return false;

  // Do not speak raw URLs, JSON dumps or unlimited tool output.
  const spoken = message.replace(/https?:\/\/\S+/g, 'link').replace(/\s+/g, ' ').slice(0, 5000);
  if (!spoken) return false;
  stopSpeaking();

  // Prefer XOFT's configured ElevenLabs voice ID through the existing protected endpoint.
  // If the key/voice is not configured or the request fails, use device speech instead.
  try {
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = localStorage.getItem('xoft_api_key');
    if (apiKey) headers['X-API-Key'] = apiKey;
    const response = await fetch('/api/voice/speak', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: spoken }),
    });
    if (response.ok && (response.headers.get('content-type') || '').includes('audio')) {
      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      currentAudio = audio;
      audio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        if (currentAudio === audio) currentAudio = null;
      };
      audio.onerror = () => {
        URL.revokeObjectURL(audioUrl);
        if (currentAudio === audio) currentAudio = null;
      };
      await audio.play();
      return true;
    }
  } catch {
    // Browser fallback below is intentional for missing keys, blocked autoplay or network errors.
  }
  return browserSpeak(spoken);
}
