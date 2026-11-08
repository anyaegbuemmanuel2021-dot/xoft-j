import { Tool, RiskLevel } from '../Tool.js';

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
      description: 'Evaluate a numeric arithmetic expression (+, -, *, /, parentheses only — no free-form code execution).',
      inputSchema: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
      riskLevel: RiskLevel.SAFE,
      execute: async ({ expression }) => {
        // Deliberately restrictive: only digits, whitespace, and + - * / ( ) . are
        // allowed. This is a calculator, not a JS eval sandbox.
        if (!/^[\d\s+\-*/().]+$/.test(expression)) {
          throw new Error('calculate: expression contains disallowed characters');
        }
        // eslint-disable-next-line no-new-func
        const result = Function(`"use strict"; return (${expression})`)();
        if (typeof result !== 'number' || !Number.isFinite(result)) {
          throw new Error('calculate: expression did not evaluate to a finite number');
        }
        return { expression, result };
      },
    }),
  ];
}
