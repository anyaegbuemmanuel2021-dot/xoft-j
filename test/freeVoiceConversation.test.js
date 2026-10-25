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
  assert.match(chat, /transcribeAudioBlob\(blob, \(message\) =>/);
  assert.match(chat, /TRANSCRIBING ON XOFT SERVER/);
  assert.match(chat, /SERVER UNAVAILABLE · LOCAL WHISPER/);
  assert.match(chat, /OpenAI → Gemini fallback/);
  assert.match(whisper, /onnx-community\/whisper-tiny['\"]?/);
  assert.doesNotMatch(whisper, /whisper-tiny\.en/, 'local fallback must be multilingual for English/Igbo code-switching');
  assert.match(whisper, /if \(!blob \|\| !blob\.size\) throw new Error/);
  assert.doesNotMatch(whisper, /api\.openai\.com|api\.elevenlabs\.io/);
});

test('Voice companion defaults to server STT and uses shared fallback instead of browser speech first', () => {
  const companion = read('public/js/voice/companion.js');
  assert.ok(companion.indexOf("'server-stt':") < companion.indexOf("'browser-speech':"), 'server STT must be the default backend');
  assert.match(companion, /transcribe as transcribeAudioBlob.*from '\.\/stt\.js'/);
  assert.match(companion, /preferredRecorderOptions/);
  assert.match(companion, /blob\.size < 300/, 'short wake phrases must not be discarded by a high byte threshold');
  assert.match(companion, /OpenAI → Gemini, then local Whisper/);
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


test('Local STT fallback uses multilingual Whisper and refuses empty audio rather than inventing words', () => {
  const whisper = read('public/js/voice/whisper-fallback.js');
  assert.match(whisper, /onnx-community\/whisper-tiny['\"]?/);
  assert.doesNotMatch(whisper, /whisper-tiny\.en/);
  assert.match(whisper, /if \(!blob \|\| !blob\.size\) throw new Error\('No recorded audio was available\.'\)/);
  assert.match(whisper, /if \(!blob \|\| !blob\.size\) throw new Error\('No recorded audio was available\.'\)/);
});

test('Voice transcription prompt protects against noise hallucinations and preserves Nigerian English/Igbo code-switching', () => {
  const config = read('src/config/index.js');
  assert.match(config, /Nigerian English and Igbo/);
  assert.match(config, /code-switching/);
  assert.match(config, /never inject example words/);
  assert.match(config, /silence or background noise/);
  assert.match(config, /do not guess or infer words that are not clearly audible/);
});
