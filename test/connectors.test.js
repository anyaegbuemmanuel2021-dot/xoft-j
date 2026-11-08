import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorManager } from '../src/connectors/ConnectorManager.js';

test('ConnectorManager exposes configured connectors without credentials', () => {
  const cm = new ConnectorManager({ definitions: [{ id: 'canva', endpoint: 'https://example.test/mcp', headers: { Authorization: 'Bearer secret' } }] });
  const item = cm.list()[0];
  assert.equal(item.id, 'canva');
  assert.equal(item.endpoint, 'https://example.test/mcp');
  assert.equal('headers' in item, false);
});

test('ConnectorManager rejects unknown transport', () => {
  assert.throws(() => new ConnectorManager({ definitions: [{ id: 'x', endpoint: 'https://example.test', transport: 'ftp' }] }), /unsupported transport/);
});
