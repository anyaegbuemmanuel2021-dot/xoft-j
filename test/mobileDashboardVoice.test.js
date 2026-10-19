import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('Chat has an accessible live voice status indicator with distinct states', () => {
  const chat = read('public/js/views/chat.js');
  const css = read('public/css/app.css');
  for (const state of ['idle', 'listening', 'thinking', 'speaking']) {
    assert.ok(
      css.includes('data-state="' + state + '"') || css.includes('[data-state="' + state + '"]'),
      'missing voice styling for ' + state
    );
  }
  assert.match(chat, /id="xoft-voice-status"/);
  assert.match(chat, /aria-live="polite"/);
  assert.match(chat, /setVoiceStatus\('listening'/);
  assert.match(chat, /setVoiceStatus\('thinking'/);
  assert.match(chat, /xoft:speech-state/);
  assert.match(css, /prefers-reduced-motion/);
});

test('Overview summary links to routes registered through the navigation table', () => {
  const overview = read('public/js/views/overview.js');
  const app = read('public/js/app.js');
  for (const route of ['tasks', 'activity', 'missions', 'memory']) {
    assert.ok(overview.includes('href="#' + route + '"'), 'summary missing ' + route + ' shortcut');
    assert.ok(
      app.includes("['" + route + "',") || app.includes("['" + route + "', '"),
      'route is missing from navigation table: ' + route
    );
  }
  assert.match(app, /for \(const g of NAV\) for \(const \[route, , mod\] of g\.items\) registerRoute\(route, mod\)/);
  assert.match(overview, /api\.get\('\/api\/activity'\)/);
  assert.match(overview, /Work Summary/);
});

test('XOFT mobile web app has PWA metadata and responsive viewport settings', () => {
  const html = read('public/index.html');
  const manifest = JSON.parse(read('public/manifest.json'));
  const sw = read('public/sw.js');
  assert.match(html, /name="viewport"[^>]*viewport-fit=cover/);
  assert.match(html, /rel="manifest" href="\/manifest\.json"/);
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.length > 0);
  assert.match(sw, /xoft-shell-v\d+/);
});
