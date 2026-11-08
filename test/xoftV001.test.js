import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('the product is renamed to xoft at version 0.0.1', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'xoft');
  assert.equal(pkg.version, '0.0.1');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.name, 'xoft');
  assert.equal(lock.version, '0.0.1');
  assert.equal(lock.packages[''].version, '0.0.1');
  assert.match(read('android-companion/app/build.gradle'), /versionName '0\.0\.1'/);
});

test('the live voice orb uses the XOFT AI-core artwork and honours reduced motion', () => {
  const css = read('public/css/app.css');
  assert.ok(fs.statSync(path.join(root, 'public/img/xoft-core.webp')).size > 10_000);
  assert.match(css, /\.chat-voice-home \.xoft-voice-orb \{[^}]*url\('\/img\/xoft-core\.webp'\)/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.chat-voice-home \.xoft-voice-orb/);
  for (const state of ['idle', 'listening', 'speaking', 'thinking']) assert.match(css, new RegExp(`data-state="${state}"\\] \\.xoft-voice-orb`));
  const sw = read('public/sw.js');
  assert.match(sw, /\/img\/xoft-core\.webp/);
  assert.match(sw, /\/js\/voice\/native-bridge\.js/);
  assert.match(read('public/js/app.js'), /import '\.\/voice\/native-bridge\.js'/);
});

test('native bridge mirrors live-voice state to the Android companion only when it exists', async () => {
  const seen = [];
  const target = new EventTarget();
  globalThis.window = Object.assign(target, { XoftNative: { onVoiceState: (s) => seen.push(s) } });
  const mod = await import('../public/js/voice/native-bridge.js');
  const fire = (name, detail) => target.dispatchEvent(new CustomEvent(name, { detail }));
  fire('xoft:voice-state', { state: 'listening' });
  fire('xoft:voice-state', { state: 'listening' }); // duplicate is dropped
  fire('xoft:speech-state', { state: 'speaking' });
  fire('xoft:voice-state', { state: 'weird' });      // unknown -> idle
  assert.deepEqual(seen, ['listening', 'speaking', 'idle']);
  window.XoftNative = undefined;
  assert.doesNotThrow(() => mod.pushVoiceState('thinking'));
  delete globalThis.window;
});

test('Android companion declares the floating-bubble service, live activity and permissions', () => {
  const manifest = read('android-companion/app/src/main/AndroidManifest.xml');
  for (const needle of ['SYSTEM_ALERT_WINDOW', 'RECORD_AUDIO', 'FOREGROUND_SERVICE_MICROPHONE', '.LiveActivity', '.XoftBubbleService', 'foregroundServiceType="microphone"']) assert.ok(manifest.includes(needle), needle);
  assert.ok(fs.existsSync(path.join(root, 'android-companion/app/src/main/res/drawable-nodpi/xoft_core.png')));
  const service = read('android-companion/app/src/main/java/com/xoft/companion/XoftBubbleService.kt');
  assert.match(service, /TYPE_APPLICATION_OVERLAY/);
  assert.match(service, /canDrawOverlays/);
  const live = read('android-companion/app/src/main/java/com/xoft/companion/LiveActivity.kt');
  assert.match(live, /onUserLeaveHint/);
  assert.match(live, /addJavascriptInterface\(Bridge\(\), "XoftNative"\)/);
  assert.match(live, /MIXED_CONTENT_NEVER_ALLOW/);
});

test('voice documentation and defaults say Gemini first, OpenAI fallback', () => {
  const env = read('.env.example');
  assert.match(env, /STT_PROVIDER_ORDER=gemini,openai/);
  assert.match(env, /TTS_PROVIDER_ORDER=gemini,openai,elevenlabs/);
  assert.match(read('docs/VOICE_SPEED.md'), /Gemini is the default/);
});

test('the project contains no emoji or pictographic symbols in any UI, script, doc or source file', () => {
  const pictographic = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{23E9}-\u{23FF}\u{FE0F}\u{25A0}-\u{25FF}]/u;
  const allowed = new Set(['docs/HERMES_ENGINE.md', 'docs/SETUP_AND_HOSTING.md', 'docs/DEVICE_RUNTIME.md', 'README.md', 'scripts/verify-command-center.mjs', 'public/js/dashboard/StatusIndicator.js']); // ASCII-art diagrams and a code comment only
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) { walk(rel); continue; }
      if (!/\.(js|mjs|cjs|html|css|md|json|kt|ts|tsx|yml)$/.test(entry.name) || allowed.has(rel)) continue;
      if (pictographic.test(fs.readFileSync(path.join(root, rel), 'utf8'))) offenders.push(rel);
    }
  };
  walk('.');
  assert.deepEqual(offenders, []);
});

test('uniform UI layer is loaded last, cached by the service worker, and sizes controls to their content', () => {
  const html = read('public/index.html');
  assert.ok(html.indexOf('/css/uniform.css') > html.indexOf('/css/command-center.css'));
  assert.match(read('public/sw.js'), /\/css\/uniform\.css/);
  const css = read('public/css/uniform.css');
  assert.match(css, /width: auto !important/);
  assert.match(css, /padding: var\(--u-pad-y\) var\(--u-pad-x\) !important/);
  assert.match(css, /align-items: start/);
});

test('God mode sets the highest autonomy level and the boot sequence has no artificial delay', () => {
  const panel = read('public/js/dashboard/AutonomyPanel.js');
  assert.match(panel, /data-level="5"[^>]*>GOD MODE/);
  assert.match(panel, /api\.post\('\/api\/autonomy'/);
  const boot = read('public/js/dashboard/BootSequence.js');
  assert.match(boot, /const step = 0;/);
  assert.doesNotMatch(boot, /wait\((skipped \|\| reduced \? 150|450)/);
});

test('Claude default is the current Sonnet', () => {
  assert.match(read('src/config/index.js'), /ANTHROPIC_MODEL', 'claude-sonnet-5-5'/);
});
