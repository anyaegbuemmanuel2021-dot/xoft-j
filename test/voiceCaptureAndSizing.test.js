import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechGate } from '../public/js/voice/listen.js';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

test('hands-free capture does not learn the opening spoken words as background noise', () => {
  const realNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    const gate = createSpeechGate({ minThreshold: 0.005, floorMultiplier: 2.5 });
    for (let i = 0; i < 12; i += 1) {
      now = i * 55;
      gate.update(0.02);
    }
    now = 700;
    assert.equal(gate.update(0.02), true, 'speech must remain detectable after the initial calibration window');
    assert.ok(gate.threshold <= 0.005, 'the threshold must not rise to the speaker\'s own voice level');
  } finally {
    Date.now = realNow;
  }
});

test('transcription uses XOFT server directly and does not download browser-local Whisper', () => {
  const stt = read('../public/js/voice/stt.js');
  assert.ok(stt.includes('/api/voice/transcribe'));
  assert.ok(!stt.includes('whisper-fallback'));
  assert.ok(!stt.includes('getVoiceStatus'));
  assert.ok(!stt.includes('on-device Whisper'));
});

test('voice controls describe the XOFT server rather than claiming to record with Whisper', () => {
  const chat = read('../public/js/views/chat.js');
  assert.ok(!chat.includes('Recording for Whisper'));
  assert.ok(!chat.includes('Transcribing with Whisper'));
  assert.ok(chat.includes('Sending audio to XOFT'));
});

test('chat and Command Center composers override the global oversized textarea height', () => {
  const appCss = read('../public/css/app.css');
  const commandCss = read('../public/css/command-center.css');
  const chatRule = appCss.slice(appCss.lastIndexOf('body[data-route="chat"] #content .chat-voice-home #chat-input-row textarea'));
  const commandRule = commandCss.slice(commandCss.lastIndexOf('body[data-route="command"] #content .cc-home-core .cc-cmd textarea'));
  assert.ok(chatRule.includes('min-height: 40px !important'), 'chat composer must override the global 88px textarea');
  assert.ok(commandRule.includes('min-height: 42px !important'), 'command composer must override the global 88px textarea');
});
