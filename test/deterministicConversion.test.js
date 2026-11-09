import test from 'node:test';
import assert from 'node:assert/strict';
import { deterministicConversion } from '../src/executive/ExecutiveBrain.js';

test('converts common distance units locally', () => {
  assert.equal(deterministicConversion('convert 10 km to miles'), '10 km = 6.2137 mi');
  assert.equal(deterministicConversion('convert 1 mile to km'), '1 mi = 1.6093 km');
});

test('converts temperature, mass and volume locally', () => {
  assert.equal(deterministicConversion('convert 0 celsius to fahrenheit'), '0 c = 32 f');
  assert.equal(deterministicConversion('convert 10 kg to pounds'), '10 kg = 22.0462 lb');
  assert.equal(deterministicConversion('convert 1 gallon to liters'), '1 gal = 3.7854 l');
});

test('does not guess unsupported or malformed conversions', () => {
  assert.equal(deterministicConversion('convert 5 naira to dollars'), null);
  assert.equal(deterministicConversion('convert a lot of km to miles'), null);
  assert.equal(deterministicConversion('please compare km and miles'), null);
});
