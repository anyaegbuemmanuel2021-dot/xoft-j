import { Tool, RiskLevel } from '../Tool.js';

/**
 * Evaluate a small arithmetic language without eval(), Function(), or code generation.
 * Grammar: expression -> term (('+' | '-') term)*
 *          term       -> unary (('*' | '/') unary)*
 *          unary      -> ('+' | '-') unary | primary
 *          primary    -> NUMBER | '(' expression ')'
 */
export function evaluateArithmetic(expression) {
  if (typeof expression !== 'string' || expression.length === 0 || expression.length > 200) {
    throw new Error('calculate: expression must contain 1–200 characters');
  }

  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)|[()+\-*/]|\s+/g);
  if (!tokens) throw new Error('calculate: invalid expression');
  const compact = tokens.join('');
  if (compact !== expression) throw new Error('calculate: expression contains disallowed characters');

  const values = tokens.filter((token) => !/^\s+$/.test(token));
  if (values.length > 100) throw new Error('calculate: expression is too complex');
  let cursor = 0;

  const peek = () => values[cursor];
  const take = () => values[cursor++];

  function primary() {
    const token = take();
    if (token === '(') {
      const value = sum();
      if (take() !== ')') throw new Error('calculate: missing closing parenthesis');
      return value;
    }
    if (typeof token === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value)) throw new Error('calculate: number is out of range');
      return value;
    }
    throw new Error('calculate: expected a number or parenthesized expression');
  }

  function unary() {
    if (peek() === '+') { take(); return unary(); }
    if (peek() === '-') { take(); return -unary(); }
    return primary();
  }

  function product() {
    let value = unary();
    while (peek() === '*' || peek() === '/') {
      const operator = take();
      const right = unary();
      if (operator === '/' && right === 0) throw new Error('calculate: division by zero');
      value = operator === '*' ? value * right : value / right;
      if (!Number.isFinite(value)) throw new Error('calculate: result is out of range');
    }
    return value;
  }

  function sum() {
    let value = product();
    while (peek() === '+' || peek() === '-') {
      const operator = take();
      const right = product();
      value = operator === '+' ? value + right : value - right;
      if (!Number.isFinite(value)) throw new Error('calculate: result is out of range');
    }
    return value;
  }

  const result = sum();
  if (cursor !== values.length) throw new Error('calculate: unexpected token');
  return result;
}

export function buildUtilityTools() {
  return [
    new Tool({
      name: 'get_current_time',
      description: "Get the current date and time in the user's configured timezone (or UTC if none set).",
      inputSchema: { type: 'object', properties: {} },
      riskLevel: RiskLevel.SAFE,
      execute: async (_input, ctx) => {
        const tz = ctx.timezone ?? 'UTC';
        const now = new Date();
        return {
          iso: now.toISOString(),
          formatted: now.toLocaleString('en-US', { timeZone: tz }),
          timezone: tz,
        };
      },
    }),

    new Tool({
      name: 'calculate',
      description: 'Evaluate a numeric arithmetic expression (+, -, *, /, parentheses only) using a bounded parser; no code execution.',
      inputSchema: {
        type: 'object',
        properties: { expression: { type: 'string', minLength: 1, maxLength: 200 } },
        required: ['expression'],
        additionalProperties: false,
      },
      riskLevel: RiskLevel.SAFE,
      execute: async ({ expression }) => ({ expression, result: evaluateArithmetic(expression) }),
    }),
  ];
}
