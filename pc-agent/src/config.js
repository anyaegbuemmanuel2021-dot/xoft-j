const fs = require('fs');
const path = require('path');
const os = require('os');

// When packaged with pkg, process.cwd() is where the .exe was launched from
// (not inside the virtual snapshot filesystem) — that's exactly where we
// want config.json and pairing.json to live: next to the executable, edited
// by hand or a future setup wizard.
const BASE_DIR = process.cwd();
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const EXAMPLE_PATH = path.join(__dirname, '..', 'config.example.json');
const PAIRING_PATH = path.join(BASE_DIR, 'pairing.json');

function expandUsername(str) {
  return typeof str === 'string' ? str.replace(/%USERNAME%/gi, os.userInfo().username) : str;
}

function ensureConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const example = fs.readFileSync(EXAMPLE_PATH, 'utf-8');
    fs.writeFileSync(CONFIG_PATH, example);
    console.log(`No config.json found — created one from the template at:\n  ${CONFIG_PATH}`);
    console.log('Edit it (coreUrl, allowedRoots, appAllowlist) before running the agent for real, then run again.');
    process.exit(0);
  }
}

function loadConfig() {
  ensureConfig();
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  const allowedRoots = (raw.allowedRoots ?? []).map((p) => path.resolve(expandUsername(p)));
  const appAllowlist = {};
  for (const [name, def] of Object.entries(raw.appAllowlist ?? {})) {
    appAllowlist[name.toLowerCase()] = { path: expandUsername(def.path), processName: def.processName };
  }
  return {
    coreUrl: (raw.coreUrl ?? 'http://localhost:3000').replace(/\/$/, ''),
    apiKey: raw.apiKey || process.env.XOFT_API_KEY || null,
    // A per-device token (issued when xoft-core trusts this device — see
    // pairing.js) is scoped to this device only, unlike apiKey (the shared
    // admin secret). Preferred whenever both are present.
    deviceToken: raw.deviceToken || process.env.XOFT_DEVICE_TOKEN || null,
    deviceName: raw.deviceName ?? os.hostname(),
    heartbeatIntervalMs: raw.heartbeatIntervalMs ?? 30000,
    pollIntervalMs: raw.pollIntervalMs ?? 3000,
    stateReportIntervalMs: raw.stateReportIntervalMs ?? 60000,
    allowedRoots,
    appAllowlist,
    // --- Device Runtime (all optional; safe defaults) ---
    stateDir: path.resolve(expandUsername(raw.stateDir ?? path.join(BASE_DIR, '.xoft'))),
    configPath: CONFIG_PATH,
    pairingPath: PAIRING_PATH,
    // Workspaces are the ONLY places file/terminal work can touch. Only a human edits this list (or uses --add-workspace).
    workspaces: (raw.workspaces ?? []).map((w) => ({ name: w.name, root: path.resolve(expandUsername(w.root)) })),
    policy: raw.policy ?? {},
    maxMutationsPerMinute: raw.maxMutationsPerMinute ?? 120,
    browser: raw.browser ?? {},
  };
}

function loadPairing() {
  if (!fs.existsSync(PAIRING_PATH)) return null;
  return JSON.parse(fs.readFileSync(PAIRING_PATH, 'utf-8'));
}

function savePairing(pairing) {
  fs.writeFileSync(PAIRING_PATH, JSON.stringify(pairing, null, 2));
}

module.exports = { loadConfig, loadPairing, savePairing, CONFIG_PATH, PAIRING_PATH };
