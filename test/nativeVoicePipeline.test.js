import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { VoicePipeline } from '../public/js/voice/wake.js';

test('continuous native recognition starts, pauses during execution, and resumes after the reply', () => {
  let starts = 0;
  let stops = 0;
  const commands = [];
  const pipeline = new VoicePipeline({
    continuousRecognition: true,
    conversationMode: false,
    wantRecognizer: (on) => { if (on) starts += 1; else stops += 1; },
    onCommand: (command) => commands.push(command),
  });

  assert.equal(pipeline.start(), true);
  assert.equal(pipeline.state, 'wake_listening');
  assert.equal(starts, 1);

  pipeline.transcript('hey xoft open calculator', true);
  assert.equal(pipeline.state, 'submitting');
  assert.equal(stops, 1);
  assert.equal(commands[0].text, 'open calculator');

  pipeline.done();
  assert.equal(pipeline.state, 'wake_listening');
  assert.equal(starts, 2);
});

test('continuous native recognition still requires confirmation for risky commands', () => {
  let command = null;
  let starts = 0;
  const pipeline = new VoicePipeline({
    continuousRecognition: true,
    wantRecognizer: (on) => { if (on) starts += 1; },
    onCommand: (value) => { command = value; },
  });
  pipeline.start();
  pipeline.transcript('hey xoft delete my files', true);
  assert.equal(pipeline.state, 'confirming');
  assert.equal(command, null);
  pipeline.transcript('yes', true);
  assert.equal(pipeline.state, 'submitting');
  assert.equal(command.text, 'delete my files');
  pipeline.done();
  assert.equal(starts, 2);
});


test('Android native AudioRecord bridge preserves the Nigerian Pidgin language choice', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'android-companion/app/src/main/java/com/xoft/companion/LiveActivity.kt'), 'utf8');
  assert.match(source, /"pcm",\s*"pidgin"\s*->\s*"pcm"/);
  assert.match(source, /"ig"\s*->\s*"ig"/);
  assert.match(source, /"en"\s*->\s*"en"/);
});
