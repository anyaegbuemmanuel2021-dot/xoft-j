// chatSessions.js - the single source of truth for saved chat sessions.
//
// The Chat page and the Command Centre both talk to XOFT, so both must read and write the SAME conversation
// under the SAME session, and both must list it under "Recent chats". Messages are stored as
// { role: 'user' | 'assistant', content, at } under `xoft_chat_history_<sessionId>`, and the list of recent
// sessions lives under `xoft_recent_chat_sessions_v1`. Nothing here calls an AI model or uses credits.

export const SESSION_KEY = 'xoft_chat_session';
export const RECENT_KEY = 'xoft_recent_chat_sessions_v1';
export const DELETED_KEY = 'xoft_deleted_chat_sessions_v1'; // so a chat deleted here is not re-added from the server index
export const MAX_MESSAGES = 300;
const MAX_RECENT = 100;

function readJson(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? 'null');
    return parsed ?? fallback;
  } catch { return fallback; }
}

function validMessage(m) {
  return Boolean(m) && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim() !== '';
}

export function historyKey(id) { return 'xoft_chat_history_' + id; }

export function currentSessionId() {
  let id = null;
  try { id = localStorage.getItem(SESSION_KEY); } catch { /* storage unavailable */ }
  if (!id) {
    id = crypto.randomUUID();
    try { localStorage.setItem(SESSION_KEY, id); } catch { /* storage unavailable */ }
  }
  return id;
}

export function switchSession(id) {
  try { localStorage.setItem(SESSION_KEY, id); } catch { /* storage unavailable */ }
  return id;
}

export function startNewSession() {
  return switchSession(crypto.randomUUID());
}

export function readMessages(id = currentSessionId()) {
  const stored = readJson(historyKey(id), []);
  return Array.isArray(stored) ? stored.filter(validMessage).slice(-MAX_MESSAGES) : [];
}

export function recentSessions() {
  const list = readJson(RECENT_KEY, []);
  return Array.isArray(list) ? list.filter((item) => item && typeof item.id === 'string') : [];
}

export function titleFor(messages) {
  const first = messages.find((m) => m.role === 'user');
  return String(first?.content || 'New chat').replace(/\s+/g, ' ').trim().slice(0, 44) || 'New chat';
}

/** Pinned chats first, then newest first. */
export function filterRecent(query = '') {
  const q = String(query).trim().toLowerCase();
  const items = recentSessions().filter((item) => !q || String(item.title || '').toLowerCase().includes(q));
  return [...items.filter((item) => item.pinned), ...items.filter((item) => !item.pinned)];
}

function deletedIds() {
  const list = readJson(DELETED_KEY, []);
  return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : [];
}

export function togglePin(id) {
  const list = recentSessions();
  const item = list.find((entry) => entry.id === id);
  if (!item) return false;
  item.pinned = !item.pinned;
  if (!item.pinned) delete item.pinned;
  writeRecent(list);
  return Boolean(item.pinned);
}

/** Removes a chat from this device. Returns true if it existed. The caller also asks the server to forget it. */
export function deleteSession(id) {
  const list = recentSessions();
  const existed = list.some((entry) => entry.id === id) || readMessages(id).length > 0;
  try { localStorage.removeItem(historyKey(id)); localStorage.removeItem('xoft_command_center_history_' + id); } catch { /* storage unavailable */ }
  writeRecent(list.filter((entry) => entry.id !== id));
  try { localStorage.setItem(DELETED_KEY, JSON.stringify([id, ...deletedIds().filter((x) => x !== id)].slice(0, 200))); } catch { /* storage full */ }
  return existed;
}

function sameConversation(a, b) {
  if (a.length !== b.length) return false;
  return a.every((m, i) => m.role === b[i].role && m.content === b[i].content);
}

function writeRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT))); } catch { /* storage full */ }
}

/**
 * Saves a conversation and puts it at the top of Recent chats.
 * - An empty list never overwrites saved history (an empty view must not erase a chat).
 * - An unchanged conversation is not rewritten and does not jump to the top (merely OPENING a chat is not activity).
 * @returns {boolean} true when something new was saved
 */
