import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyVad, rmsOf } from '../public/js/voice/vad.js';
import { matchWake, VoicePipeline } from '../public/js/voice/wake.js';

const feed = (vad, frames, t0 = 0, step = 30) => frames.map((r, i) => vad.process(r, t0 + i * step));

describe('EnergyVad', () => {
  test('rmsOf computes real RMS', () => { assert.equal(rmsOf([]), 0); assert.ok(Math.abs(rmsOf([0.5, -0.5, 0.5, -0.5]) - 0.5) < 1e-9); });
  test('silence never triggers; a sustained loud burst starts then ends after the silence window', () => {
    const v = new EnergyVad({ endSilenceMs: 300 });
    assert.ok(feed(v, Array(20).fill(0.001)).every((r) => !r.speaking));
    const speech = feed(v, Array(10).fill(0.2), 1000);
    assert.equal(speech.filter((r) => r.event === 'start').length, 1);
    assert.equal(speech[2].event, 'start'); assert.equal(speech[1].event, null); // needs startFrames=3 consecutive frames
    const tail = feed(v, Array(20).fill(0.001), 1300);
    assert.equal(tail.filter((r) => r.event === 'end').length, 1);
    assert.equal(v.speaking, false);
  });
  test('a single click/pop does not start speech', () => { const v = new EnergyVad(); assert.ok(feed(v, [0.001, 0.5, 0.001, 0.001, 0.001]).every((r) => r.event !== 'start')); });
  test('short pauses inside an utterance do not end it', () => {
    const v = new EnergyVad({ endSilenceMs: 700 });
    const r = feed(v, [0.2, 0.2, 0.2, 0.001, 0.001, 0.001, 0.2, 0.2], 0);
    assert.equal(r.filter((x) => x.event === 'end').length, 0); assert.equal(v.speaking, true);
  });
  test('noise floor adapts to ambient hum while silent, but not during speech', () => {
    const v = new EnergyVad(); const before = v.threshold;
    feed(v, Array(200).fill(0.01)); assert.ok(v.noiseFloor > 0.008);
    const floorBefore = v.noiseFloor; feed(v, Array(30).fill(0.3), 10000); assert.equal(v.noiseFloor, floorBefore);
    assert.ok(v.threshold >= before);
  });
});

describe('matchWake', () => {
  const ok = (t, cmd) => { const m = matchWake(t); assert.equal(m.matched, true, t); assert.equal(m.command, cmd, t); };
  test('extracts the command after the wake phrase', () => { ok('Hey Xoft, open Chrome.', 'open Chrome'); ok('ok xoft find the SocialPulse project', 'find the SocialPulse project'); ok('hey xoft', ''); ok('hey xoft open browser.js', 'open browser.js'); ok('Hey Xoft, restore C:/Projects/app.js!', 'restore C:/Projects/app.js'); });
  test('tolerates common mis-hearings of the name', () => { ok('hey soft open chrome', 'open chrome'); ok('hey zoft check the build', 'check the build'); ok('okay xoff undo what you just changed', 'undo what you just changed'); });
  test('ordinary conversation does not trigger, including the bare name and the word "soft"', () => {
    for (const t of ['this pillow is really soft', 'xoft is a cool project', 'hey there how are you', 'soft launch tomorrow', 'I said hey to the software team', 'open chrome']) assert.equal(matchWake(t).matched, false, t);
  });
  test('bare name only when explicitly allowed', () => assert.equal(matchWake('xoft open chrome', { allowBareName: true }).matched, true));
  test('a wake phrase deep in a long sentence is ignored', () => assert.equal(matchWake('yesterday my friend told me she said hey xoft to it').matched, false));
});

