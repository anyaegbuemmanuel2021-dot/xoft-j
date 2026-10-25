import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/index.js';
import { VoiceService } from '../src/voice/VoiceService.js';

function withKeys({ openai = 'sk-test', gemini = 'g-test', eleven = 'el-test', order } = {}) {
  const prev = {
    openai: config.providers.openai.apiKey,
    gemini: config.providers.gemini.apiKey,
    eleven: config.voice.elevenLabsApiKey,
    order: config.voice.sttProviderOrder,
  };
  config.providers.openai.apiKey = openai;
  config.providers.gemini.apiKey = gemini;
  config.voice.elevenLabsApiKey = eleven;
  if (order) config.voice.sttProviderOrder = order;
  return () => {
    config.providers.openai.apiKey = prev.openai;
    config.providers.gemini.apiKey = prev.gemini;
    config.voice.elevenLabsApiKey = prev.eleven;
    config.voice.sttProviderOrder = prev.order;
  };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('STT defaults to gpt-transcribe with Nigerian multilingual context and automatic language detection', async () => {
  const restore = withKeys();
  try {
    const calls = [];
    const svc = new VoiceService({ fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return json({ text: ' hello xoft ' }); } });
    const out = await svc.transcribe(Buffer.from('audio'), { filename: 'a.webm', mime: 'audio/webm' });
    assert.equal(out.text, 'hello xoft');
    assert.equal(out.provider, 'openai');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /api\.openai\.com\/v1\/audio\/transcriptions/);
    const form = calls[0].init.body;
    assert.equal(form.get('model'), 'gpt-transcribe');
    assert.match(form.get('prompt'), /Nigerian English/);
    assert.match(form.get('prompt'), /Igbo/);
    assert.match(form.get('prompt'), /XOFT/);
    assert.equal(form.has('language'), false, 'language should remain auto-detected by default');
    assert.equal(form.has('temperature'), false, 'do not send Whisper-only temperature to the modern model');
  } finally { restore(); }
});

test('STT falls back to Gemini when OpenAI fails and sends multilingual context', async () => {
  const restore = withKeys();
  try {
    const urls = [];
    let geminiRequest;
    const svc = new VoiceService({
      fetchImpl: async (url, init) => {
        urls.push(String(url));
        if (String(url).includes('openai.com')) return new Response('quota', { status: 429 });
        geminiRequest = JSON.parse(init.body);
        return json({ candidates: [{ content: { parts: [{ text: 'from gemini' }] } }] });
      },
    });
    const out = await svc.transcribe(Buffer.from('audio'), { mime: 'audio/ogg' });
    assert.equal(out.provider, 'gemini');
    assert.equal(out.text, 'from gemini');
    assert.deepEqual(out.attempts.map((a) => [a.provider, a.ok]), [['openai', false], ['gemini', true]]);
    assert.match(urls[1], /generativelanguage\.googleapis\.com/);
    assert.match(geminiRequest.contents[0].parts[0].text, /Igbo/);
    assert.match(geminiRequest.contents[0].parts[0].text, /XOFT/);
  } finally { restore(); }
});

test('STT falls through on an empty transcript and reports every attempt when all providers fail', async () => {
  const restore = withKeys();
  try {
    const svc = new VoiceService({ fetchImpl: async () => json({ text: '', candidates: [] }) });
    await assert.rejects(() => svc.transcribe(Buffer.from('x')), (err) => {
      assert.equal(err.attempts.length, 2);
      assert.match(err.message, /openai: empty transcript/);
      return true;
    });
  } finally { restore(); }
});

test('STT order is configurable and only providers with keys are used', async () => {
  let restore = withKeys({ gemini: null });
  try {
    assert.deepEqual(new VoiceService().sttProviders(), ['openai']);
  } finally { restore(); }
  restore = withKeys({ order: ['gemini', 'openai'] });
  try {
    assert.deepEqual(new VoiceService().sttProviders(), ['gemini', 'openai']);
  } finally { restore(); }
  restore = withKeys({ openai: null, gemini: null });
  try {
    assert.equal(new VoiceService().isSTTConfigured(), false);
    await assert.rejects(() => new VoiceService().transcribe(Buffer.from('x')), /no speech-to-text provider/);
  } finally { restore(); }
});

test('TTS uses ElevenLabs, trims input, and surfaces API errors', async () => {
  const restore = withKeys();
  try {
    let seen;
    const ok = new VoiceService({ fetchImpl: async (url, init) => { seen = { url: String(url), body: JSON.parse(init.body), headers: init.headers }; return new Response(Buffer.from('mp3'), { status: 200 }); } });
    const audio = await ok.textToSpeech('  hi there  ');
    assert.equal(audio.toString(), 'mp3');
    assert.match(seen.url, /api\.elevenlabs\.io\/v1\/text-to-speech\//);
    assert.equal(seen.body.text, 'hi there');
    assert.equal(seen.headers['xi-api-key'], 'el-test');
    await assert.rejects(() => ok.textToSpeech('   '), /empty/);
    const bad = new VoiceService({ fetchImpl: async () => new Response('nope', { status: 401 }) });
    await assert.rejects(() => bad.textToSpeech('x'), /ElevenLabs API error 401/);
  } finally { restore(); }
});

test('status() reports STT providers and ElevenLabs TTS with browser fallback', () => {
  const restore = withKeys();
  try {
    const s = new VoiceService().status();
    assert.deepEqual(s.stt.providers, ['openai', 'gemini']);
    assert.equal(s.tts.provider, 'elevenlabs');
    assert.equal(s.tts.fallback, 'browser');
  } finally { restore(); }
});