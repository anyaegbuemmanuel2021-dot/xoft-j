import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Chat provides a user-controlled hands-free voice conversation mode', () => {
  const chat = read('public/js/views/chat.js');
  assert.match(chat, /id="chat-voice-conversation"/);
  assert.match(chat, /function toggleVoiceConversation\(container\)/);
  assert.match(chat, /function stopVoiceConversation\(container/);
  assert.match(chat, /voiceConversationActive = true/);
});

test('Recognized speech is sent to XOFT automatically and listening resumes after the answer', () => {
  const chat = read('public/js/views/chat.js');
  assert.match(chat, /void send\(container, finalText\.trim\(\), \{ voiceTurn: true \}\)/);
  assert.match(chat, /await send\(container, voiceText, \{ voiceTurn: true \}\)/);
  assert.match(chat, /if \(voiceTurn && voiceConversationActive\)\s*\{\s*setConversationButton/);
  assert.match(chat, /scheduleConversationListen\(container, 500\)/);
});

test('Whisper fallback runs in the browser rather than calling a paid transcription API', () => {
  const chat = read('public/js/views/chat.js');
  const whisper = read('public/js/voice/whisper-fallback.js');
  assert.match(chat, /transcribeAudioBlob\(blob\)/);
  assert.match(whisper, /onnx-community\/whisper-tiny\.en/);
  assert.doesNotMatch(whisper, /api\.openai\.com|api\.elevenlabs\.io/);
});

test('Speech output uses browser-native TTS only and does not call a paid voice endpoint', () => {
  const tts = read('public/js/voice/speak-out.js');
  assert.match(tts, /speechSynthesis/);
  assert.doesNotMatch(tts, /\/api\/voice\/speak|elevenLabsSpeak|api\.elevenlabs\.io/);
});

test('The service worker cache includes the local voice fallback and has a new cache key', () => {
  const sw = read('public/sw.js');
  assert.match(sw, /xoft-shell-v13/);
  assert.match(sw, /\/js\/voice\/whisper-fallback\.js/);
  assert.match(read('public/js/app.js'), /sw\.js\?v=20261019-4/);
});
