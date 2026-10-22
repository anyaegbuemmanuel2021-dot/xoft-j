import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicHttpUrl } from '../src/agents/research/SearchService.js';

test('allows public HTTP and HTTPS page URLs', () => {
  assert.equal(assertPublicHttpUrl('https://example.com/research?q=x').hostname, 'example.com');
  assert.equal(assertPublicHttpUrl('http://docs.example.org/page').protocol, 'http:');
});

test('rejects non-web protocols and credential-bearing URLs', () => {
  assert.throws(() => assertPublicHttpUrl('file:///etc/passwd'), /HTTP and HTTPS/);
  assert.throws(() => assertPublicHttpUrl('ftp://example.com/file'), /HTTP and HTTPS/);
  assert.throws(() => assertPublicHttpUrl('https://user:pass@example.com/'), /credentials/);
});

test('rejects loopback, private, link-local and metadata destinations', () => {
  for (const url of [
    'http://localhost/',
    'http://service.local/',
    'http://127.0.0.1/',
    'http://10.0.0.2/',
    'http://172.16.0.5/',
    'http://192.168.1.2/',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/',
    'http://[::1]/',
  ]) {
    assert.throws(() => assertPublicHttpUrl(url), undefined, url);
  }
});
