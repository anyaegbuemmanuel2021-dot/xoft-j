import crypto from 'node:crypto';
import { config } from '../config/index.js';

/**
 * Official WhatsApp Cloud API adapter.
 *
 * This adapter is deliberately explicit: without a phone-number id, access
 * token, and app secret it is unavailable rather than pretending to send.
 */
export class WhatsAppService {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetch = fetchImpl;
  }

  isConfigured() {
    return Boolean(config.whatsapp.accessToken && config.whatsapp.phoneNumberId && config.whatsapp.appSecret);
  }

  verifyWebhookToken(token) {
    if (!config.whatsapp.verifyToken || token == null) return false;
    const a = Buffer.from(String(token));
    const b = Buffer.from(String(config.whatsapp.verifyToken));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  verifySignature(rawBody, signatureHeader) {
    if (!config.whatsapp.appSecret || !signatureHeader?.startsWith('sha256=')) return false;
    const expected = crypto.createHmac('sha256', config.whatsapp.appSecret).update(rawBody).digest('hex');
    const provided = signatureHeader.slice(7);
    if (expected.length !== provided.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  }

  async sendText({ to, message }) {
    if (!this.isConfigured()) {
      throw new Error('WhatsAppService: WhatsApp Cloud API is not configured. Set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN, and WHATSAPP_APP_SECRET.');
    }
    const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;
    const res = await this.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsapp.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: message } }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WhatsAppService: Cloud API ${res.status}: ${JSON.stringify(data).slice(0, 1000)}`);
    return {
      provider: 'whatsapp-cloud-api',
      messageId: data?.messages?.[0]?.id ?? null,
      contacts: data?.contacts ?? [],
      raw: data,
    };
  }

  /** Mark a supported Cloud API inbound message as read. */
  async markRead({ messageId }) {
    if (!this.isConfigured()) throw new Error('WhatsApp Cloud API is not configured.');
    if (!messageId || typeof messageId !== 'string') throw new Error('messageId is required');
    const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.whatsapp.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WhatsAppService: mark-read API ${res.status}: ${JSON.stringify(data).slice(0, 700)}`);
    return { provider: 'whatsapp-cloud-api', messageId, status: 'read', raw: data };
  }

  /**
   * Real reachability + credential check: calls the Cloud API's own phone-number
   * lookup rather than assuming isConfigured() means it actually works.
   */
  async checkLive() {
    if (!this.isConfigured()) return { status: 'NOT_CONFIGURED', detail: 'WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_APP_SECRET not set' };
    try {
      const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}?fields=id,display_phone_number`;
      const res = await this.fetch(url, { headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { status: 'AUTH_ERROR', detail: `Cloud API ${res.status}: ${JSON.stringify(data).slice(0, 300)}` };
      return { status: 'LIVE', detail: data.display_phone_number ?? data.id ?? 'reachable' };
    } catch (err) {
      return { status: 'UNREACHABLE', detail: err.message };
    }
  }

  parseWebhook(payload) {
    const messages = [];
    const statuses = [];
    for (const entry of payload?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value;
        const phoneNumberId = value?.metadata?.phone_number_id ?? null;
        for (const status of value?.statuses ?? []) {
          statuses.push({ phoneNumberId, id: status.id ?? null, status: status.status ?? null, timestamp: status.timestamp ?? null, recipientId: status.recipient_id ?? null, errors: status.errors ?? [] });
        }
        for (const message of value?.messages ?? []) {
          if (message?.type !== 'text' || !message?.text?.body || !message?.from) continue;
          messages.push({
            channel: 'whatsapp',
            from: message.from,
            messageId: message.id ?? null,
            timestamp: message.timestamp ?? null,
            phoneNumberId,
            text: message.text.body,
            profileName: value?.contacts?.find((c) => c.wa_id === message.from)?.profile?.name ?? null,
          });
        }
      }
    }
    return { messages, statuses };
  }
}
