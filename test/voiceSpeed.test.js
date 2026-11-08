import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/index.js';
import { VoiceService } from '../src/voice/VoiceService.js';
import { fastClassify, ExecutiveAction, ExecutiveClassifier } from '../src/executive/ExecutiveClassifier.js';
import { splitForSpeech } from '../public/js/voice/speak-out.js';

function withVoiceConfig({ hedgeMs = 1000 } = {}) {
  const prev = {
    openai: config.providers.openai.apiKey,
    gemini: config.providers.gemini.apiKey,
    eleven: config.voice.elevenLabsApiKey,
    hedge: config.voice.sttHedgeMs,
  };
  config.providers.openai.apiKey = 'sk-test';
  config.providers.gemini.apiKey = 'g-test';
  config.voice.elevenLabsApiKey = '';
  config.voice.sttHedgeMs = hedgeMs;
  return () => {
    config.providers.openai.apiKey = prev.openai;
    config.providers.gemini.apiKey = prev.gemini;
    config.voice.elevenLabsApiKey = prev.eleven;
    config.voice.sttHedgeMs = prev.hedge;
  };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const geminiOk = (text) => json({ candidates: [{ content: { parts: [{ text }] } }] });

function hangingFetch(init) {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

test('a slow Gemini request is hedged: OpenAI starts in parallel and wins, and the slow request is aborted', async () => {
  const restore = withVoiceConfig({ hedgeMs: 40 });
  try {
    let geminiSignal = null;
    const svc = new VoiceService({
      fetchImpl: async (url, init) => {
        if (String(url).includes('generativelanguage')) { geminiSignal = init.signal; return hangingFetch(init); }
        return json({ text: 'hedged transcript' });
      },
    });
    const started = Date.now();
    const out = await svc.transcribe(Buffer.from('audio'));
    assert.equal(out.text, 'hedged transcript');
    assert.equal(out.provider, 'openai');
    assert.ok(Date.now() - started < 1500, 'must not wait for the provider timeout');
    assert.equal(geminiSignal?.aborted, true, 'the losing request is cancelled');
    assert.ok(typeof out.ms === 'number');
  } finally { restore(); }
});

test('a fast Gemini answer never starts OpenAI (no wasted calls)', async () => {
  const restore = withVoiceConfig({ hedgeMs: 40 });
  try {
    const urls = [];
    const svc = new VoiceService({ fetchImpl: async (url) => { urls.push(String(url)); return geminiOk('quick'); } });
    const out = await svc.transcribe(Buffer.from('audio'));
    assert.equal(out.provider, 'gemini');
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(urls.length, 1);
  } finally { restore(); }
});

test('hedging off (0) keeps providers sequential while allowing a bounded transient retry', async () => {
  const restore = withVoiceConfig({ hedgeMs: 0 });
  try {
    const order = [];
    const svc = new VoiceService({
      fetchImpl: async (url) => {
        order.push(String(url).includes('generativelanguage') ? 'gemini' : 'openai');
        if (String(url).includes('generativelanguage')) return new Response('down', { status: 503 });
        return json({ text: 'fallback text' });
      },
    });
    const out = await svc.transcribe(Buffer.from('audio'));
    assert.deepEqual(order, ['gemini', 'gemini', 'openai']);
    assert.equal(out.provider, 'openai');
  } finally { restore(); }
});

test('Legacy Whisper request (OpenAI fallback) carries the optional language hint', async () => {
  const restore = withVoiceConfig();
  const prev = config.voice.sttLanguage;
  const prevModel = config.voice.sttOpenAiModel;
  config.voice.sttOpenAiModel = 'whisper-1';
  config.voice.sttLanguage = 'en';
  try {
    let form;
    const svc = new VoiceService({
      fetchImpl: async (url, init) => {
        if (String(url).includes('generativelanguage')) return new Response('down', { status: 500 });
        form = init.body;
        return json({ text: 'hi' });
      },
    });
    await svc.transcribe(Buffer.from('audio'));
    assert.equal(form.get('language'), 'en');
    assert.equal(form.get('model'), 'whisper-1');
    assert.equal(form.get('temperature'), '0');
  } finally { config.voice.sttLanguage = prev; config.voice.sttOpenAiModel = prevModel; restore(); }
});

test('streaming TTS resolves with the OpenAI body when Gemini is unavailable', async () => {
  const restore = withVoiceConfig();
  try {
    const svc = new VoiceService({
      fetchImpl: async (u) => (String(u).includes('generativelanguage') ? new Response('no', { status: 500 }) : new Response(Buffer.from('mp3-bytes'), { status: 200 })),
    });
    const { body, contentType, provider } = await svc.textToSpeechStream('hello there');
    assert.equal(contentType, 'audio/mpeg');
    assert.equal(provider, 'openai');
    const chunks = [];
    for await (const c of body) chunks.push(Buffer.from(c));
    assert.equal(Buffer.concat(chunks).toString(), 'mp3-bytes');
  } finally { restore(); }
});

test('plain conversation skips the extra classification model call', async () => {
  let calls = 0;
  const classifier = new ExecutiveClassifier({ complete: async () => { calls += 1; return { text: '{"action":"goal"}' }; } });
  for (const message of ['hello xoft', 'how are you today', 'what is the capital of France', 'tell me a joke', 'good morning xoft']) {
    assert.equal((await classifier.classify(message)).action, ExecutiveAction.DELEGATE, message);
  }
  assert.equal(calls, 0);
});

test('unmistakable confirm, cancel and status phrases are resolved without a model call', async () => {
  assert.equal(fastClassify('do it').action, ExecutiveAction.CONFIRM);
  assert.equal(fastClassify('yes please').action, ExecutiveAction.CONFIRM);
  assert.equal(fastClassify('never mind').action, ExecutiveAction.CANCEL);
  assert.equal(fastClassify('What should I be doing right now?').action, ExecutiveAction.WORLD_STATE);
});

test('tasks, advice and ambiguous acknowledgements are classified with deterministic rules', async () => {
  assert.equal(fastClassify('send an email to John about Friday').action, ExecutiveAction.GOAL);
  assert.equal(fastClassify('schedule a meeting with Ada tomorrow').action, ExecutiveAction.GOAL);
  assert.equal(fastClassify('any ideas for my project?').action, ExecutiveAction.ADVISE);
  assert.equal(fastClassify('how should I structure this?').action, ExecutiveAction.ADVISE);
  for (const message of ['ok', 'sure', 'sounds good', 'okay thanks', 'x'.repeat(300)]) {
    assert.equal(fastClassify(message).action, ExecutiveAction.DELEGATE, message);
  }
  let calls = 0;
  const classifier = new ExecutiveClassifier({ complete: async () => { calls += 1; return { text: '{"action":"goal"}' }; } });
  assert.equal((await classifier.classify('send an email to John')).action, ExecutiveAction.GOAL);
  assert.equal(calls, 0);
});

test('speech is split into short sentence chunks so the first audio starts quickly', () => {
  const text = 'Sure, I can help with that. Here is the plan: first we check the logs, then we restart the service. After that, we verify everything works! Does that sound good to you?';
  const chunks = splitForSpeech(text);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].length <= 140, 'first chunk is short');
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text);
  assert.deepEqual(splitForSpeech('Hi.'), ['Hi.']);
  assert.deepEqual(splitForSpeech('   '), []);
  const long = Array.from({ length: 40 }, (_, i) => 'Sentence number ' + i + ' is here.').join(' ');
  assert.ok(splitForSpeech(long).length <= 8, 'requests per reply are bounded');
});
