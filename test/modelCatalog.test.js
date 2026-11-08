import test from 'node:test';
import assert from 'node:assert/strict';
import { validateModelChoice } from '../src/providers/modelCatalog.js';

test('accepts a model present in the catalog (id or slug)', () => {
  assert.equal(validateModelChoice([{ id: 'a' }, { slug: 'b' }], 'b').ok, true);
});
test('rejects an unknown model with 400', () => {
  const v = validateModelChoice([{ id: 'a' }], 'zzz');
  assert.deepEqual([v.ok, v.status], [false, 400]);
});
test('fails closed (502) when the catalog is empty or invalid', () => {
  for (const cat of [[], null, undefined, {}, [{}]]) {
    const v = validateModelChoice(cat, 'anything');
    assert.deepEqual([v.ok, v.status], [false, 502]);
  }
});
