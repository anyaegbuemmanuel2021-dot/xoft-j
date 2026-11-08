import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

// Configure the environment before importing the config module.
process.env.XOFT_PERSISTENT_DATA_DIR = '/var/data';
process.env.MEMORY_DATA_DIR = '/var/data';
delete process.env.SQLITE_PATH;

const { config } = await import('../src/config/index.js');

test('XOFT uses the mounted persistent directory for file-backed state', () => {
  assert.equal(config.memory.dataDir, '/var/data');
  assert.equal(config.storage.persistentDataDir, '/var/data');
});

test('XOFT places SQLite inside the mounted persistent directory by default', () => {
  assert.equal(config.storage.sqlitePath, path.join('/var/data', 'xoft.sqlite'));
});
