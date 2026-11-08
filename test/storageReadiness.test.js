import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isPathWithin, isOnMountedFilesystem } from '../src/persistence/storageReadiness.js';

test('persistent mount detection accepts the mount itself and its descendants', () => {
  const mountInfo = '29 22 0:26 / /var/data rw,nosuid - ext4 /dev/sdb rw';
  assert.equal(isOnMountedFilesystem('/var/data', mountInfo), true);
  assert.equal(isOnMountedFilesystem('/var/data/xoft.sqlite', mountInfo), true);
});

test('persistent mount detection does not mistake the container root filesystem for a disk', () => {
  const mountInfo = '29 22 0:26 / / rw,relatime - overlay overlay rw';
  assert.equal(isOnMountedFilesystem('/app/data', mountInfo), false);
});

test('persistent path containment rejects sibling directories', () => {
  assert.equal(isPathWithin('/var/data', '/var/data/xoft.sqlite'), true);
  assert.equal(isPathWithin('/var/data', '/var/database/xoft.sqlite'), false);
  assert.equal(path.resolve('/var/data'), '/var/data');
});

test('storage readiness reports ephemeral storage as not durable', async () => {
  const { assessStorageReadiness } = await import('../src/persistence/storageReadiness.js');
  assert.deepEqual(assessStorageReadiness({ persistentRoot: '/var/data', dataRoot: '/app/data', sqlitePath: '/app/data/xoft.sqlite', mountInfo: '29 22 0:26 / / rw,relatime - overlay overlay rw' }), { durable: false, configured: true, mounted: false });
});

test('storage readiness requires both memory and SQLite paths inside the mounted disk', async () => {
  const { assessStorageReadiness } = await import('../src/persistence/storageReadiness.js');
  const mountInfo = '29 22 0:26 / /var/data rw,nosuid - ext4 /dev/sdb rw';
  assert.deepEqual(assessStorageReadiness({ persistentRoot: '/var/data', dataRoot: '/var/data', sqlitePath: '/var/data/xoft.sqlite', mountInfo }), { durable: true, configured: true, mounted: true });
  assert.equal(assessStorageReadiness({ persistentRoot: '/var/data', dataRoot: '/app/data', sqlitePath: '/var/data/xoft.sqlite', mountInfo }).durable, false);
});

test('strict durable-storage mode fails readiness on ephemeral storage but remains opt-in', async () => {
  const { isStorageReady } = await import('../src/persistence/storageReadiness.js');
  assert.equal(isStorageReady({ durable: false }), true);
  assert.equal(isStorageReady({ durable: false, required: true }), false);
  assert.equal(isStorageReady({ durable: true, required: true }), true);
});
