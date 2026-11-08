'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * Locates and launches Chrome/Chromium with a loopback-only debugging port.
 * NOTE: since Chrome 136 the --remote-debugging-port flag is ignored when the default
 * user-data-dir is used, so XOFT always launches with a dedicated profile directory.
 * To attach to your everyday Chrome instead, start it yourself with
 * --remote-debugging-port=9222 --user-data-dir=<non-default dir>. (REQUIRES LOCAL TESTING.)
 */
function chromeCandidates(platform = process.platform, env = process.env) {
  if (env.XOFT_CHROME_PATH) return [env.XOFT_CHROME_PATH];
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(Boolean);
    return roots.flatMap((r) => [path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(r, 'Chromium', 'Application', 'chrome.exe'), path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]);
  }
  if (platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
}

function findChrome({ platform, env, exists = fs.existsSync } = {}) {
  return chromeCandidates(platform, env).find((p) => exists(p)) ?? null;
}

function buildLaunchArgs({ port, profileDir, headless = false }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid debugging port');
  if (!profileDir) throw new Error('A dedicated profileDir is required');
  const args = [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check'];
  if (headless) args.push('--headless=new');
  return args;
}

/** Spawns the browser detached. Returns { pid, executable, args }. Does not wait for readiness — BrowserController polls /json/version. */
function launchChrome({ port, profileDir, headless, executable, spawnImpl = spawn, existsImpl = fs.existsSync } = {}) {
  const exe = executable ?? findChrome({ exists: existsImpl });
  if (!exe) throw new Error('No Chrome/Chromium executable found. Install one or set XOFT_CHROME_PATH.');
  const args = buildLaunchArgs({ port, profileDir, headless });
  const child = spawnImpl(exe, args, { detached: true, stdio: 'ignore' });
  child.unref?.();
  return { pid: child.pid ?? null, executable: exe, args };
}

module.exports = { chromeCandidates, findChrome, buildLaunchArgs, launchChrome };
