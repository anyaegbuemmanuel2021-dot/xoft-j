// One command to run XOFT entirely on this PC: starts the core server and
// the local device agent together, points the agent at the core it just
// started, and (via AUTO_TRUST_LOCAL) skips the manual trust step — because
// they're the same machine, there's no separate trust boundary to cross.
//
// Usage:  node start-pc.js
// Everything the standalone pieces need (core's .env, pc-agent/config.json)
// still applies if you've already customized them; this just wires
// sensible defaults so a fresh checkout works with zero setup.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const CORE_ENTRY = path.join(ROOT, 'src', 'index.js');
const AGENT_DIR = path.join(ROOT, 'pc-agent');
const AGENT_ENTRY = path.join(AGENT_DIR, 'src', 'index.js');
const AGENT_CONFIG_PATH = path.join(AGENT_DIR, 'config.json');
const PORT = process.env.PORT || 3000;
const CORE_URL = `http://localhost:${PORT}`;

function ensureAgentConfig() {
  if (fs.existsSync(AGENT_CONFIG_PATH)) return;
  const example = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, 'config.example.json'), 'utf-8'));
  example.coreUrl = CORE_URL;
  // If you've set AUTH_API_KEYS for this launch, use the first key so the
  // local agent authenticates automatically — no separate step needed.
  example.apiKey = (process.env.AUTH_API_KEYS ?? '').split(',')[0]?.trim() || '';
  example.deviceName = os.hostname();

  // FULL_ACCESS=true widens allowedRoots to your whole user profile
  // (C:\Users\you on Windows) instead of just Documents\XoftShared.
  //
  // Deliberately NOT the raw system drive root (C:\): that also contains
  // Windows\, Program Files\, and other users' profiles — folders where a
  // misfired or manipulated AI action could touch the OS itself or someone
  // else's files, not just yours. Your user profile is "practically
  // everything you'd ever ask XOFT to find or move" without that category
  // of risk. If you genuinely want the raw drive root too, set
  // ALLOWED_ROOTS_OVERRIDE to a comma-separated list yourself in
  // pc-agent/config.json after first run — that's your call to make
  // explicitly, not a default I'll pick for you.
  const roots = process.env.FULL_ACCESS === 'true'
    ? [os.homedir()]
    : [path.join(os.homedir(), 'Documents', 'XoftShared')];
  example.allowedRoots = roots;
  fs.mkdirSync(roots[0], { recursive: true });
  fs.writeFileSync(AGENT_CONFIG_PATH, JSON.stringify(example, null, 2));
  console.log(`[start-pc] Created pc-agent/config.json — local files reachable by XOFT are limited to:\n  ${roots.join('\n  ')}\n  (edit pc-agent/config.json to change this any time; run with FULL_ACCESS=true for your whole user profile)`);
}

function waitForCore() {
  const headers = {};
  const key = (process.env.AUTH_API_KEYS ?? '').split(',')[0]?.trim();
  if (key) headers['X-API-Key'] = key;
  return new Promise((resolve) => {
    const check = () => {
      fetch(`${CORE_URL}/api/status`, { headers }).then((res) => (res.ok ? resolve() : setTimeout(check, 500))).catch(() => setTimeout(check, 500));
    };
    check();
  });
}

async function main() {
  ensureAgentConfig();

  console.log('[start-pc] Starting XOFT core...');
  const core = spawn(process.execPath, [CORE_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), AUTO_TRUST_LOCAL: 'true' },
    stdio: 'inherit',
  });

  await waitForCore();
  console.log('[start-pc] Core is up. Starting PC agent...');
  const agent = spawn(process.execPath, [AGENT_ENTRY], {
    cwd: AGENT_DIR,
    env: process.env,
    stdio: 'inherit',
  });

  const shutdown = () => {
    core.kill();
    agent.kill();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  core.on('exit', (code) => {
    console.error(`[start-pc] core exited (${code}) — stopping agent too.`);
    agent.kill();
    process.exit(code ?? 1);
  });
}

main();
