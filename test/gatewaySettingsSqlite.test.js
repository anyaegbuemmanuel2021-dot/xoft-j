import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GatewaySettingsStore } from '../src/providers/GatewaySettingsStore.js';
import { GATEWAY_IDS, GATEWAY_DEFAULTS } from '../src/providers/gatewayConfig.js';
import { SqliteStore } from '../src/persistence/SqliteStore.js';

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-gateway-settings-'));
  const config = { providers: Object.fromEntries(GATEWAY_IDS.map((id) => [id, {
    enabled: false, baseUrl: GATEWAY_DEFAULTS[id].baseUrl, apiKey: null,
    model: GATEWAY_DEFAULTS[id].model, embeddingModel: null, timeoutMs: 60000,
    vision: false, tools: true,
  }])) };
  return { dataDir, config };
}

describe('GatewaySettingsStore SQLite persistence', () => {
  test('persists gateway configuration across store instances without exposing keys', () => {
    const { dataDir, config } = fixture();
    const dbPath = path.join(dataDir, 'xoft.sqlite');
    let db = new SqliteStore(dbPath);
    const store = new GatewaySettingsStore({ dataDir, config, sqliteStore: db, logger: { warn() {} } }).load();
    const view = store.update('freellmapi', {
      enabled: true, baseUrl: 'https://api.example.test/v1', apiKey: 'secret-provider-key',
      model: 'fast-model', timeoutMs: 12000,
    });
    assert.equal(view.apiKeySet, true);
    assert.equal(JSON.stringify(view).includes('secret-provider-key'), false);
    db.close();

    db = new SqliteStore(dbPath);
    const nextConfig = fixture().config;
    const restarted = new GatewaySettingsStore({ dataDir, config: nextConfig, sqliteStore: db, logger: { warn() {} } }).load();
    assert.equal(nextConfig.providers.freellmapi.apiKey, 'secret-provider-key');
    assert.equal(nextConfig.providers.freellmapi.model, 'fast-model');
    assert.equal(restarted.publicView('freellmapi').apiKeySet, true);
    assert.equal(fs.existsSync(path.join(dataDir, 'provider-settings.json')), false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
    db.close();
  });

  test('imports legacy JSON settings once and leaves the original file intact', () => {
    const { dataDir, config } = fixture();
    const legacy = { freellmapi: { enabled: true, apiKey: 'legacy-secret', model: 'legacy-model' } };
    const file = path.join(dataDir, 'provider-settings.json');
    fs.writeFileSync(file, JSON.stringify(legacy));
    const db = new SqliteStore(path.join(dataDir, 'xoft.sqlite'));
    try {
      const store = new GatewaySettingsStore({ dataDir, config, sqliteStore: db, logger: { warn() {} } }).load();
      assert.equal(config.providers.freellmapi.apiKey, 'legacy-secret');
      store.update('freellmapi', { model: 'updated-model' });
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), legacy);
      const restartedConfig = fixture().config;
      new GatewaySettingsStore({ dataDir, config: restartedConfig, sqliteStore: db, logger: { warn() {} } }).load();
      assert.equal(restartedConfig.providers.freellmapi.model, 'updated-model');
    } finally { db.close(); }
  });

  test('retains JSON persistence when SQLite is not configured', () => {
    const { dataDir, config } = fixture();
    const store = new GatewaySettingsStore({ dataDir, config, logger: { warn() {} } }).load();
    store.update('litellm', { enabled: true, model: 'local-model' });
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'provider-settings.json'), 'utf8'));
    assert.equal(saved.litellm.model, 'local-model');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dataDir, 'provider-settings.json')).mode & 0o777, 0o600);
  });
});
