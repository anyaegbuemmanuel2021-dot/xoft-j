import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WhatsAppInboxStore } from '../src/integrations/WhatsAppInboxStore.js';

describe('WhatsAppInboxStore', () => {
  let dir;
  let store;
  test('persists inbound/outbound messages, filters conversations, and updates delivery/read status', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-wa-'));
    store = new WhatsAppInboxStore({ dataDir: dir });
    store.record({ id: 'wamid.in.1', direction: 'inbound', from: '2348000000000', to: 'phone-id', text: 'Hello', timestamp: '2026-10-16T10:00:00.000Z' });
    store.record({ id: 'wamid.out.1', direction: 'outbound', from: 'phone-id', to: '2348000000000', text: 'Hi back', timestamp: '2026-10-16T10:01:00.000Z' });
    assert.equal(store.conversation('2348000000000').length, 2);
    assert.equal(store.list({ contact: '2348000000000' }).length, 2);
    assert.equal(store.updateStatus('wamid.in.1', 'read').status, 'read');
    assert.equal(store.get('wamid.in.1').status, 'read');
    assert.deepEqual(store.summary(), { total: 2, inbound: 1, outbound: 1, lastMessageAt: '2026-10-16T10:01:00.000Z' });
    const restarted = new WhatsAppInboxStore({ dataDir: dir });
    assert.equal(restarted.conversation('2348000000000').length, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
