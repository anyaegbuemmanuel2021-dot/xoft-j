import { JsonStore } from '../persistence/JsonStore.js';

const SIR = 'sir';
const MAAM = "ma'am";

// Explicit self-declarations only. We never guess gender from a name, voice
// pitch, or writing style — that is unreliable and easy to get wrong.
const PATTERNS = [
  { re: /\bcall me\s+(?:["']?)(sir|mister|mr)\b/i, value: SIR },
  { re: /\bcall me\s+(?:["']?)(ma'?am|madam|miss|mrs|ms)\b/i, value: MAAM },
  { re: /\bi(?:'m| am)\s+(?:a\s+)?(man|male|guy|boy|gentleman)\b/i, value: SIR },
  { re: /\bi(?:'m| am)\s+(?:a\s+)?(woman|female|girl|lady)\b/i, value: MAAM },
];

/**
 * AddressModel — decides how XOFT addresses whoever is speaking.
 * XOFT itself is a male persona; the *speaker* is addressed as "sir" or
 * "ma'am" based on a stored per-user profile. Unknown speakers get neutral
 * address until they say (or an admin sets) which they prefer.
 */
export class AddressModel {
  constructor({ dataDir = './data', sqliteStore = null } = {}) {
    this._store = new JsonStore({
      dataDir, fileName: 'address.json', kvKey: 'address',
      defaultValue: { profiles: {} }, sqliteStore,
    });
    this._sessions = new Map(); // sessionId -> userId (in-memory, per run)
  }

  setHonorific(userId, honorific) {
    honorific = String(honorific ?? '').trim().toLowerCase().replace(/[\u2019`]/g, "'");
    if (['madam', 'maam', 'mam'].includes(honorific)) honorific = MAAM;
    if (!userId) throw new Error('userId is required');
    if (![SIR, MAAM].includes(honorific)) throw new Error(`honorific must be "${SIR}" or "${MAAM}"`);
    const data = this._store.load();
    data.profiles[userId] = honorific;
    this._store.save(data);
    return honorific;
  }

  getHonorific(userId) {
    return userId ? this._store.load().profiles[userId] ?? null : null;
  }

  bindSession(sessionId, userId) {
    if (sessionId && userId) this._sessions.set(sessionId, userId);
  }

  /** Learn from an explicit self-declaration in the message, if any. */
  observe(userId, text) {
    if (!userId || !text) return null;
    for (const { re, value } of PATTERNS) {
      if (re.test(text)) return this.setHonorific(userId, value);
    }
    return null;
  }

  describeForPrompt(sessionId) {
    const honorific = this.getHonorific(this._sessions.get(sessionId));
    const persona = 'You are XOFT, a male assistant.';
    if (!honorific) {
      return `${persona} You do not yet know how the person speaking wants to be addressed. Do not guess. Use no honorific; if it comes up naturally, ask once whether they prefer "sir" or "ma'am".`;
    }
    return `${persona} The person speaking is addressed as "${honorific}". Use it naturally (greetings, confirmations, important handoffs) — not in every sentence. If a different person takes over the conversation and says so, switch accordingly.`;
  }
}
