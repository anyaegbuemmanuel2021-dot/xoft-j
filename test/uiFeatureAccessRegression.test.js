import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Live Conversation keeps dictation, live video and the voice conversation controls reachable', () => {
  const chat = read('public/js/views/chat.js');
  for (const id of ['chat-mic', 'chat-live-video', 'chat-voice-conversation', 'chat-voice-end']) {
    assert.match(chat, new RegExp('id="' + id + '"'), id + ' must remain available');
  }
  assert.match(chat, /onDelegate\(container, 'click', '#chat-mic'/);
  assert.match(chat, /onDelegate\(container, 'click', '#chat-live-video'/);
  assert.match(chat, /onDelegate\(container, 'click', '#chat-speak-toggle'/);
});

test('recent chats remain searchable in the shared navigation drawer', () => {
  const shell = read('public/index.html');
  const chat = read('public/js/views/chat.js');
  assert.match(shell, /id="nav-recent-chat-search"/);
  assert.match(shell, /id="nav-recent-chat-list"/);
  assert.match(chat, /data-nav-recent-session/);
  assert.match(chat, /nav-recent-chat-search/);
});

test('every workspace, including Command Center, keeps the shared page navigation available', () => {
  const app = read('public/js/app.js');
  const shell = read('public/css/command-center.css');
  const shared = read('public/css/app.css');
  assert.match(app, /id="nav-toggle"/);
  assert.match(app, /href="#tasks"/);
  assert.match(app, /href="#memory"/);
  assert.match(shared, /body\.nav-open #sidebar/);
  assert.doesNotMatch(shell, /body\[data-route="command"\] #sidebar,\s*body\[data-route="command"\] #topbar \{ display: none; \}/);
});

test('Live Conversation composer uses compact readable text sizing and does not hide video', () => {
  const css = read('public/css/app.css');
  assert.match(css, /\.chat-voice-home #chat-input-row textarea\s*\{[^}]*font:400 14px\/1\.45 system-ui,sans-serif/);
  assert.doesNotMatch(css, /\.chat-voice-home #chat-input-row #chat-live-video[^}]*display:none/);
});
