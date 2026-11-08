import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/index.js';
import { VoiceService, pcm16ToWav } from '../src/voice/VoiceService.js';

function withKeys({ openai = 'sk-test', gemini = 'g-test', eleven = 'el-test', ttsOrder, hedge, ttsHedge } = {}) {
  const prev = {
    openai: config.providers.openai.apiKey,
    gemini: config.providers.gemini.apiKey,
    eleven: config.voice.elevenLabsApiKey,
    ttsOrder: config.voice.ttsProviderOrder,
    hedge: config.voice.sttHedgeMs,
    ttsHedge: config.voice.ttsHedgeMs,
  };
  config.providers.openai.apiKey = openai;
  config.providers.gemini.apiKey = gemini;
  config.voice.elevenLabsApiKey = eleven;
  if (ttsOrder) config.voice.ttsProviderOrder = ttsOrder;
  if (hedge !== undefined) config.voice.sttHedgeMs = hedge;
  if (ttsHedge !== undefined) config.voice.ttsHedgeMs = ttsHedge;
  return () => {
    config.providers.openai.apiKey = prev.openai;
    config.providers.gemini.apiKey = prev.gemini;
    config.voice.elevenLabsApiKey = prev.eleven;
    config.voice.ttsProviderOrder = prev.ttsOrder;
    config.voice.sttHedgeMs = prev.hedge;
    config.voice.ttsHedgeMs = prev.ttsHedge;
  };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const geminiText = (text) => json({ candidates: [{ content: { parts: [{ text }] } }] });
const geminiAudio = (bytes = Buffer.from([1, 0, 2, 0, 3, 0])) => json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: bytes.toString('base64') } }] } }] });
const isOpenAI = (url) => String(url).includes('api.openai.com');
const isGemini = (url) => String(url).includes('generativelanguage.googleapis.com');
const hangingFetch = (init) => new Promise((_resolve, reject) => {
  init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});

test('STT rejects empty audio before making any provider request', async () => {
  const restore = withKeys();
  try {
    let calls = 0;
    const svc = new VoiceService({ fetchImpl: async () => { calls += 1; return json({ text: 'invented words' }); } });
    await assert.rejects(() => svc.transcribe(Buffer.alloc(0)), /no audio was recorded; refusing to invent a transcript/);
    assert.equal(calls, 0, 'empty audio must not call Gemini or OpenAI');
  } finally { restore(); }
});

test('STT uses Gemini first with Nigerian multilingual context and automatic language detection', async () => {
  const restore = withKeys();
  try {
    const calls = [];
    const svc = new VoiceService({ fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return geminiText(' hello xoft '); } });
    const out = await svc.transcribe(Buffer.from('audio'), { filename: 'a.webm', mime: 'audio/webm' });
    assert.equal(out.text, 'hello xoft');
    assert.equal(out.provider, 'gemini');
    assert.equal(calls.length, 1, 'a fast primary answer never starts the fallback');
    assert.match(calls[0].url, /generativelanguage\.googleapis\.com/);
    const prompt = JSON.parse(calls[0].init.body).contents[0].parts[0].text;
    for (const word of ['Nigerian English', 'Nigerian Pidgin', 'Igbo', 'code-switching', 'biko', 'never inject example words', 'XOFT']) assert.match(prompt, new RegExp(word));
    assert.match(prompt, /Automatically detect the language/);
  } finally { restore(); }
});

test('STT honors explicit Igbo language selection (Gemini and OpenAI)', async () => {
  let restore = withKeys();
  try {
    let body;
    const svc = new VoiceService({ fetchImpl: async (_u, init) => { body = JSON.parse(init.body); return geminiText('Kedu?'); } });
    const out = await svc.transcribe(Buffer.from('audio'), { language: 'ig' });
    assert.equal(out.text, 'Kedu?');
    assert.match(body.contents[0].parts[0].text, /selected Igbo/);
  } finally { restore(); }
  restore = withKeys({ gemini: null });
  try {
    let form;
    const svc = new VoiceService({ fetchImpl: async (_u, init) => { form = init.body; return json({ text: 'Kedu?' }); } });
    const out = await svc.transcribe(Buffer.from('audio'), { language: 'ig' });
    assert.equal(out.provider, 'openai');
    assert.equal(form.get('language'), 'ig');
    assert.equal(form.get('model'), 'gpt-4o-mini-transcribe');
    assert.equal(form.has('temperature'), false);
    assert.match(form.get('prompt'), /Nigerian Pidgin/);
  } finally { restore(); }
});

