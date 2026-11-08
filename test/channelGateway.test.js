import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelGateway } from '../src/channels/ChannelGateway.js';
import { WhatsAppService } from '../src/integrations/WhatsAppService.js';
import { TwilioService } from '../src/integrations/TwilioService.js';
import { buildCommunicationTools } from '../src/tools/builtins/communicationTools.js';

describe('ChannelGateway — normalizes every inbound channel to one shape', () => {
  test('rejects a request with no channel or no message', () => {
    const gateway = new ChannelGateway({ executiveBrain: { handle: async () => ({}) } });
    assert.throws(() => gateway.normalize({ message: 'hi' }), /channel and message are required/);
    assert.throws(() => gateway.normalize({ channel: 'whatsapp' }), /channel and message are required/);
  });

  test('synthesizes a stable sessionId from channel+userId when none is given', () => {
    const gateway = new ChannelGateway({ executiveBrain: { handle: async () => ({}) } });
    const normalized = gateway.normalize({ channel: 'whatsapp', userId: '15551234567', message: 'hi' });
    assert.equal(normalized.sessionId, 'whatsapp:15551234567');
  });

  test('handle() dispatches to the same ExecutiveBrain.handle(sessionId, message) used by the web channel, regardless of source', async () => {
    const calls = [];
    const executiveBrain = { async handle(sessionId, message) { calls.push({ sessionId, message }); return { reply: 'ok', action: 'chat' }; } };
    const gateway = new ChannelGateway({ executiveBrain });

    await gateway.handle({ channel: 'whatsapp', userId: 'user-a', message: 'from whatsapp' });
    await gateway.handle({ channel: 'web', userId: 'user-a', sessionId: 'web:session-1', message: 'from web' });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].message, 'from whatsapp');
    assert.equal(calls[1].sessionId, 'web:session-1');
    // Same brain, same method, same call shape for both channels — no
    // per-channel "brain", exactly the architecture requirement this is for.
    assert.equal(new Set(calls.map(() => executiveBrain.handle)).size, 1);
  });

  test('handle() returns the channel and sessionId alongside the brain result, and logs the request', async () => {
    const logged = [];
    const activityLog = { log: (e) => logged.push(e) };
    const executiveBrain = { async handle() { return { reply: 'hi back', action: 'chat' }; } };
    const gateway = new ChannelGateway({ executiveBrain, activityLog });

    const result = await gateway.handle({ channel: 'telephony', userId: '+1555', message: 'call transcript text' });
    assert.equal(result.channel, 'telephony');
    assert.equal(result.reply, 'hi back');
    assert.equal(logged.length, 1);
    assert.equal(logged[0].type, 'channel_request');
    assert.equal(logged[0].detail.channel, 'telephony');
  });
});

describe('Communication tools — honest status when not configured', () => {
  test('send_whatsapp_message and make_phone_call report REQUIRES_API and refuse to run without real credentials', async () => {
    // No WHATSAPP_*/TWILIO_* env vars are set in this test file/process, so
    // both services are genuinely unconfigured — this is the default state
    // for the whole test suite (and for a fresh checkout with no .env).
    const whatsappService = new WhatsAppService();
    const twilioService = new TwilioService();
    assert.equal(whatsappService.isConfigured(), false);
    assert.equal(twilioService.isConfigured(), false);

    const [sendWhatsapp, makeCall] = buildCommunicationTools({ whatsappService, twilioService });
    assert.equal(sendWhatsapp.status, 'REQUIRES_API');
    assert.equal(makeCall.status, 'REQUIRES_API');

    await assert.rejects(
      () => sendWhatsapp.run({ to: '1', message: 'hi' }),
      /not runnable in this environment/,
      'must refuse honestly, never simulate a successful send',
    );
    await assert.rejects(
      () => makeCall.run({ to: '+1' }),
      /not runnable in this environment/,
      'must refuse honestly, never simulate a placed call',
    );
  });
});
