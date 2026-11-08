// Env vars must be set before the first import of anything that touches
// src/config/index.js (a plain object computed once at import time).
// IMPORTANT: static `import` declarations are hoisted and evaluated before
// any of this file's own top-level statements run, so setting process.env
// above a static `import WhatsAppService from ...` would run too late —
// the config module would already have been evaluated with the original
// environment. Using a dynamic import() after setting process.env avoids
// that: this file runs in its own process (node:test's default per-file
// isolation), so none of this leaks into other test files.
process.env.WHATSAPP_ACCESS_TOKEN = 'test-access-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token';
process.env.WHATSAPP_APP_SECRET = 'test-app-secret';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const { WhatsAppService } = await import('../src/integrations/WhatsAppService.js');

describe('WhatsAppService — official Cloud API adapter', () => {
  test('isConfigured() is true once access token, phone number id, and app secret are all set', () => {
    const service = new WhatsAppService();
    assert.equal(service.isConfigured(), true);
  });

  test('verifyWebhookToken accepts the exact configured token and rejects anything else', () => {
    const service = new WhatsAppService();
    assert.equal(service.verifyWebhookToken('test-verify-token'), true);
    assert.equal(service.verifyWebhookToken('wrong-token'), false);
    assert.equal(service.verifyWebhookToken(''), false);
    assert.equal(service.verifyWebhookToken(null), false);
    assert.equal(service.verifyWebhookToken(undefined), false);
  });

  test('verifySignature validates a real HMAC-SHA256 signature the way Meta actually signs webhooks', () => {
    const service = new WhatsAppService();
    const rawBody = Buffer.from(JSON.stringify({ entry: [] }));
    const validSig = 'sha256=' + crypto.createHmac('sha256', 'test-app-secret').update(rawBody).digest('hex');
    assert.equal(service.verifySignature(rawBody, validSig), true);
  });

  test('verifySignature rejects a tampered body (signature computed for different bytes)', () => {
    const service = new WhatsAppService();
    const rawBody = Buffer.from(JSON.stringify({ entry: [] }));
    const sigForDifferentBody = 'sha256=' + crypto.createHmac('sha256', 'test-app-secret').update(Buffer.from('{"entry":["tampered"]}')).digest('hex');
    assert.equal(service.verifySignature(rawBody, sigForDifferentBody), false);
  });

  test('verifySignature rejects a missing or malformed header', () => {
    const service = new WhatsAppService();
    const rawBody = Buffer.from('{}');
    assert.equal(service.verifySignature(rawBody, undefined), false);
    assert.equal(service.verifySignature(rawBody, 'not-even-prefixed-correctly'), false);
    assert.equal(service.verifySignature(rawBody, 'sha1=deadbeef'), false);
  });

  test('sendText posts to the real Graph API endpoint with the right auth header and body, and returns the message id', async () => {
    let capturedUrl, capturedInit;
    const fetchImpl = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.ABC123' }], contacts: [{ input: '15551234567', wa_id: '15551234567' }] }) };
    };
    const service = new WhatsAppService({ fetchImpl });
    const result = await service.sendText({ to: '15551234567', message: 'hello from XOFT' });

    assert.equal(capturedUrl, 'https://graph.facebook.com/v23.0/1234567890/messages');
    assert.equal(capturedInit.method, 'POST');
    assert.equal(capturedInit.headers.Authorization, 'Bearer test-access-token');
    const body = JSON.parse(capturedInit.body);
    assert.deepEqual(body, { messaging_product: 'whatsapp', to: '15551234567', type: 'text', text: { body: 'hello from XOFT' } });
    assert.equal(result.messageId, 'wamid.ABC123');
    assert.equal(result.provider, 'whatsapp-cloud-api');
  });

  test('sendText surfaces the real API error rather than swallowing it or pretending success', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid OAuth access token' } }) });
    const service = new WhatsAppService({ fetchImpl });
    await assert.rejects(() => service.sendText({ to: '1', message: 'x' }), /401/);
  });

  test('parseWebhook extracts inbound text messages and delivery statuses, ignoring non-text message types', () => {
    const service = new WhatsAppService();
    const payload = {
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: '1234567890' },
            contacts: [{ wa_id: '15550001111', profile: { name: 'Jane' } }],
            messages: [
              { type: 'text', from: '15550001111', id: 'wamid.1', timestamp: '1700000000', text: { body: 'hi there' } },
              { type: 'image', from: '15550002222', id: 'wamid.2' }, // must be ignored — no text body to act on
            ],
            statuses: [
              { id: 'wamid.1', status: 'delivered', timestamp: '1700000001', recipient_id: '15550001111' },
            ],
          },
        }],
      }],
    };
    const { messages, statuses } = service.parseWebhook(payload);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].from, '15550001111');
    assert.equal(messages[0].text, 'hi there');
    assert.equal(messages[0].profileName, 'Jane');
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].status, 'delivered');
  });

  test('parseWebhook returns empty arrays for a malformed/empty payload rather than throwing', () => {
    const service = new WhatsAppService();
    assert.deepEqual(service.parseWebhook({}), { messages: [], statuses: [] });
    assert.deepEqual(service.parseWebhook(null), { messages: [], statuses: [] });
  });
});