test('STT normalizes recorder MIME parameters before sending audio to Gemini', async () => {
  const restore = withKeys();
  try {
    let requestBody;
    const svc = new VoiceService({ fetchImpl: async (_url, init) => { requestBody = JSON.parse(init.body); return geminiText('normalized mime'); } });
    const out = await svc.transcribe(Buffer.from('audio'), { mime: 'audio/mp4;codecs=mp4a.40.2' });
    assert.equal(out.text, 'normalized mime');
    assert.equal(requestBody.contents[0].parts[1].inline_data.mime_type, 'audio/mp4');
  } finally { restore(); }
});

test('STT does not retry OpenAI insufficient_quota 429 and preserves the actionable reason', async () => {
  const restore = withKeys({ gemini: null });
  try {
    let calls = 0;
    const svc = new VoiceService({
      fetchImpl: async () => {
        calls += 1;
        return json({ error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }, 429);
      },
    });
    await assert.rejects(() => svc.transcribe(Buffer.from('audio')), (error) => {
      assert.match(error.message, /insufficient_quota/);
      assert.match(error.message, /exceeded your current quota/);
      assert.equal(error.attempts[0].provider, 'openai');
      return true;
    });
    assert.equal(calls, 1, 'billing/quota failures must not be retried');
  } finally { restore(); }
});

test('STT falls back to OpenAI immediately when Gemini fails', async () => {
  const restore = withKeys();
  try {
    const started = Date.now();
    const svc = new VoiceService({
      fetchImpl: async (url, init) => {
        if (isGemini(url)) return new Response('quota', { status: 429 });
        const upload = init.body.get('file');
        assert.equal(upload.type, 'audio/ogg', 'OpenAI fallback must receive the recorder MIME type');
        assert.equal(upload.name, 'audio.ogg', 'the filename extension matches the recorder format');
        return json({ text: 'from openai' });
      },
    });
    const out = await svc.transcribe(Buffer.from('audio'), { filename: 'audio.ogg', mime: 'audio/ogg' });
    assert.equal(out.provider, 'openai');
    assert.equal(out.text, 'from openai');
    assert.deepEqual(out.attempts.map((a) => [a.provider, a.ok]), [['gemini', false], ['openai', true]]);
    assert.ok(Date.now() - started < 500, 'a definite failure must not wait for the hedge timer');
  } finally { restore(); }
});

test('STT falls back immediately to OpenAI when Gemini is unreachable', async () => {
  const restore = withKeys();
  try {
    const svc = new VoiceService({
      fetchImpl: async (url) => {
        if (isGemini(url)) throw new TypeError('fetch failed: network unreachable');
        return json({ text: 'Network fallback transcript' });
      },
    });
    const out = await svc.transcribe(Buffer.from('audio'));
    assert.equal(out.provider, 'openai');
    assert.match(out.attempts[0].error, /network unreachable/);
  } finally { restore(); }
});

test('STT hedges a slow Gemini: OpenAI starts in parallel after the cutoff, wins, and Gemini is cancelled', async () => {
  const restore = withKeys({ hedge: 30 });
  try {
    let geminiSignal;
    const svc = new VoiceService({
      fetchImpl: (url, init) => {
        if (isGemini(url)) { geminiSignal = init.signal; return hangingFetch(init); }
        return Promise.resolve(json({ text: 'hedged transcript' }));
      },
    });
    const started = Date.now();
    const out = await svc.transcribe(Buffer.from('audio'));
    assert.equal(out.provider, 'openai');
    assert.equal(out.text, 'hedged transcript');
    assert.ok(Date.now() - started < 1000, 'must not wait for the provider timeout');
    assert.equal(geminiSignal.aborted, true, 'the losing request is cancelled');
  } finally { restore(); }
});

