'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { capture, input, escapeSendKeysText } = require('../src/executors/screen');

function fakeExecFile({ stdout = '', error = null, stderr = '' } = {}) {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(error, stdout, stderr);
  };
  return { calls, execFileImpl };
}

test('SendKeys metacharacters are escaped as literal text', () => {
  assert.equal(escapeSendKeysText('a+^%~(){}b'), 'a{+}{^}{%}{~}{(}{)}{{}{}}b');
  assert.equal(escapeSendKeysText("O'Reilly"), "O'Reilly");
  assert.equal(escapeSendKeysText('plain text 123'), 'plain text 123');
});

test('Windows typing escapes shortcuts and quotes PowerShell apostrophes safely', async () => {
  const fake = fakeExecFile();
  const result = await input('type', { text: "Save + edit ^ 50% ~ (draft) {one} O'Reilly" }, { platform: 'win32', execFileImpl: fake.execFileImpl });
  assert.equal(result.success, true);
  assert.equal(result.data.dispatched, true);
  assert.equal(fake.calls.length, 1);
  const args = fake.calls[0].args;
  assert.equal(fake.calls[0].file, 'powershell.exe');
  const script = args[args.indexOf('-Command') + 1];
  assert.ok(script.includes("SendWait('Save {+} edit {^} 50{%} {~} {(}draft{)} {{one}} O''Reilly')"));
});

test('Windows click stops and reports failure if SetCursorPos is rejected', async () => {
  const fake = fakeExecFile({ error: new Error('Windows refused to position the cursor.') });
  const result = await input('click', { x: 100, y: 50 }, { platform: 'win32', execFileImpl: fake.execFileImpl });
  assert.equal(result.success, false);
  assert.match(result.error, /refused to position the cursor/);
  const script = fake.calls[0].args[fake.calls[0].args.indexOf('-Command') + 1];
  assert.match(script, /if \(-not \[I\]::SetCursorPos\(100,50\)\)/);
});

test('right-click uses right mouse button flags', async () => {
  const fake = fakeExecFile();
  const result = await input('click', { x: 10, y: 20, button: 'right' }, { platform: 'win32', execFileImpl: fake.execFileImpl });
  assert.equal(result.success, true);
  const script = fake.calls[0].args[fake.calls[0].args.indexOf('-Command') + 1];
  assert.match(script, /mouse_event\(0x0008/);
  assert.match(script, /mouse_event\(0x0010/);
});

test('typing rejects text above the bounded input size without launching PowerShell', async () => {
  const fake = fakeExecFile();
  const result = await input('type', { text: 'x'.repeat(4001) }, { platform: 'win32', execFileImpl: fake.execFileImpl });
  assert.equal(result.success, false);
  assert.match(result.error, /4000 character limit/);
  assert.equal(fake.calls.length, 0);
});

test('screen actions fail clearly on unsupported operating systems', async () => {
  const fake = fakeExecFile();
  assert.equal((await input('click', { x: 1, y: 1 }, { platform: 'linux', execFileImpl: fake.execFileImpl })).success, false);
  assert.equal((await capture({ platform: 'linux', execFileImpl: fake.execFileImpl })).success, false);
  assert.equal(fake.calls.length, 0);
});

test('capture accepts a PowerShell PNG payload and rejects an empty result', async () => {
  const good = fakeExecFile({ stdout: 'UE5HREFUQQ==\n' });
  const captured = await capture({ platform: 'win32', execFileImpl: good.execFileImpl });
  assert.equal(captured.success, true);
  assert.equal(captured.data.mimeType, 'image/png');
  assert.equal(captured.data.base64, 'UE5HREFUQQ==');

  const empty = fakeExecFile();
  const missing = await capture({ platform: 'win32', execFileImpl: empty.execFileImpl });
  assert.equal(missing.success, false);
  assert.match(missing.error, /No screenshot data/);
});