export function saveMessages(id, messages) {
  const clean = (Array.isArray(messages) ? messages : []).filter(validMessage).slice(-MAX_MESSAGES);
  if (!clean.length) return false;
  const existing = readMessages(id);
  const recent = recentSessions();
  const pinned = recent.find((item) => item.id === id)?.pinned ? { pinned: true } : {};
  if (sameConversation(existing, clean)) {
    if (!recent.some((item) => item.id === id)) {
      writeRecent([{ id, title: titleFor(clean), updatedAt: clean.at(-1)?.at || new Date().toISOString(), ...pinned }, ...recent]);
    }
    return false;
  }
  try { localStorage.setItem(historyKey(id), JSON.stringify(clean)); } catch { return false; }
  writeRecent([{ id, title: titleFor(clean), updatedAt: new Date().toISOString(), ...pinned }, ...recent.filter((item) => item.id !== id)]);
  if (deletedIds().includes(id)) { try { localStorage.setItem(DELETED_KEY, JSON.stringify(deletedIds().filter((x) => x !== id))); } catch { /* ignore */ } }
  return true;
}

/** Merges the server's chat index (other devices/browsers) into the local Recent list. */
export function mergeRemoteSessions(remote) {
  const merged = new Map(recentSessions().map((item) => [item.id, item]));
  const deleted = new Set(deletedIds());
  for (const item of Array.isArray(remote) ? remote : []) {
    if (!item || typeof item.sessionId !== 'string' || deleted.has(item.sessionId)) continue;
    const current = merged.get(item.sessionId);
    merged.set(item.sessionId, {
      id: item.sessionId,
      title: item.title || current?.title || 'Saved chat',
      updatedAt: item.updatedAt || current?.updatedAt || new Date().toISOString(),
      ...(current?.pinned ? { pinned: true } : {}),
    });
  }
  const sorted = [...merged.values()].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  writeRecent(sorted);
  return sorted.slice(0, MAX_RECENT);
}

/** Newest copy wins: the server copy replaces the local one only when it is newer (or local is empty). */
export function pickNewestMessages(local, remote, remoteUpdatedAt = '') {
  const cleanRemote = (Array.isArray(remote) ? remote : []).filter(validMessage).slice(-MAX_MESSAGES);
  if (!cleanRemote.length) return local;
  if (!local.length) return cleanRemote;
  const localLast = Date.parse(local.at(-1)?.at || '') || 0;
  const remoteLast = Date.parse(cleanRemote.at(-1)?.at || remoteUpdatedAt || '') || 0;
  return remoteLast > localLast ? cleanRemote : local;
}

/** Command Centre exchanges -> chat messages. The question is saved immediately, before XOFT has answered. */
export function exchangesToMessages(exchanges) {
  const out = [];
  for (const x of Array.isArray(exchanges) ? exchanges : []) {
    if (!x) continue;
    const at = new Date(Number(x.ts) || Date.now()).toISOString();
    const user = String(x.user ?? '').trim();
    if (user) out.push({ role: 'user', content: user, at });
    if (x.status === 'sending') continue;
    const reply = x.status === 'queued' ? String(x.reply || 'Queued offline.') : String(x.reply ?? '');
    if (reply.trim()) out.push({ role: 'assistant', content: reply, at: new Date(Number(x.replyAt) || Number(x.ts) || Date.now()).toISOString() });
  }
  return out.slice(-MAX_MESSAGES);
}

/** Chat messages -> Command Centre exchanges (a question and its answer per card). */
export function messagesToExchanges(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!validMessage(m)) continue;
    const ts = Date.parse(m.at) || Date.now();
    if (m.role === 'user') {
      out.push({ user: m.content, reply: '', status: 'done', ts });
    } else {
      const last = out[out.length - 1];
      if (last && last.user && !last.reply) { last.reply = m.content; last.replyAt = ts; }
      else out.push({ user: '', reply: m.content, status: 'done', ts, replyAt: ts });
    }
  }
  return out;
}
