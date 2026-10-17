import { googleAuth } from '../GoogleAuth.js';

const BASE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';

function b64urlEncode(str) {
  return Buffer.from(str, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeHeader(headers, name) {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

/**
 * GmailService — real Gmail API v1 calls over REST. Requires Google OAuth
 * credentials (see GoogleAuth.js). Every method throws a specific error if
 * the API call fails; nothing here returns synthetic data.
 */
export class GmailService {
  isConfigured() {
    return googleAuth.isConfigured();
  }

  async _authedFetch(path, options = {}) {
    const token = await googleAuth.getAccessToken();
    const res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`GmailService: API error ${res.status} - ${errText}`);
    }
    return res.json();
  }

  /**
   * @param {string} query Gmail search syntax, e.g. "from:registrar@university.edu is:unread"
   * @param {number} maxResults
   */
  async search(query, maxResults = 10) {
    const listData = await this._authedFetch(
      `/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`
    );
    if (!listData.messages?.length) return [];

    const messages = await Promise.all(
      listData.messages.map((m) =>
        this._authedFetch(`/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`)
      )
    );

    return messages.map((m) => ({
      id: m.id,
      threadId: m.threadId,
      snippet: m.snippet,
      subject: decodeHeader(m.payload.headers, 'Subject'),
      from: decodeHeader(m.payload.headers, 'From'),
      date: decodeHeader(m.payload.headers, 'Date'),
      unread: m.labelIds?.includes('UNREAD') ?? false,
    }));
  }

  async getMessage(messageId) {
    const m = await this._authedFetch(`/messages/${messageId}?format=full`);
    const body = this._extractBody(m.payload);
    return {
      id: m.id,
      subject: decodeHeader(m.payload.headers, 'Subject'),
      from: decodeHeader(m.payload.headers, 'From'),
      date: decodeHeader(m.payload.headers, 'Date'),
      body,
    };
  }

  _extractBody(payload) {
    if (payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }
    const textPart = payload.parts?.find((p) => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, 'base64').toString('utf-8');
    }
    return '(no plain-text body found)';
  }

  /** @param {{to:string, subject:string, body:string}} params */
  async send({ to, subject, body }) {
    const raw = b64urlEncode(
      `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`
    );
    const result = await this._authedFetch('/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    return { messageId: result.id, threadId: result.threadId };
  }
}
