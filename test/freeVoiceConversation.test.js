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
  assert.match(chat, /if \(\(voiceTurn \|\| continueLiveVoice\) && voiceConversationActive\)\s*\{[^}]*setVoiceStatus\('listening'[^}]*setConversationButton\(container, true,[^}]*scheduleConversationListen\(container, 500\);/);
  assert.match(chat, /scheduleConversationListen\(container, 500\)/);
});

test('Every view transcribes through the shared XOFT server STT module only', () => {
  const chat = read('public/js/views/chat.js');
  const input = read('public/js/dashboard/CommandInput.js');
  const stt = read('public/js/voice/stt.js');
  const companion = read('public/js/voice/companion.js');
  assert.match(chat, /from '\.\.\/voice\/stt\.js'/);
  assert.match(input, /from '\.\.\/voice\/stt\.js'/);
  assert.doesNotMatch(chat, /fetch\('\/api\/voice\/transcribe'/);
  assert.match(stt, /voiceFetch\('\/api\/voice\/transcribe'/);
  assert.doesNotMatch(stt, /whisper-fallback|transcribeLocally|on-device Whisper/);
  assert.match(chat, /transcribeAudioBlob\(blob, \(message\) =>/);
  assert.match(stt, /export function warmVoiceServer/);
  assert.match(stt, /fetch\('\/healthz'/);
  assert.match(chat, /warmVoiceServer/);
  assert.match(input, /warmVoiceServer/);
  assert.match(companion, /warmVoiceServer/);

  assert.match(chat, /TRANSCRIPTION READY · XOFT/);
  assert.doesNotMatch(chat, /SERVER UNAVAILABLE · LOCAL WHISPER/);
  assert.match(chat, /Gemini → OpenAI fallback/);
  assert.match(companion, /Gemini → OpenAI fallback/);
  assert.doesNotMatch(companion, /then on-device Whisper/);
});

test('Voice companion prefers native Android STT and keeps server STT as an explicit web fallback', () => {
  const companion = read('public/js/voice/companion.js');
  assert.match(companion, /'native-android':/);
  assert.match(companion, /hasNativeSpeechRecognition/);
  assert.match(companion, /'server-stt':/);
  assert.match(companion, /transcribe as transcribeAudioBlob.*from '\.\/stt\.js'/);
  assert.match(companion, /preferredRecorderOptions/);
  assert.match(companion, /blob\.size < 300/, 'short wake phrases must not be discarded by a high byte threshold');
  assert.match(companion, /Gemini → OpenAI fallback/);
  assert.doesNotMatch(companion, /window\.SpeechRecognition|webkitSpeechRecognition|browser-speech/);
});

test('Speech output prefers native Android TTS, then server TTS; browser speech synthesis is not used', () => {
  const tts = read('public/js/voice/speak-out.js');
  assert.match(tts, /\/api\/voice\/speak/);
  assert.match(tts, /waitForNativeSpeech/);
  assert.match(tts, /speakNative/);
  assert.ok(tts.indexOf('waitForNativeSpeech(spoken, runId)') < tts.indexOf('serverSpeak(spoken, runId)'), 'native local voice must be tried before server TTS');
  assert.doesNotMatch(tts, /speechSynthesis|SpeechSynthesisUtterance|browserSpeak/);
  assert.doesNotMatch(tts, /api\.elevenlabs\.io/, 'the browser must never hold or use the ElevenLabs key directly');
  assert.doesNotMatch(read('public/js/views/chat.js'), /freeOnly/);
});

test('The service worker cache uses server-only transcription and has a new cache key', () => {
  const sw = read('public/sw.js');
  assert.match(sw, /const CACHE_NAME = ['\"]xoft-shell-v\d+['\"]/);
  assert.doesNotMatch(sw, /whisper-fallback/);
  assert.match(sw, /\/js\/voice\/stt\.js/);
  assert.match(sw, /\/js\/voice\/voice-status\.js/);
  assert.match(read('public/js/app.js'), /sw\.js\?v=\d{8}-\d+/);
});

test('AUTO LISTEN uses XOFT server transcription only and never invokes browser speech recognition', () => {
  const input = read('public/js/dashboard/CommandInput.js');
  const listen = read('public/js/voice/listen.js');
  assert.match(input, /AUTO LISTEN always uses captured audio and XOFT server transcription/);
  assert.match(input, /function startRecognition\(\) \{\s*startServerListening\(\);/);
  assert.match(input, /createServerListener/);
  assert.doesNotMatch(input, /window\.SpeechRecognition|webkitSpeechRecognition|new Recognition\(/);
  assert.match(listen, /setInterval/);
  assert.doesNotMatch(listen, /requestAnimationFrame/);
});

test('Hands-free recording uses an unlocked shared AudioContext and never silently drops audio when the analyser is suspended', () => {
  const chat = read('public/js/views/chat.js');
  const listen = read('public/js/voice/listen.js');
  assert.match(chat, /unlockAudio\(\)/);
  assert.match(chat, /createSpeechGate\(\{ minThreshold: 0\.002, floorMultiplier: 2\.5 \}\)/);
  assert.doesNotMatch(chat, /rms > 0\.018/);
  assert.match(listen, /rms === null|read\(\) is null|=== null/);
});


test('Hands-free voice turns use a shorter silence endpoint for lower response latency', () => {
  const chat = read('public/js/views/chat.js');
  assert.match(chat, /Endpointing: stop after 650 ms of silence/);
  assert.match(chat, /detectedSpeech && now - lastVoiceAt > 650/);
});

test('Live video mode keeps transcript text off the video while saving turns to chat history and speaking replies', () => {
  const chat = read('public/js/views/chat.js');
  const css = read('public/css/app.css');
  assert.match(chat, /id="chat-live-video"/);
  assert.match(chat, /id="xoft-live-camera" autoplay playsinline muted/);
  assert.match(chat, /getUserMedia\(\{ video: \{ facingMode: 'user' \}, audio: false \}\)/);
  assert.match(chat, /if \(log\) log\.hidden = true/);
  assert.match(chat, /if \(inputRow\) inputRow\.hidden = true/);
  assert.match(chat, /history\.push\(\{ role: 'user', content: text/);
  assert.match(chat, /history\.push\(\{ role: 'assistant', content: responseToSpeak/);
  assert.match(chat, /await speakOut\(responseToSpeak\)/);
  assert.match(chat, /Live video shows only listening\/thinking\/speaking state/);
  assert.match(chat, /id="xoft-live-video-state"/);
  assert.match(chat, /overlayState\.textContent = statusText\[state\]/);
  assert.match(chat, /Listening · speak naturally/);
  assert.match(chat, /XOFT is thinking · preparing a reply/);
  assert.match(chat, /XOFT is speaking · your turn next/);
  assert.match(chat, /detectedSpeech && now - lastVoiceAt > 650/);
  assert.match(chat, /End Live Conversation/);
  assert.match(css, /\.chat-layout\.xoft-video-active #chat-log\[hidden\]/);
});


test('Live video sends a bounded camera snapshot for visual context without displaying a transcript over video', () => {
  const chat = read('public/js/views/chat.js');
  const server = read('src/index.js');
  assert.match(chat, /captureLiveVideoContext\(container, question\)/);
  assert.match(chat, /canvas\.toDataURL\('image\/jpeg', 0\.62\)/);
  assert.match(chat, /api\.post\('\/api\/vision\/live-frame'/);
  assert.match(chat, /if \(mode === 'chat' && liveVideoStream\)/);
  assert.match(server, /app\.post\('\/api\/vision\/live-frame', voiceLimit/);
  assert.match(server, /visionInterpreter\.interpretScreenshot/);
  assert.match(server, /LIVE_VISION_UNAVAILABLE/);
  assert.match(server, /base64\.length > 1_500_000/);
});


test('Browser-local Whisper is not required by the production transcription path', () => {
  const stt = read('public/js/voice/stt.js');
  const shell = read('public/sw.js');
  assert.doesNotMatch(stt, /whisper-fallback|transcribeLocally/);
  assert.doesNotMatch(shell, /whisper-fallback/);
});

test('Voice transcription prompt protects against noise hallucinations and preserves Nigerian English/Igbo code-switching', () => {
  const config = read('src/config/index.js');
  assert.match(config, /Nigerian English and Igbo/);
  assert.match(config, /code-switching/);
  assert.match(config, /never inject example words/);
  assert.match(config, /silence or background noise/);
  assert.match(config, /do not guess or infer words that are not clearly audible/);
});
