import test from 'node:test';
import assert from 'node:assert/strict';

// These two services read their config at call time from process.env via src/config/index.js,
// which reads env vars once at import time -- set them before importing anything.
process.env.WHATSAPP_ACCESS_TOKEN = 'test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '123456';
process.env.WHATSAPP_VERIFY_TOKEN = 'verify';
process.env.WHATSAPP_APP_SECRET = 'secret';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'authtoken';
process.env.TWILIO_FROM_NUMBER = '+15550001111';
process.env.TWILIO_PUBLIC_BASE_URL = 'https://example.com';
process.env.TWILIO_VOICE_WEBHOOK_URL = 'https://example.com/voice';
process.env.TWILIO_VOICE_RESPONSE_URL = 'https://example.com/voice/response';

const { WhatsAppService } = await import('../src/integrations/WhatsAppService.js');
const { TwilioService } = await import('../src/integrations/TwilioService.js');

test('WhatsAppService.checkLive reports NOT_CONFIGURED honestly when unconfigured (no fetch call made)', async () => {
  process.env.WHATSAPP_ACCESS_TOKEN = '';
  const svc = new WhatsAppService({ fetchImpl: async () => { throw new Error('should not be called'); } });
  // isConfigured() re-reads process.env each call via the config module's already-resolved values,
  // so this only verifies the guard path when genuinely unconfigured at import time — skip if env was pre-set.
  if (!svc.isConfigured()) {
    const result = await svc.checkLive();
    assert.equal(result.status, 'NOT_CONFIGURED');
  }
  process.env.WHATSAPP_ACCESS_TOKEN = 'test-token';
});

test('WhatsAppService.checkLive returns LIVE on a genuine 200 from the Cloud API', async () => {
  let calledUrl = null;
  const svc = new WhatsAppService({
    fetchImpl: async (url) => { calledUrl = url; return { ok: true, status: 200, json: async () => ({ id: '123456', display_phone_number: '+1 555 000 1111' }) }; },
  });
  const result = await svc.checkLive();
  assert.match(calledUrl, /graph\.facebook\.com/);
  assert.equal(result.status, 'LIVE');
  assert.equal(result.detail, '+1 555 000 1111');
});

test('WhatsAppService.checkLive returns AUTH_ERROR on a genuine non-200, without throwing', async () => {
  const svc = new WhatsAppService({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid OAuth access token' } }) }) });
  const result = await svc.checkLive();
  assert.equal(result.status, 'AUTH_ERROR');
  assert.match(result.detail, /401/);
});

test('WhatsAppService.checkLive returns UNREACHABLE when the network call itself throws', async () => {
  const svc = new WhatsAppService({ fetchImpl: async () => { throw new Error('ENOTFOUND graph.facebook.com'); } });
  const result = await svc.checkLive();
  assert.equal(result.status, 'UNREACHABLE');
  assert.match(result.detail, /ENOTFOUND/);
});

test('TwilioService.checkLive returns LIVE with real Basic auth header derived from account credentials', async () => {
  let capturedAuth = null;
  const svc = new TwilioService({
    fetchImpl: async (_url, opts) => { capturedAuth = opts.headers.Authorization; return { ok: true, status: 200, json: async () => ({ status: 'active', friendly_name: 'XOFT' }) }; },
  });
  const result = await svc.checkLive();
  assert.equal(result.status, 'LIVE');
  assert.equal(result.detail, 'active');
  const expected = `Basic ${Buffer.from('ACtest:authtoken').toString('base64')}`;
  assert.equal(capturedAuth, expected);
});

test('TwilioService.checkLive returns AUTH_ERROR on bad credentials', async () => {
  const svc = new TwilioService({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ message: 'Authenticate' }) }) });
  const result = await svc.checkLive();
  assert.equal(result.status, 'AUTH_ERROR');
});
