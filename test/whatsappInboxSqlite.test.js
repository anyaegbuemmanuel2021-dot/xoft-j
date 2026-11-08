import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/persistence/SqliteStore.js';
import { WhatsAppInboxStore } from '../src/integrations/WhatsAppInboxStore.js';

describe('WhatsAppInboxStore SQLite persistence', () => {
  test('stores conversations, delivery status, restart recovery and bounded retention', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-wa-sqlite-'));
    const db = new SqliteStore(path.join(dir, 'xoft.sqlite'));
    try {
      let inbox = new WhatsAppInboxStore({ dataDir: dir, maxMessages: 2, sqliteStore: db });
      inbox.record({ id: 'm1', from: '2348000000000', to: 'business', text: 'one', timestamp: '2026-01-01T00:00:00.000Z' });
      inbox.record({ id: 'm2', direction: 'outbound', from: 'business', to: '2348000000000', text: 'two', timestamp: '2026-01-02T00:00:00.000Z' });
      inbox.updateStatus('m1', 'read');
      inbox.record({ id: 'm3', from: '2348000000000', to: 'business', text: 'three', timestamp: '2026-01-03T00:00:00.000Z' });
      inbox = new WhatsAppInboxStore({ dataDir: dir, maxMessages: 2, sqliteStore: db });
      assert.equal(inbox.get('m1'), null);
      assert.equal(inbox.conversation('2348000000000').length, 2);
      assert.equal(inbox.get('m2').direction, 'outbound');
      assert.equal(inbox.summary().total, 2);
      assert.equal(fs.existsSync(path.join(dir, 'whatsapp_inbox.json')), false);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('imports legacy JSON once and keeps it as a backup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-wa-legacy-'));
    const file = path.join(dir, 'whatsapp_inbox.json');
    const legacy = { messages: [{ id: 'legacy-1', timestamp: '2026-01-01T00:00:00.000Z', from: 'a', to: 'b', direction: 'inbound', text: 'hello' }] };
    fs.writeFileSync(file, JSON.stringify(legacy));
    const db = new SqliteStore(path.join(dir, 'xoft.sqlite'));
    try {
      const inbox = new WhatsAppInboxStore({ dataDir: dir, sqliteStore: db });
      assert.equal(inbox.get('legacy-1').text, 'hello');
      inbox.record({ id: 'new-1', from: 'a', to: 'b', text: 'new', timestamp: '2026-01-02T00:00:00.000Z' });
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), legacy);
      assert.equal(new WhatsAppInboxStore({ dataDir: dir, sqliteStore: db }).get('new-1').text, 'new');
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