test('STT hedge is a true race: a slow Gemini that answers before OpenAI still wins', async () => {
  const restore = withKeys({ hedge: 20 });
  try {
    const svc = new VoiceService({
      fetchImpl: (url) => new Promise((resolve) => setTimeout(
        () => resolve(isGemini(url) ? geminiText('gemini won') : json({ text: 'openai won' })),
        isGemini(url) ? 50 : 200
      )),
    });
    const out = await svc.transcribe(Buffer.from('audio'));
    assert.equal(out.provider, 'gemini');
    assert.equal(out.text, 'gemini won');
  } finally { restore(); }
});

test('STT falls through on an empty transcript and reports every attempt when all providers fail', async () => {
  const restore = withKeys();
  try {
    const svc = new VoiceService({ fetchImpl: async () => json({ text: '', candidates: [] }) });
    await assert.rejects(() => svc.transcribe(Buffer.from('x')), (err) => {
      assert.equal(err.attempts.length, 2);
      assert.deepEqual(err.attempts.map((a) => a.provider), ['gemini', 'openai']);
      assert.match(err.message, /gemini: empty result/);
      return true;
    });
  } finally { restore(); }
});

test('STT order is fixed Gemini → OpenAI and only providers with keys are used', async () => {
  let restore = withKeys({ gemini: null });
  try { assert.deepEqual(new VoiceService().sttProviders(), ['openai']); } finally { restore(); }
  restore = withKeys({ openai: null });
  try { assert.deepEqual(new VoiceService().sttProviders(), ['gemini']); } finally { restore(); }
  restore = withKeys();
  try {
    assert.deepEqual(new VoiceService().sttProviders(), ['gemini', 'openai']);
    assert.deepEqual(config.voice.sttProviderOrder, ['gemini', 'openai']);
  } finally { restore(); }
  restore = withKeys({ openai: null, gemini: null });
  try {
    assert.equal(new VoiceService().isSTTConfigured(), false);
    await assert.rejects(() => new VoiceService().transcribe(Buffer.from('x')), /no speech-to-text provider/);
  } finally { restore(); }
});

