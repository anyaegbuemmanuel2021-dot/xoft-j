const test = require('node:test');
const assert = require('node:assert/strict');
const { openUrl } = require('./browser');

test('legacy URL opener refuses non-HTTP schemes before launching an OS handler', async () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,hello']) {
    const result = await openUrl(url);
    assert.equal(result.success, false, url);
    assert.match(result.error, /non-http\(s\) URL scheme/);
  }
});

test('legacy URL opener rejects malformed URLs without invoking an OS handler', async () => {
  const result = await openUrl('not a URL');
  assert.equal(result.success, false);
  assert.match(result.error, /valid HTTP\(S\) URL is required/);
});
