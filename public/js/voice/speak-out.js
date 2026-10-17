// Browser-native text-to-speech for XOFT. No extra API key or paid service required.
const ENABLED_KEY = 'xoft_speak_out_enabled';
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
    && 'speechSynthesis' in window
    && typeof window.SpeechSynthesisUtterance === 'function';
}

export function stopSpeaking() {
  if (!canSpeakOut()) return;
  window.speechSynthesis.cancel();
  currentUtterance = null;
}

export function speakOut(text) {
  const message = String(text ?? '').trim();
  if (!message || !isSpeakOutEnabled() || !canSpeakOut()) return false;

  // Avoid reading raw JSON or excessively long tool/debug output aloud.
  const spoken = message
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/\s+/g, ' ')
    .slice(0, 5000);
  if (!spoken) return false;

  stopSpeaking();
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
  if (preferred) {
    utterance.voice = preferred;
    utterance.lang = preferred.lang;
  }

  currentUtterance = utterance;
  utterance.onend = () => { if (currentUtterance === utterance) currentUtterance = null; };
  utterance.onerror = () => { if (currentUtterance === utterance) currentUtterance = null; };
  window.speechSynthesis.speak(utterance);
  return true;
}