describe('VoicePipeline', () => {
  const mk = (o = {}) => {
    const log = { commands: [], wakes: [], recog: [], states: [], confirms: [], cancels: [], timeouts: [] };
    const p = new VoicePipeline({ onCommand: (c) => log.commands.push(c), onWake: (w) => log.wakes.push(w), wantRecognizer: (b) => log.recog.push(b), onState: (s) => log.states.push(s), onNeedConfirm: (c) => log.confirms.push(c), onCancel: (r) => log.cancels.push(r), onTimeout: () => log.timeouts.push(1), ...o });
    return { p, log };
  };
  test('single-utterance flow: speech → wake+command → submitted as a voice-source command, recognizer closed', () => {
    const { p, log } = mk();
    p.vad('start'); assert.deepEqual(log.recog, [true]);
    p.transcript('hey xoft open chrome', false); assert.equal(log.commands.length, 0); // interim never submits
    p.transcript('hey xoft open chrome', true);
    assert.deepEqual(log.commands, [{ text: 'open chrome', source: 'voice' }]); assert.equal(p.state, 'submitting'); assert.equal(log.recog.at(-1), false);
    p.transcript('hey xoft delete everything', true); assert.equal(log.commands.length, 1); // ignored while a command is in flight (no echo/self-trigger)
    p.done(); assert.equal(p.state, 'idle');
  });
  test('two-step flow: wake word alone, then the command within the activation window; timeout returns to idle', () => {
    const { p, log } = mk({ activationWindowMs: 1000 });
    p.vad('start'); p.transcript('hey xoft', true, 0); assert.equal(p.state, 'awaiting_command');
    p.transcript('check the build', true, 500); assert.deepEqual(log.commands.map((c) => c.text), ['check the build']);
    p.done(); p.vad('start'); p.transcript('hey xoft', true, 10000); p.tick(10500); assert.equal(p.state, 'awaiting_command'); p.tick(11001);
    assert.equal(p.state, 'idle'); assert.equal(log.timeouts.length, 1); assert.equal(log.commands.length, 1);
  });
  test('privacy: speech without the wake phrase is discarded and never reaches onCommand/onWake', () => {
    const { p, log } = mk();
    p.vad('start'); for (const t of ['I will delete the old files later', 'what should we have for dinner', 'send the invoice to Bob']) p.transcript(t, true);
    assert.equal(log.commands.length, 0); assert.equal(log.wakes.length, 0);
    p.vad('end'); assert.equal(p.state, 'idle'); assert.equal(log.recog.at(-1), false);
  });
  test('risky commands (delete/deploy/send…) require confirmation: not sent until confirmed, cancel and timeout never send', () => {
    for (const how of ['ui', 'spoken']) {
      const { p, log } = mk(); p.vad('start'); p.transcript('hey xoft delete the old logs folder', true, 0);
      assert.equal(p.state, 'confirming'); assert.deepEqual(log.confirms, ['delete the old logs folder']); assert.equal(log.commands.length, 0);
      if (how === 'ui') p.confirm(); else p.transcript('yes do it', true, 100);
      assert.deepEqual(log.commands.map((c) => c.text), ['delete the old logs folder']);
    }
    const a = mk(); a.p.vad('start'); a.p.transcript('hey xoft deploy the latest version', true, 0); a.p.transcript('no cancel', true, 50);
    assert.equal(a.log.commands.length, 0); assert.equal(a.p.state, 'idle'); assert.deepEqual(a.log.cancels, ['spoken cancel']);
    const b = mk({ confirmWindowMs: 500 }); b.p.vad('start'); b.p.transcript('hey xoft send the report', true, 0); b.p.tick(600);
    assert.equal(b.log.commands.length, 0); assert.equal(b.p.state, 'idle'); assert.match(b.log.cancels[0], /timed out/);
    const c = mk(); c.p.vad('start'); c.p.transcript('hey xoft delete it', true, 0); c.p.transcript('what a nice day', true, 10); assert.equal(c.log.commands.length, 0); // unrelated speech never confirms
  });
  test('non-risky examples from the spec are sent without confirmation', () => {
    for (const cmd of ['open chrome', 'find the SocialPulse project', 'open browser.js', 'fix the browser executor', 'check the build', 'undo what you just changed', 'find the report in Downloads']) {
      const { p, log } = mk(); p.vad('start'); p.transcript(`hey xoft ${cmd}`, true); assert.equal(log.commands[0]?.text, cmd, cmd);
    }
  });
});
