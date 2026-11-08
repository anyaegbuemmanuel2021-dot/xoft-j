import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Command Center never maps over an undeclared configured variable', () => {
  const source = fs.readFileSync(path.join(root, 'public/js/dashboard/XoftCommandCenter.js'), 'utf8');
  assert.doesNotMatch(source, /\bconfigured\s*\.\s*map\s*\(/,
    'Regression: configured.map(...) references an undeclared variable');
  assert.match(source, /providers\.filter\(\(p\)\s*=>\s*p\.configured\)\.map\(/,
    'Provider samples must be derived from the providers array');
});

test('Command Center safely handles missing or malformed provider state', () => {
  const source = fs.readFileSync(path.join(root, 'public/js/dashboard/XoftCommandCenter.js'), 'utf8');
  assert.match(source, /Array\.isArray\(providerData\)/,
    'Provider state must be validated before it is filtered');
});
