import crypto from 'node:crypto';
import { config } from '../config/index.js';

/** Official Twilio REST + webhook adapter for XOFT voice calls. */
export class TwilioService {
  constructor({ fetchImpl = fetch } = {}) { this.fetch = fetchImpl; }

  isConfigured() {
    return Boolean(config.twilio.accountSid && config.twilio.authToken && config.twilio.fromNumber && config.twilio.publicBaseUrl && config.twilio.voiceWebhookUrl && config.twilio.voiceResponseUrl);
  }

  validateSignature(url, params, signature) {
    if (!config.twilio.authToken || !signature) return false;
    const data = Object.keys(params ?? {}).sort().reduce((s, key) => `${s}${key}${params[key]}`, url);
    const digest = crypto.createHmac('sha1', config.twilio.authToken).update(data).digest('base64');
    const a = Buffer.from(digest);
    const b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async createCall({ to, statusCallbackUrl = config.twilio.statusCallbackUrl } = {}) {
    if (!this.isConfigured()) {
      throw new Error('TwilioService: telephony is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, and TWILIO_VOICE_WEBHOOK_URL.');
    }
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilio.accountSid)}/Calls.json`;
    const params = new URLSearchParams({ To: to, From: config.twilio.fromNumber, Url: config.twilio.voiceWebhookUrl });
    if (statusCallbackUrl) params.set('StatusCallback', statusCallbackUrl);
    const basic = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`TwilioService: Calls API ${res.status}: ${JSON.stringify(data).slice(0, 1000)}`);
    return { provider: 'twilio', callSid: data.sid ?? null, status: data.status ?? null, raw: data };
  }

  /** Real reachability + credential check against Twilio's own Account resource. */
  async checkLive() {
    if (!this.isConfigured()) return { status: 'NOT_CONFIGURED', detail: 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER / webhook URLs not set' };
    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilio.accountSid)}.json`;
      const basic = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
      const res = await this.fetch(url, { headers: { Authorization: `Basic ${basic}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { status: 'AUTH_ERROR', detail: `Accounts API ${res.status}: ${JSON.stringify(data).slice(0, 300)}` };
      return { status: 'LIVE', detail: data.status ?? data.friendly_name ?? 'reachable' };
    } catch (err) {
      return { status: 'UNREACHABLE', detail: err.message };
    }
  }

  buildVoicePrompt({ greeting = 'Hello. You are connected to XOFT. How can I help you?' } = {}) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="speech" action="${esc(config.twilio.voiceResponseUrl)}" method="POST" speechTimeout="auto"><Say>${esc(greeting)}</Say></Gather><Say>Goodbye.</Say><Hangup/></Response>`;
  }

  buildVoiceResponse(text) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="speech" action="${esc(config.twilio.voiceResponseUrl)}" method="POST" speechTimeout="auto"><Say>${esc(text)}</Say></Gather><Say>I didn't hear anything else. Goodbye.</Say><Hangup/></Response>`;
  }
}
