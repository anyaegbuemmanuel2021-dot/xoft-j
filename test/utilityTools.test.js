import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateArithmetic, buildUtilityTools } from '../src/tools/builtins/utilityTools.js';

test('evaluateArithmetic respects operator precedence and parentheses', () => {
  assert.equal(evaluateArithmetic('2 + 3 * 4'), 14);
  assert.equal(evaluateArithmetic('(2 + 3) * 4'), 20);
  assert.equal(evaluateArithmetic('-(2 + 3) * 4'), -20);
  assert.equal(evaluateArithmetic('8 / 2 / 2'), 2);
  assert.equal(evaluateArithmetic('1.5 + .5'), 2);
});

test('evaluateArithmetic rejects code, unsupported syntax, and malformed expressions', () => {
  for (const value of [
    'process.exit()',
    '1;2',
    '2 ** 8',
    '1 +',
    '(1 + 2',
    '1 + 2)',
    '',
    '1 / 0',
    '9'.repeat(201),
  ]) assert.throws(() => evaluateArithmetic(value));
});

test('calculate tool delegates to the safe arithmetic parser', async () => {
  const [tool] = buildUtilityTools().filter((item) => item.name === 'calculate');
  assert.deepEqual(await tool.run({ expression: '6 * (7 + 1)' }, {}), {
    expression: '6 * (7 + 1)',
    result: 48,
  });
});
