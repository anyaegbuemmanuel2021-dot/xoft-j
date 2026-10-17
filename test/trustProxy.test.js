import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrustProxy } from '../src/config/trustProxy.js';

test('TRUST_PROXY: off by default and for falsy/garbage values; hop counts and named ranges accepted; unsafe values never trusted', () => {
  for (const off of [undefined, null, '', 'false', '0', 'off', 'no', 'true', 'yes', '11', '-1', '1.5', 'all', '0.0.0.0/0', '*']) assert.equal(parseTrustProxy(off), undefined, String(off));
  assert.equal(parseTrustProxy('1'), 1); assert.equal(parseTrustProxy(' 2 '), 2); assert.equal(parseTrustProxy('10'), 10);
  assert.equal(parseTrustProxy('LOOPBACK'), 'loopback'); assert.equal(parseTrustProxy('uniquelocal'), 'uniquelocal');
});