test('TTS uses Gemini first, trims input, and returns a playable WAV', async () => {
  const restore = withKeys();
  try {
    let seen;
    const svc = new VoiceService({ fetchImpl: async (url, init) => { seen = { url: String(url), body: JSON.parse(init.body), headers: init.headers }; return geminiAudio(); } });
    const out = await svc.synthesize('  hi there  ');
    assert.equal(out.provider, 'gemini');
    assert.equal(out.contentType, 'audio/wav');
    assert.match(seen.url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash-preview-tts:generateContent/);
    assert.equal(seen.body.contents[0].parts[0].text, 'hi there');
    assert.deepEqual(seen.body.generationConfig.responseModalities, ['AUDIO']);
    assert.equal(seen.body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
    assert.equal(seen.headers['x-goog-api-key'], 'g-test');
    assert.equal(out.buffer.subarray(0, 4).toString(), 'RIFF');
    assert.equal(out.buffer.subarray(8, 12).toString(), 'WAVE');
    assert.equal(out.buffer.readUInt32LE(24), 24000);
    assert.equal(out.buffer.length, 44 + 6);
    await assert.rejects(() => svc.synthesize('   '), /empty/);
  } finally { restore(); }
});

test('TTS falls back to OpenAI speech when Gemini fails', async () => {
  const restore = withKeys();
  try {
    let openaiBody;
    const svc = new VoiceService({
      fetchImpl: async (url, init) => {
        if (isGemini(url)) return new Response('boom', { status: 500 });
        openaiBody = JSON.parse(init.body);
        assert.equal(init.headers.Authorization, 'Bearer sk-test');
        return new Response(Buffer.from('mp3-bytes'), { status: 200 });
      },
    });
    const out = await svc.textToSpeechStream('hello there');
    assert.equal(out.provider, 'openai');
    assert.equal(out.contentType, 'audio/mpeg');
    assert.equal(openaiBody.input, 'hello there');
    assert.equal(openaiBody.response_format, 'mp3');
    assert.deepEqual(out.attempts.map((a) => [a.provider, a.ok]), [['gemini', false], ['openai', true]]);
    const chunks = [];
    for await (const c of out.body) chunks.push(Buffer.from(c));
    assert.equal(Buffer.concat(chunks).toString(), 'mp3-bytes');
    assert.equal((await svc.textToSpeech('again')).toString(), 'mp3-bytes');
  } finally { restore(); }
});

test('TTS hedges a slow Gemini with OpenAI and cancels the loser', async () => {
  const restore = withKeys({ ttsHedge: 25 });
  try {
    let geminiSignal;
    const svc = new VoiceService({
      fetchImpl: (url, init) => {
        if (isGemini(url)) { geminiSignal = init.signal; return hangingFetch(init); }
        return Promise.resolve(new Response(Buffer.from('fast'), { status: 200 }));
      },
    });
    const out = await svc.synthesize('hello');
    assert.equal(out.provider, 'openai');
    assert.equal(geminiSignal.aborted, true);
  } finally { restore(); }
});

test('TTS: optional ElevenLabs is last, the order is configurable, and all-fail reports every attempt', async () => {
  let restore = withKeys();
  try {
    assert.deepEqual(new VoiceService().ttsProviders(), ['gemini', 'openai', 'elevenlabs']);
    const urls = [];
    const svc = new VoiceService({
      fetchImpl: async (url) => {
        urls.push(String(url));
        if (String(url).includes('elevenlabs.io')) return new Response(Buffer.from('el'), { status: 200 });
        return new Response('down', { status: 503 });
      },
    });
    const out = await svc.synthesize('x');
    assert.equal(out.provider, 'elevenlabs');
    assert.equal(urls.length, 3);
    await assert.rejects(() => new VoiceService({ fetchImpl: async () => new Response('no', { status: 401 }) }).synthesize('x'), (err) => {
      assert.equal(err.attempts.length, 3);
      assert.match(err.message, /gemini: Gemini speech error 401/);
      assert.match(err.message, /openai: OpenAI speech error 401/);
      return true;
    });
  } finally { restore(); }
  restore = withKeys({ eleven: null, ttsOrder: ['openai', 'gemini'] });
  try { assert.deepEqual(new VoiceService().ttsProviders(), ['openai', 'gemini']); } finally { restore(); }
  restore = withKeys({ openai: null, gemini: null, eleven: null });
  try {
    assert.equal(new VoiceService().isTTSConfigured(), false);
    await assert.rejects(() => new VoiceService().synthesize('x'), /no text-to-speech provider/);
  } finally { restore(); }
});

test('Gemini raw PCM is wrapped as 16-bit mono WAV at the reported sample rate', () => {
  const wav = pcm16ToWav(Buffer.alloc(4800), 24000);
  assert.equal(wav.length, 4844);
  assert.equal(wav.readUInt32LE(4), 36 + 4800);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(28), 48000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 4800);
});

test('STT production policy: Gemini first, short hedge cutoff', () => {
  assert.deepEqual(config.voice.sttProviderOrder, ['gemini', 'openai']);
  assert.ok(config.voice.sttHedgeMs > 0 && config.voice.sttHedgeMs <= 1000);
  assert.ok(config.voice.ttsHedgeMs > 0 && config.voice.ttsHedgeMs <= 1500);
});

test('status() reports Gemini → OpenAI for STT and TTS with browser fallback', () => {
  const restore = withKeys();
  try {
    const s = new VoiceService().status();
    assert.deepEqual(s.stt.providers, ['gemini', 'openai']);
    assert.equal(s.stt.default, 'gemini');
    assert.equal(s.stt.fallback, 'openai');
    assert.equal(s.tts.provider, 'gemini');
    assert.deepEqual(s.tts.providers, ['gemini', 'openai', 'elevenlabs']);
    assert.equal(s.tts.configured, true);
    assert.equal(s.tts.fallback, 'browser');
  } finally { restore(); }
});
