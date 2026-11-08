process.env.TWILIO_ACCOUNT_SID = 'ACtestaccountsid';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.TWILIO_FROM_NUMBER = '+15005550006';
process.env.TWILIO_VOICE_WEBHOOK_URL = 'https://example.com/webhooks/twilio/voice';
process.env.TWILIO_VOICE_RESPONSE_URL = 'https://example.com/webhooks/twilio/voice/respond';
process.env.TWILIO_STATUS_CALLBACK_URL = 'https://example.com/webhooks/twilio/status';
process.env.TWILIO_PUBLIC_BASE_URL = 'https://example.com';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
// Dynamic import, after setting process.env — see whatsappService.test.js
// for why a static import here would be evaluated too early (ESM hoisting).
const { TwilioService } = await import('../src/integrations/TwilioService.js');

function twilioSignature(url, params, authToken) {
  // Twilio's own documented algorithm: concatenate the full URL with each
  // POST param's key+value, sorted alphabetically by key, no separators,
  // then HMAC-SHA1 with the auth token, base64-encoded.
  const data = Object.keys(params).sort().reduce((s, k) => `${s}${k}${params[k]}`, url);
  return crypto.createHmac('sha1', authToken).update(data).digest('base64');
}

describe('TwilioService — official REST + webhook adapter', () => {
  test('isConfigured() is true once account sid, auth token, from number, and both webhook URLs are set', () => {
    assert.equal(new TwilioService().isConfigured(), true);
  });

  test('validateSignature accepts a signature computed the way Twilio actually computes it', () => {
    const service = new TwilioService();
    const url = 'https://example.com/webhooks/twilio/voice';
    const params = { CallSid: 'CA123', From: '+15551234567', To: '+15005550006' };
    const sig = twilioSignature(url, params, 'test-auth-token');
    assert.equal(service.validateSignature(url, params, sig), true);
  });

  test('validateSignature rejects a signature computed with the wrong auth token', () => {
    const service = new TwilioService();
    const url = 'https://example.com/webhooks/twilio/voice';
    const params = { CallSid: 'CA123' };
    const wrongSig = twilioSignature(url, params, 'not-the-real-token');
    assert.equal(service.validateSignature(url, params, wrongSig), false);
  });

  test('validateSignature rejects a signature computed for a different URL (webhook URL spoofing attempt)', () => {
    const service = new TwilioService();
    const params = { CallSid: 'CA123' };
    const sigForDifferentUrl = twilioSignature('https://attacker.example/webhooks/twilio/voice', params, 'test-auth-token');
    assert.equal(service.validateSignature('https://example.com/webhooks/twilio/voice', params, sigForDifferentUrl), false);
  });

  test('validateSignature rejects a missing signature', () => {
    const service = new TwilioService();
    assert.equal(service.validateSignature('https://example.com/x', {}, undefined), false);
  });

  test('createCall posts to the real Calls REST API with Basic auth and the configured webhook URL', async () => {
    let capturedUrl, capturedInit;
    const fetchImpl = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return { ok: true, status: 201, json: async () => ({ sid: 'CAabc123', status: 'queued' }) };
    };
    const service = new TwilioService({ fetchImpl });
    const result = await service.createCall({ to: '+15551234567' });

    assert.equal(capturedUrl, 'https://api.twilio.com/2010-04-01/Accounts/ACtestaccountsid/Calls.json');
    const expectedBasic = Buffer.from('ACtestaccountsid:test-auth-token').toString('base64');
    assert.equal(capturedInit.headers.Authorization, `Basic ${expectedBasic}`);
    const params = new URLSearchParams(capturedInit.body);
    assert.equal(params.get('To'), '+15551234567');
    assert.equal(params.get('From'), '+15005550006');
    assert.equal(params.get('Url'), 'https://example.com/webhooks/twilio/voice');
    assert.equal(result.callSid, 'CAabc123');
    assert.equal(result.provider, 'twilio');
  });

  test('createCall surfaces the real API error rather than pretending the call was placed', async () => {
    const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ message: 'The number +1 is not a valid phone number.' }) });
    const service = new TwilioService({ fetchImpl });
    await assert.rejects(() => service.createCall({ to: '+1' }), /400/);
  });

  test('buildVoicePrompt/buildVoiceResponse produce valid TwiML and escape untrusted text (no TwiML/XML injection)', () => {
    const service = new TwilioService();
    const prompt = service.buildVoicePrompt({ greeting: 'Hello & welcome' });
    assert.match(prompt, /<Response>/);
    assert.match(prompt, /&amp;/, 'the ampersand must be escaped, not passed through raw');

    const injectionAttempt = '</Say><Redirect>https://attacker.example/</Redirect><Say>';
    const response = service.buildVoiceResponse(injectionAttempt);
    // the attacker's literal tag characters must come out escaped, not as real XML tags
    assert.ok(!response.includes('<Redirect>'), 'a spoken-text injection attempt must not produce a real <Redirect> tag');
    assert.match(response, /&lt;Redirect&gt;/);
  });
});
