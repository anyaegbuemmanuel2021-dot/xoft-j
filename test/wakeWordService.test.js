import test from 'node:test';
import assert from 'node:assert/strict';
import { WakeWordService } from '../src/voice/WakeWordService.js';

function silencePcm(ms, sampleRate = 16000) {
  const samples = Math.round((sampleRate * ms) / 1000);
  return Buffer.alloc(samples * 2, 0);
}

function tonePcm(ms, amplitude, sampleRate = 16000) {
  const samples = Math.round((sampleRate * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    // Square wave at max/half amplitude — simple, real, deterministic energy, not a sine approximation.
    const v = i % 2 === 0 ? amplitude : -amplitude;
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}

test('detectVoiceActivity reports no speech on true silence', () => {
  const wws = new WakeWordService();
  const { anySpeech, frames } = wws.detectVoiceActivity(silencePcm(300));
  assert.equal(anySpeech, false);
  assert.ok(frames.length > 0);
  assert.ok(frames.every((f) => f.speech === false));
});

test('detectVoiceActivity reports speech on a loud tone above threshold', () => {
  const wws = new WakeWordService();
  const { anySpeech, frames } = wws.detectVoiceActivity(tonePcm(300, 20000), { energyThreshold: 0.1 });
  assert.equal(anySpeech, true);
  assert.ok(frames.some((f) => f.speech === true));
});

test('detectVoiceActivity distinguishes a quiet tone from a loud one via the threshold', () => {
  const wws = new WakeWordService();
  const quiet = wws.detectVoiceActivity(tonePcm(300, 200), { energyThreshold: 0.1 });
  const loud = wws.detectVoiceActivity(tonePcm(300, 20000), { energyThreshold: 0.1 });
  assert.equal(quiet.anySpeech, false);
  assert.equal(loud.anySpeech, true);
});

test('detectVoiceActivity handles an empty/tiny buffer without throwing', () => {
  const wws = new WakeWordService();
  assert.deepEqual(wws.detectVoiceActivity(Buffer.alloc(0)), { frames: [], anySpeech: false });
});

test('matchWakePhrase matches an exact configured phrase inside a longer transcript', () => {
  const wws = new WakeWordService({ wakePhrases: ['hey xoft'] });
  const result = wws.matchWakePhrase('okay so hey xoft can you check my calendar');
  assert.equal(result.matched, true);
  assert.equal(result.phrase, 'hey xoft');
  assert.equal(result.editDistance, 0);
});

test('matchWakePhrase fuzzy-matches a short near-miss utterance within edit distance', () => {
  const wws = new WakeWordService({ wakePhrases: ['hey xoft'] });
  const result = wws.matchWakePhrase('hey xof'); // one character short
  assert.equal(result.matched, true);
  assert.equal(result.phrase, 'hey xoft');
});

test('matchWakePhrase does not match unrelated speech', () => {
  const wws = new WakeWordService({ wakePhrases: ['hey xoft'] });
  const result = wws.matchWakePhrase('what is the weather like today in Awka');
  assert.equal(result.matched, false);
  assert.equal(result.phrase, null);
});

test('matchWakePhrase handles empty transcript', () => {
  const wws = new WakeWordService();
  assert.deepEqual(wws.matchWakePhrase(''), { matched: false, phrase: null, editDistance: null });
});
