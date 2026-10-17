import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Small durable inbox for WhatsApp Cloud API messages. This stores only messages
 * delivered to XOFT through its configured business number; it cannot read a
 * personal WhatsApp account's private chat database.
 */
export class WhatsAppInboxStore {
  constructor({ dataDir = './data', maxMessages = 5000 } = {}) {
    this.filePath = path.join(dataDir, 'whatsapp_inbox.json');
    this.maxMessages = maxMessages;
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, JSON.stringify({ messages: [] }, null, 2));
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return { messages: Array.isArray(data.messages) ? data.messages : [] };
    } catch {
      return { messages: [] };
    }
  }

  _save(data) {
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ messages: data.messages.slice(-this.maxMessages) }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  record(input) {
    if (!input || typeof input !== 'object') throw new Error('WhatsAppInboxStore.record requires a message object');
    const data = this._load();
    const id = input.id ?? crypto.randomUUID();
    const index = data.messages.findIndex((m) => m.id === id);
    const record = {
      id,
      channel: 'whatsapp',
      direction: input.direction === 'outbound' ? 'outbound' : 'inbound',
      from: input.from ? String(input.from) : null,
      to: input.to ? String(input.to) : null,
      phoneNumberId: input.phoneNumberId ? String(input.phoneNumberId) : null,
      text: String(input.text ?? '').slice(0, 10000),
      profileName: input.profileName ? String(input.profileName).slice(0, 160) : null,
      timestamp: input.timestamp ?? new Date().toISOString(),
      status: input.status ?? (input.direction === 'outbound' ? 'sent' : 'received'),
      statusUpdatedAt: new Date().toISOString(),
      replyTo: input.replyTo ?? null,
      error: input.error ? String(input.error).slice(0, 500) : null,
    };
    if (index >= 0) data.messages[index] = { ...data.messages[index], ...record };
    else data.messages.push(record);
    this._save(data);
    return record;
  }

  updateStatus(messageId, status, extra = {}) {
    const data = this._load();
    const record = [...data.messages].reverse().find((m) => m.id === messageId);
    if (!record) return null;
    record.status = String(status ?? record.status);
    record.statusUpdatedAt = new Date().toISOString();
    if (extra.error) record.error = String(extra.error).slice(0, 500);
    this._save(data);
    return record;
  }

  list({ contact, limit = 100, before } = {}) {
    const data = this._load().messages;
    const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
    return data.filter((m) => (!contact || m.from === String(contact) || m.to === String(contact)) && (!before || m.timestamp < before))
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, bounded);
  }

  conversation(contact, { limit = 200 } = {}) {
    const data = this._load().messages.filter((m) => m.from === String(contact) || m.to === String(contact));
    return data.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).slice(-Math.max(1, Math.min(500, Number(limit) || 200)));
  }

  get(messageId) {
    return this._load().messages.find((m) => m.id === messageId) ?? null;
  }

  summary() {
    const messages = this._load().messages;
    return {
      total: messages.length,
      inbound: messages.filter((m) => m.direction === 'inbound').length,
      outbound: messages.filter((m) => m.direction === 'outbound').length,
      lastMessageAt: messages.reduce((latest, m) => !latest || String(m.timestamp) > latest ? String(m.timestamp) : latest, null),
    };
  }
}
