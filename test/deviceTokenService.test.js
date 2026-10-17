import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceTokenService } from '../src/security/DeviceTokenService.js';
import { SqliteStore } from '../src/persistence/SqliteStore.js';

function makeSqliteHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-devtoken-test-'));
  const store = new SqliteStore(path.join(dir, 'test.sqlite'));
  return { store, service: new DeviceTokenService({ store }) };
}

describe('DeviceTokenService — in-memory fallback (no store)', () => {
  test('issued token verifies to the right device and no other', () => {
    const service = new DeviceTokenService({});
    const token = service.issue('device-a');
    assert.equal(service.verify(token), 'device-a');
    assert.notEqual(service.verify(token), 'device-b');
  });

  test('unknown or tampered tokens verify to null', () => {
    const service = new DeviceTokenService({});
    service.issue('device-a');
    assert.equal(service.verify('not-a-real-token'), null);
    assert.equal(service.verify(''), null);
  });

  test('revoking a device invalidates all of its tokens, and only its own', () => {
    const service = new DeviceTokenService({});
    const tokenA1 = service.issue('device-a');
    const tokenA2 = service.issue('device-a');
    const tokenB = service.issue('device-b');
    service.revokeAllForDevice('device-a');
    assert.equal(service.verify(tokenA1), null);
    assert.equal(service.verify(tokenA2), null);
    assert.equal(service.verify(tokenB), 'device-b'); // untouched
  });
});

describe('DeviceTokenService — SQLite-backed (persists across restarts)', () => {
  test('a token issued before "restart" still verifies after reopening the store', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-devtoken-sqlite-'));
    const dbPath = path.join(dir, 'test.sqlite');

    const store1 = new SqliteStore(dbPath);
    const service1 = new DeviceTokenService({ store: store1 });
    const token = service1.issue('device-a');
    store1.close();

    const store2 = new SqliteStore(dbPath); // simulates a process restart
    const service2 = new DeviceTokenService({ store: store2 });
    assert.equal(service2.verify(token), 'device-a');
    store2.close();
  });

  test('revocation persists to the database, not just memory', () => {
    const { store, service } = makeSqliteHarness();
    const token = service.issue('device-a');
    assert.equal(service.verify(token), 'device-a');
    service.revokeAllForDevice('device-a');
    assert.equal(service.verify(token), null);
    store.close();
  });
});
