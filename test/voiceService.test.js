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

test('STT rejects empty audio before making any provider request', async () => {
  const restore = withKeys();
  try {
    let calls = 0;
    const svc = new VoiceService({ fetchImpl: async () => { calls += 1; return json({ text: 'invented words' }); } });
    await assert.rejects(
      () => svc.transcribe(Buffer.alloc(0)),
      /no audio was recorded; refusing to invent a transcript/
    );
    assert.equal(calls, 0, 'empty audio must not call OpenAI or Gemini');
  } finally { restore(); }
});

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
    assert.match(form.get('prompt'), /code-switching/);
    assert.match(form.get('prompt'), /biko/);
    assert.match(form.get('prompt'), /never inject example words/);
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

test('STT hard-fails over to Gemini after the hedge delay even if OpenAI could return later', async () => {
  const restore = withKeys();
  const previousHedgeMs = config.voice.sttHedgeMs;
  config.voice.sttHedgeMs = 25;
  try {
    let openaiSignal;
    const called = [];
    const svc = new VoiceService({
      fetchImpl: (url, init) => {
        const target = String(url);
        called.push(target);
        if (target.includes('openai.com')) {
          openaiSignal = init.signal;
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(json({ text: 'late OpenAI transcript' })), 60);
            init.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('OpenAI request aborted at failover cutoff'));
            }, { once: true });
          });
        }
        return new Promise((resolve) => setTimeout(
          () => resolve(json({ candidates: [{ content: { parts: [{ text: 'Gemini transcript' }] } }] })),
          70
        ));
      },
    });

    const started = Date.now();
    const out = await svc.transcribe(Buffer.from('audio'));
    const elapsed = Date.now() - started;
    assert.equal(out.provider, 'gemini');
    assert.equal(out.text, 'Gemini transcript');
    assert.ok(elapsed >= 75, `Gemini should take over after the configured cutoff; elapsed ${elapsed}ms`);
    assert.ok(called.some((url) => url.includes('openai.com')));
    assert.ok(called.some((url) => url.includes('generativelanguage.googleapis.com')));
    assert.equal(openaiSignal.aborted, true, 'abort OpenAI at the cutoff instead of allowing a late result to win');
  } finally {
    config.voice.sttHedgeMs = previousHedgeMs;
    restore();
  }
});

test('STT falls back immediately to Gemini when OpenAI is unreachable', async () => {
  const restore = withKeys();
  try {
    const started = Date.now();
    const svc = new VoiceService({
      fetchImpl: async (url) => {
        if (String(url).includes('openai.com')) throw new TypeError('fetch failed: network unreachable');
        return json({ candidates: [{ content: { parts: [{ text: 'Network fallback transcript' }] } }] });
      },
    });
    const out = await svc.transcribe(Buffer.from('audio'));
    assert.equal(out.provider, 'gemini');
    assert.equal(out.text, 'Network fallback transcript');
    assert.ok(Date.now() - started < 500, 'a definite network failure should not wait for the hedge timer');
    assert.equal(out.attempts[0].ok, false);
    assert.match(out.attempts[0].error, /network unreachable/);
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
    assert.equal(s.stt.hedgeMs, config.voice.sttHedgeMs);
  } finally { restore(); }
});
