#!/usr/bin/env node
// Trips XOFT's kill switch without going through the HTTP API at all — no
// API key, no dashboard, no network call. Works as long as xoft-core's
// process is alive and its data directory is reachable on this filesystem
// (see src/security/KillSwitch.js for exactly what "independent" means and
// its honest limit).
//
// Usage:
//   node scripts/kill-switch.mjs stop                 # trip the switch
//   node scripts/kill-switch.mjs clear                 # remove the sentinel (does NOT deactivate emergency stop by itself — use the API/dashboard for that, or restart)
//   node scripts/kill-switch.mjs stop --data-dir=./data

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const action = args[0];
const dataDirArg = args.find((a) => a.startsWith('--data-dir='));
const dataDir = dataDirArg ? dataDirArg.split('=')[1] : (process.env.MEMORY_DATA_DIR || './data');
const sentinel = path.join(dataDir, 'KILL');

if (action === 'stop') {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(sentinel, `killed at ${new Date().toISOString()} via kill-switch.mjs\n`);
  console.log(`Wrote kill sentinel: ${sentinel}`);
  console.log('XOFT will trip emergency stop within its poll interval (default 3s) if the process is running.');
} else if (action === 'clear') {
  try { fs.unlinkSync(sentinel); console.log(`Removed: ${sentinel}`); }
  catch { console.log('No sentinel file present.'); }
} else {
  console.error('Usage: node scripts/kill-switch.mjs <stop|clear> [--data-dir=./data]');
  process.exit(1);
}
