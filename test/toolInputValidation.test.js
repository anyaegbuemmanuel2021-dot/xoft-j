import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';

describe('ToolRegistry — JSON schema input validation', () => {
  test('rejects missing required fields, wrong types, enum values, and unexpected properties', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'test.schema',
      description: 'schema validation fixture',
      inputSchema: {
        type: 'object',
        required: ['recipient', 'priority'],
        additionalProperties: false,
        properties: {
          recipient: { type: 'string', minLength: 1 },
          priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        },
      },
      riskLevel: 0,
      requiredPermissions: [],
      status: 'implemented',
      async run() { return { ok: true }; },
    });

    await assert.rejects(() => registry.execute('test.schema', {}), /recipient is required/);
    await assert.rejects(() => registry.execute('test.schema', { recipient: 7, priority: 'normal' }), /recipient must be string/);
    await assert.rejects(() => registry.execute('test.schema', { recipient: 'team', priority: 'urgent' }), /priority must be one of the allowed values/);
    await assert.rejects(() => registry.execute('test.schema', { recipient: 'team', priority: 'normal', admin: true }), /admin is not allowed/);
  });

  test('validates nested objects, arrays, and numeric bounds', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'test.nested',
      description: 'nested schema fixture',
      inputSchema: {
        type: 'object',
        required: ['steps'],
        properties: {
          steps: { type: 'array', minItems: 1, items: {
            type: 'object',
            required: ['name', 'attempts'],
            properties: {
              name: { type: 'string', minLength: 2 },
              attempts: { type: 'integer', minimum: 1, maximum: 3 },
            },
          } },
        },
      },
      riskLevel: 0,
      requiredPermissions: [],
      status: 'implemented',
      async run(input) { return input; },
    });

    await assert.rejects(() => registry.execute('test.nested', { steps: [{ name: 'x', attempts: 4 }] }), /steps\[0\]\.name is shorter/);
    await assert.rejects(() => registry.execute('test.nested', { steps: [{ name: 'step', attempts: 4 }] }), /attempts must be at most 3/);
    const result = await registry.execute('test.nested', { steps: [{ name: 'step', attempts: 2 }] });
    assert.equal(result.steps[0].attempts, 2);
  });

  test('validates before consuming device permissions', async () => {
    let checks = 0;
    let uses = 0;
    const registry = new ToolRegistry({
      permissionEngine: {
        check() { checks += 1; return true; },
        markUsed() { uses += 1; },
      },
    });
    registry.register({
      name: 'test.permission-schema',
      description: 'permission ordering fixture',
      inputSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } },
      riskLevel: 0,
      requiredPermissions: ['device.read'],
      status: 'implemented',
      async run() { return { ok: true }; },
    });

    await assert.rejects(() => registry.execute('test.permission-schema', {}), /value is required/);
    assert.equal(checks, 0);
    assert.equal(uses, 0);
    await registry.execute('test.permission-schema', { value: 'ok' });
    assert.equal(checks, 1);
    assert.equal(uses, 1);
  });

  test('keeps legacy unconstrained schemas compatible', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'test.legacy',
      description: 'legacy schema',
      inputSchema: {},
      riskLevel: 0,
      requiredPermissions: [],
      status: 'implemented',
      async run(input) { return input; },
    });
    assert.deepEqual(await registry.execute('test.legacy', { arbitrary: true }), { arbitrary: true });
  });
});
