import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  SESSION_KEY, currentSessionId, startNewSession, switchSession, readMessages, recentSessions, saveMessages,
  exchangesToMessages, messagesToExchanges, mergeRemoteSessions, pickNewestMessages, filterRecent, historyKey,
  togglePin, deleteSession,
} from '../public/js/chatSessions.js';

const input = fs.readFileSync(new URL('../public/js/dashboard/CommandInput.js', import.meta.url), 'utf8');
const sw = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/css/command-center.css', import.meta.url), 'utf8');

function fakeStorage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { data.set(k, String(v)); }, removeItem: (k) => data.delete(k), _data: data };
}
beforeEach(() => { globalThis.localStorage = fakeStorage(); });

const msg = (role, content, at = '2026-10-24T10:00:00.000Z') => ({ role, content, at });

test('a question typed in the Command Centre is saved at once and listed under Recent', () => {
  const id = currentSessionId();
  const exchanges = [{ user: 'Plan my week', reply: '', status: 'sending', ts: Date.parse('2026-10-24T10:00:00Z') }];
  assert.equal(saveMessages(id, exchangesToMessages(exchanges)), true);
  assert.deepEqual(readMessages(id).map((m) => m.role), ['user']);
  assert.equal(recentSessions()[0].id, id);
  assert.equal(recentSessions()[0].title, 'Plan my week');
  exchanges[0].reply = 'Here is your plan.'; exchanges[0].status = 'done'; exchanges[0].replyAt = Date.parse('2026-10-24T10:00:05Z');
  assert.equal(saveMessages(id, exchangesToMessages(exchanges)), true);
  assert.deepEqual(readMessages(id).map((m) => m.role), ['user', 'assistant']);
  assert.equal(recentSessions().length, 1);
});

test('opening the Command Centre (an empty view) never wipes a chat saved from the Chat page', () => {
  const id = currentSessionId();
  saveMessages(id, [msg('user', 'Remember this'), msg('assistant', 'Saved.', '2026-10-24T10:00:02.000Z')]);
  assert.equal(saveMessages(id, exchangesToMessages([])), false);
  assert.equal(readMessages(id).length, 2);
  assert.equal(recentSessions().length, 1);
});

test('chat messages survive the round trip into Command Centre cards and back, and merely opening a chat does not reorder Recent', () => {
  const id = currentSessionId();
  const original = [msg('user', 'Hello', '2026-10-24T10:00:00.000Z'), msg('assistant', 'Hi there', '2026-10-24T10:00:03.000Z'), msg('user', 'Unanswered question', '2026-10-24T10:01:00.000Z')];
  saveMessages(id, original);
  const before = JSON.stringify(recentSessions());
  const exchanges = messagesToExchanges(readMessages(id));
  assert.equal(exchanges.length, 2);
  assert.equal(exchanges[0].reply, 'Hi there');
  assert.equal(saveMessages(id, exchangesToMessages(exchanges)), false, 'unchanged conversation is not rewritten');
  assert.equal(JSON.stringify(recentSessions()), before);
  assert.deepEqual(readMessages(id).map((m) => m.at), original.map((m) => m.at), 'original timestamps are kept');
});

test('long conversations are not trimmed by the Command Centre', () => {
  const id = currentSessionId();
  const many = Array.from({ length: 120 }, (_, i) => [msg('user', `q${i}`, `2026-10-24T10:${String(i % 60).padStart(2, '0')}:00.000Z`), msg('assistant', `a${i}`, `2026-10-24T10:${String(i % 60).padStart(2, '0')}:30.000Z`)]).flat();
  saveMessages(id, many);
  const exchanges = messagesToExchanges(readMessages(id));
  assert.equal(exchanges.length, 120);
  assert.equal(exchangesToMessages(exchanges).length, 240);
});

test('Recent chats: newest first, searchable, and a new chat adds no empty entry', () => {
  const a = currentSessionId();
  saveMessages(a, [msg('user', 'Budget for the school project')]);
  const b = startNewSession();
  assert.notEqual(a, b);
  assert.equal(saveMessages(b, exchangesToMessages([])), false);
  assert.equal(recentSessions().length, 1);
  saveMessages(b, [msg('user', 'Whisper speed settings')]);
  assert.deepEqual(recentSessions().map((r) => r.id), [b, a]);
  assert.deepEqual(filterRecent('budget').map((r) => r.id), [a]);
  switchSession(a);
  assert.equal(currentSessionId(), a);
  assert.equal(localStorage.getItem(SESSION_KEY), a);
  assert.equal(readMessages(b).length, 1);
  assert.ok(localStorage.getItem(historyKey(b)));
});

