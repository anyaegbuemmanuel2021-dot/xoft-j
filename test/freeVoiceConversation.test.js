import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { postVoiceCommand } from '../public/js/voice/command-request.js';
import { transcribe } from '../public/js/voice/stt.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Chat provides a user-controlled hands-free voice conversation mode', () => {
  const chat = read('public/js/views/chat.js');
  assert.match(chat, /id="chat-voice-conversation"/);
  assert.match(chat, /function toggleVoiceConversation\(container\)/);
  assert.match(chat, /function stopVoiceConversation\(container/);
  assert.match(chat, /voiceConversationActive = true/);
  assert.match(chat, /hasNativeSpeechRecognition/);
  assert.match(chat, /startNativeListening/);
  assert.match(chat, /xoft:native-transcript/);
});

test('Recognized speech is sent to XOFT automatically and listening resumes after the answer', () => {
  const chat = read('public/js/views/chat.js');
  assert.match(chat, /transcribeAudioBlob\(blob/);
  assert.match(chat, /if \(voiceText && voiceConversationActive\)\s*\{\s*await send\(container, voiceText, \{ voiceTurn: true \}\)/);

  // Status updates happen before the UI button is repainted; assert the whole turn-resume sequence, not an obsolete adjacent-line layout.
  assert.match(chat, /if \(\(voiceTurn \|\| continueLiveVoice\) && voiceConversationActive\)\s*\{[^}]*setVoiceStatus\('listening'[^}]*setConversationButton\(container, true,[^}]*scheduleConversationListen\(container, 500\);/);
  assert.match(chat, /scheduleConversationListen\(container, 500\)/);
});

test('Web views use server STT and Android companion can use the native on-device recognizer', () => {
  const chat = read('public/js/views/chat.js');
  const input = read('public/js/dashboard/CommandInput.js');
  const stt = read('public/js/voice/stt.js');
  const companion = read('public/js/voice/companion.js');
  assert.doesNotMatch(chat, /window\\.SpeechRecognition|webkitSpeechRecognition/);
  assert.doesNotMatch(input, /window\\.SpeechRecognition|webkitSpeechRecognition/);
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

test('Voice companion prefers native Android STT and retains server STT fallback without browser speech recognition', () => {
  const companion = read('public/js/voice/companion.js');
  assert.match(companion, /'server-stt':/);
  assert.match(companion, /'native-android':/);
  assert.match(companion, /hasNativeAudioCapture/);
  assert.match(companion, /startNativeAudioCapture/);
  assert.match(companion, /transcribeNativeAudio/);
  assert.match(companion, /xoft:native-audio/);
  assert.match(companion, /void warmVoiceServer\(\);[\s\S]*?buildPipeline\(true\)/, 'native Android listening wakes the STT server before the first utterance');
  assert.doesNotMatch(companion, /'browser-speech'|window\\.SpeechRecognition|webkitSpeechRecognition/);
  assert.match(companion, /transcribe as transcribeAudioBlob.*from '\.\/stt\.js'/);
  assert.match(companion, /preferredRecorderOptions/);
  assert.match(companion, /blob\.size < 300/, 'short wake phrases must not be discarded by a high byte threshold');
  assert.match(companion, /Gemini → OpenAI fallback/);
});

test('Voice companion module parses as valid JavaScript before runtime', () => {
  const result = spawnSync(process.execPath, ['--check', path.join(root, 'public/js/voice/companion.js')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout || 'companion.js failed syntax validation');
});

test('Voice command HTTP helper passes cancellation through and returns server replies', async () => {
  const controller = new AbortController();
  let receivedSignal;
  const pending = postVoiceCommand({
    fetchImpl: async (_url, options) => {
      receivedSignal = options.signal;
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
    sessionId: 'test-session',
    message: 'test command',
    signal: controller.signal,
  });
  assert.equal(receivedSignal, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });

  const result = await postVoiceCommand({
    fetchImpl: async () => ({ ok: true, json: async () => ({ reply: 'Done' }) }),
    sessionId: 'test-session',
    message: 'test command',
  });
  assert.equal(result.reply, 'Done');
});

test('A completed older voice command cannot resume the current pipeline', () => {
  const companion = read('public/js/voice/companion.js');
  assert.match(companion, /const commandPipeline = pipeline/);
  assert.match(companion, /if \(commandGeneration === voiceSessionGeneration\) \{\s*if \(reply\) await speakReply\(reply\);\s*if \(commandGeneration === voiceSessionGeneration\) commandPipeline\?\.done\(\);\s*\}/);
  assert.doesNotMatch(companion, /finally \{[^}]*pipeline\?\.done\(\)/);
});

test('An aborted STT request cancels the underlying fetch and is not retried', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  let requestSignal;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    requestSignal = options.signal;
    return await new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  try {
    const pending = transcribe(new Blob(['test audio'], { type: 'audio/wav' }), () => {}, 'auto', { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(requestSignal, 'STT must pass an AbortSignal to fetch');
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(requestSignal.aborted, true);
    assert.equal(calls, 1, 'cancelled audio must not be retried');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Stopping the live session aborts server STT requests for browser and native audio', () => {
  const stt = read('public/js/voice/stt.js');
  const companion = read('public/js/voice/companion.js');
  assert.match(stt, /export async function transcribe\(blob, onStatus = \(\) => \{\}, language = 'auto', \{ signal \} = \{\}\)/);
  assert.match(stt, /signal: controller\.signal/);
  assert.match(stt, /externalSignal\?\.addEventListener\('abort', forwardAbort/);
  assert.match(companion, /activeSttControllers\.add\(controller\)/);
  assert.match(companion, /for \(const controller of activeSttControllers\) controller\.abort\(\)/);
  assert.match(companion, /transcribeNativeAudio\([\s\S]*?\{ signal: controller\.signal \}\)/);
});

test('Voice transcription discards segments and results from an earlier session', () => {
  const companion = read('public/js/voice/companion.js');
  assert.match(companion, /sessionGeneration !== voiceSessionGeneration/);
  assert.match(companion, /transcribeCapturedChunks\(chunks, type, recorderSessionGeneration\)/);
  const android = read('android-companion/app/src/main/java/com/xoft/companion/LiveActivity.kt');
  assert.match(android, /audioCaptureWanted && active && segment\.size\(\)/);
});

test('Stopping or restarting the live voice session invalidates old replies and aborts the active request', () => {
  const companion = read('public/js/voice/companion.js');
  assert.match(companion, /activeChatRequestController\?\.abort\(\)/);
  assert.match(companion, /if \(commandGeneration === voiceSessionGeneration\) \{\s*if \(reply\) await speakReply\(reply\);\s*if \(commandGeneration === voiceSessionGeneration\) commandPipeline\?\.done\(\);\s*\}/);
  assert.match(companion, /async function start\(\) \{\s*voiceSessionGeneration \+= 1;/);
  assert.match(companion, /function stop\(\) \{\s*voiceSessionGeneration \+= 1;/);
});

test('Speech output prefers native Android TTS, then server TTS, and never uses browser synthesis', () => {
  const tts = read('public/js/voice/speak-out.js');
  assert.match(tts, /\/api\/voice\/speak/);
  assert.doesNotMatch(tts, /speechSynthesis|browserSpeak|SpeechSynthesisUtterance/);
  assert.match(tts, /serverSpeak\(spoken, runId\)/);
  assert.match(tts, /waitForNativeSpeech/);
  assert.match(tts, /speakNative/);
  assert.match(tts, /XOFT server voice is unavailable/);
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

test('AUTO LISTEN requires microphone recording and always uses XOFT server transcription', () => {
  const input = read('public/js/dashboard/CommandInput.js');
  const listen = read('public/js/voice/listen.js');
  assert.match(input, /const canRecord = Boolean\(navigator\.mediaDevices\?\.getUserMedia && window\.MediaRecorder\)/);
  assert.doesNotMatch(input, /SpeechRecognition|webkitSpeechRecognition|new Recognition/);
  assert.match(input, /if \(!canRecord\)/);

  assert.doesNotMatch(input, /local Whisper|on-device Whisper|WHISPER AUTO LISTEN/);
  assert.match(input, /createServerListener/);
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
