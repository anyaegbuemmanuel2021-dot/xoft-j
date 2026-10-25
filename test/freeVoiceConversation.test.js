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
  // Status updates happen before the UI button is repainted; assert the whole turn-resume sequence, not an obsolete adjacent-line layout.
  assert.match(chat, /if \(voiceTurn && voiceConversationActive\)\s*\{[^}]*setVoiceStatus\('listening'[^}]*setConversationButton\(container, true,[^}]*scheduleConversationListen\(container, 500\);/);
  assert.match(chat, /scheduleConversationListen\(container, 500\)/);
});

test('Every view transcribes through the shared STT module: server gpt-transcribe/Gemini first, on-device Whisper second', () => {
  const chat = read('public/js/views/chat.js');
  const input = read('public/js/dashboard/CommandInput.js');
  const stt = read('public/js/voice/stt.js');
  const whisper = read('public/js/voice/whisper-fallback.js');
  assert.match(chat, /from '\.\.\/voice\/stt\.js'/);
  assert.match(input, /from '\.\.\/voice\/stt\.js'/);
  assert.doesNotMatch(chat, /fetch\('\/api\/voice\/transcribe'/);
  assert.match(stt, /voiceFetch\('\/api\/voice\/transcribe'/);
  assert.ok(stt.indexOf('transcribeOnServer(blob)') < stt.indexOf('transcribeLocally(blob)'), 'server STT must be attempted before on-device Whisper');
  assert.match(whisper, /onnx-community\/whisper-tiny\.en/);
  assert.doesNotMatch(whisper, /api\.openai\.com|api\.elevenlabs\.io/);
});

test('Speech output uses ElevenLabs by default and falls back to browser TTS', () => {
  const tts = read('public/js/voice/speak-out.js');
  assert.match(tts, /\/api\/voice\/speak/);
  assert.match(tts, /speechSynthesis/);
  assert.ok(tts.indexOf('elevenLabsSpeak(spoken, runId)') < tts.indexOf('browserSpeak(spoken, runId)'), 'ElevenLabs must be tried before the browser voice');
  assert.doesNotMatch(tts, /api\.elevenlabs\.io/, 'the browser must never hold or use the ElevenLabs key directly');
  assert.doesNotMatch(read('public/js/views/chat.js'), /freeOnly/);
});

test('The service worker cache includes the local voice fallback and has a new cache key', () => {
  const sw = read('public/sw.js');
  assert.match(sw, /const CACHE_NAME = ['\"]xoft-shell-v\d+['\"]/);
  assert.match(sw, /\/js\/voice\/whisper-fallback\.js/);
  assert.match(sw, /\/js\/voice\/stt\.js/);
  assert.match(sw, /\/js\/voice\/voice-status\.js/);
  assert.match(read('public/js/app.js'), /sw\.js\?v=\d{8}-\d+/);
});

test('AUTO LISTEN uses Whisper by default and only uses browser Web Speech when the browser cannot record', () => {
  const input = read('public/js/dashboard/CommandInput.js');
  const listen = read('public/js/voice/listen.js');
  assert.match(input, /let serverMode = canRecord \|\| !Recognition/);
  assert.match(input, /event\.error === 'network' \|\| event\.error === 'service-not-allowed'/);
  assert.match(input, /createServerListener/);
  assert.match(listen, /setInterval/);
  assert.doesNotMatch(listen, /requestAnimationFrame/);
});

test('Hands-free recording uses an unlocked shared AudioContext and never silently drops audio when the analyser is suspended', () => {
  const chat = read('public/js/views/chat.js');
  const listen = read('public/js/voice/listen.js');
  assert.match(chat, /unlockAudio\(\)/);
  assert.match(chat, /createSpeechGate\(\)/);
  assert.doesNotMatch(chat, /rms > 0\.018/);
  assert.match(listen, /rms === null|read\(\) is null|=== null/);
});