test('server index and newest-copy rules', () => {
  const id = currentSessionId();
  saveMessages(id, [msg('user', 'local only')]);
  const merged = mergeRemoteSessions([{ sessionId: 'phone-chat', title: 'From my phone', updatedAt: '2030-01-01T00:00:00.000Z', count: 4 }, { bad: true }]);
  assert.equal(merged[0].id, 'phone-chat');
  assert.ok(merged.some((r) => r.id === id));
  const local = [msg('user', 'old', '2026-10-24T10:00:00.000Z')];
  const newer = [msg('user', 'old', '2026-10-24T10:00:00.000Z'), msg('assistant', 'newer answer', '2026-10-24T11:00:00.000Z')];
  assert.deepEqual(pickNewestMessages(local, newer), newer);
  assert.equal(pickNewestMessages(newer, local), newer);
  assert.deepEqual(pickNewestMessages([], newer), newer);
  assert.equal(pickNewestMessages(local, []), local);
});

test('Command Centre wiring: shared sessions, immediate save, Recent panel, safe switching', () => {
  assert.match(input, /from '\.\.\/chatSessions\.js'/);
  assert.doesNotMatch(input, /xoft_command_center_history_' \+ sessionId\(\), JSON\.stringify/, 'no more Command-Centre-only copy');
  assert.match(input, /messages\.length && saveMessages\(sessionId\(\), messages\)/);
  assert.match(input, /data-act="recent"/);
  assert.match(input, /data-act="new-chat"/);
  assert.match(input, /data-recent-search/);
  assert.match(input, /if \(store\.get\('chat'\)\.pending\) \{ toast\('XOFT is still answering\. Switch chats/);
  assert.match(input, /slice\(-MAX_EXCHANGES\)/);
  assert.doesNotMatch(input, /slice\(-30\)/);
  assert.match(sw, /'\/js\/chatSessions\.js'/);
  assert.match(css, /\.cc-recent-item\.is-active/);
});

test('pinned chats stay on top and keep their pin when the chat is saved or merged again', () => {
  const a = currentSessionId();
  saveMessages(a, [msg('user', 'old pinned chat')]);
  const b = startNewSession();
  saveMessages(b, [msg('user', 'newer chat')]);
  assert.deepEqual(filterRecent().map((r) => r.id), [b, a]);
  assert.equal(togglePin(a), true);
  assert.deepEqual(filterRecent().map((r) => r.id), [a, b]);
  saveMessages(a, [msg('user', 'old pinned chat'), msg('assistant', 'reply', '2026-10-24T10:05:00.000Z')]);
  mergeRemoteSessions([{ sessionId: a, title: 'old pinned chat', updatedAt: '2026-10-25T00:00:00.000Z' }]);
  assert.equal(recentSessions().find((r) => r.id === a).pinned, true);
  assert.equal(togglePin(a), false);
  assert.equal(recentSessions().find((r) => r.id === a).pinned, undefined);
});

test('a deleted chat is gone from this device and is not brought back by the server list', () => {
  const a = currentSessionId();
  saveMessages(a, [msg('user', 'delete me')]);
  assert.equal(deleteSession(a), true);
  assert.equal(readMessages(a).length, 0);
  assert.equal(localStorage.getItem(historyKey(a)), null);
  assert.equal(recentSessions().some((r) => r.id === a), false);
  mergeRemoteSessions([{ sessionId: a, title: 'delete me', updatedAt: '2030-01-01T00:00:00.000Z' }]);
  assert.equal(recentSessions().some((r) => r.id === a), false);
  saveMessages(a, [msg('user', 'delete me, but I wrote again')]);
  assert.equal(recentSessions().some((r) => r.id === a), true);
});

test('pin/delete wiring, server delete route and low-power mode exist', () => {
  assert.match(input, /data-pin=/);
  assert.match(input, /data-delete=/);
  assert.match(input, /window\.confirm\(/);
  assert.match(input, /api\.del\('\/api\/chats\//);
  const server = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(server, /app\.delete\('\/api\/chats\/:sessionId'/);
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /xoft-lite/);
  assert.match(css, /\.xoft-lite \.cc \*/);
});
