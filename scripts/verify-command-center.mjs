#!/usr/bin/env node
// verify-command-center.mjs — real-browser check of the Command Center UI.
//
// WHAT THIS IS: it serves the REAL ./public files (real HTML/CSS/JS) from a
// small STUB backend that emulates the XOFT REST + /ws contract, then drives
// Chromium with Playwright at desktop/tablet/mobile sizes.
// WHAT THIS IS NOT: it is not the real XOFT server. It proves the frontend
// renders and reacts correctly to that contract; it does not prove the real
// backend returns it. Run the real server for that (see the report).
//
// Usage:  node scripts/verify-command-center.mjs [--shots /tmp/shots]
// Needs:  `ws` (a project dependency) and Playwright with Chromium
//         (set PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs if not resolvable).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const shotsDir = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

let pw;
try { pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright'); } catch { pw = await import('/home/claude/.npm-global/lib/node_modules/playwright/index.mjs'); }
const { chromium } = pw.default ?? pw;

// ---------------- stub backend ----------------
const API_KEY = 'test-key-123';
const state = { requireKey: false, chatDelayMs: 0, chats: [], fetches: {}, approvalCalls: [], headersSeen: [], tasks: [], approvals: [], providerDegraded: true, emergency: false, calls: [],
  missions: [
    { id: 'ms1', goal: 'Keep my website healthy', status: 'planned', priority: 4, deadline: null, budget: { maxRuns: 5, maxFailures: 3 }, usage: { runs: 1, failures: 0 }, pausedReason: null },
    { id: 'ms2', goal: 'Research 20 companies', status: 'paused', budget: { maxRuns: 2, maxFailures: 3 }, usage: { runs: 2, failures: 1 }, pausedReason: 'budget_exhausted: runs (2/2)' },
  ] };
const providers = () => [
  { id: 'openai', label: 'OpenAI', configured: false, status: 'NOT_CONFIGURED', model: 'gpt-4.1', avgLatencyMs: null, calls: 0, failures: 0, switchable: false },
  { id: 'gemini', label: 'Gemini', configured: false, status: 'NOT_CONFIGURED', model: 'gemini-2.0-flash', avgLatencyMs: null, calls: 0, failures: 0, switchable: false },
  { id: 'claude', label: 'Claude', configured: true, status: 'AVAILABLE', model: 'claude-sonnet-4-6', avgLatencyMs: 812, calls: 9, failures: 0, switchable: false },
  { id: 'grok', label: 'Grok', configured: false, status: 'NOT_CONFIGURED', model: 'grok-4', avgLatencyMs: null, calls: 0, failures: 0, switchable: false },
  { id: 'ollama', label: 'Ollama', configured: false, status: 'NOT_CONFIGURED', model: 'llama3.1', avgLatencyMs: null, calls: 0, failures: 0, switchable: false },
  { id: 'experiential', label: 'Experiential Labs', configured: true, status: state.providerDegraded ? 'DEGRADED' : 'AVAILABLE', model: 'gpt-5.6-luna', avgLatencyMs: state.providerDegraded ? null : 400, calls: 5, failures: 2, switchable: true },
];
let cpu = 30;
const routes = {
  'GET /healthz': () => ({ ok: true, service: 'xoft-core' }),
  'GET /api/status': () => ({ configuredProviders: ['claude', 'experiential'], integrations: {}, localModel: { enabled: false, reachable: false }, vectorMemoryEnabled: true, emergencyStop: { active: state.emergency }, autonomy: { level: 2, label: 'APPROVAL' }, proactiveSuggestions: 1, activeMissions: 0, modelHealth: {}, localDeviceId: 'dev-local' }),
  'GET /api/system/telemetry': () => ({ ts: new Date().toISOString(), cpu: { percent: (cpu += 7) % 100, cores: 8, load1: 0.7 }, memory: { totalBytes: 16e9, usedBytes: 9.9e9, usedPercent: 62 }, storage: { totalBytes: 5e11, usedBytes: 2e11, usedPercent: 40 }, uptime: { processSeconds: 3725, hostSeconds: 99999 }, platform: 'linux x64', node: 'v22' }),
  'GET /api/providers/overview': () => providers(),
  'GET /api/tasks': () => state.tasks,
  'GET /api/approvals': () => state.approvals,
  'GET /api/memory': () => [{ id: 'm1', category: 'preference', content: 'Prefers concise answers' }, { id: 'm2', category: 'fact', content: 'Works on Afrisocial' }],
  'GET /api/knowledge-graph/stats': () => ({ nodeCount: 12, edgeCount: 20 }),
  'GET /api/devices': () => [{ id: 'd1', name: 'PC', online: true }],
  'GET /api/activity': () => [{ id: 'a1', ts: new Date().toISOString(), type: 'event_task_failed', detail: { error: 'boom' } }, { id: 'a2', ts: new Date().toISOString(), type: 'tool_executed' }, { id: 'a3', ts: new Date().toISOString(), type: 'ai_model_selected', detail: { model: 'x' } }],
  'GET /api/missions': () => state.missions,
  'GET /api/missions/next': () => ({ next: { id: 'ms1', goal: 'Keep my website healthy', score: 85, reasons: ['priority 4'] }, ranked: [], skipped: [] }),
  'GET /api/autonomy/policy': () => ({ level: 2, label: 'APPROVAL', emergencyStop: { active: state.emergency }, privacyRouting: false, policy: [
    { risk: 'SAFE', decision: 'auto' }, { risk: 'LOW', decision: 'approval_required' }, { risk: 'EXTERNAL', decision: 'approval_required' }, { risk: 'HIGH_IMPACT', decision: 'approval_always' }] }),
  'GET /api/diagnostics': () => ({ overall: state.providerDegraded ? 'DEGRADED' : 'HEALTHY', ts: new Date().toISOString(), checks: [
    { name: 'memory', level: 'HEALTHY', detail: '62% used' }, { name: 'providers', level: state.providerDegraded ? 'DEGRADED' : 'HEALTHY', detail: '1 degraded of 2' }, { name: 'websocket', level: 'HEALTHY', detail: '1 client(s)' }] }),
  'GET /api/tools': () => [{ name: 'a' }, { name: 'b' }],
  'GET /api/ai/models': () => ({ provider: 'experiential', models: [{ id: 'gpt-5.6-luna' }, { id: 'other-model' }] }),
};
const wss = new WebSocketServer({ noServer: true });
const broadcast = (type, payload = {}) => { const m = JSON.stringify({ type, payload, ts: new Date().toISOString() }); wss.clients.forEach((c) => c.send(m)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = `${req.method} ${url.pathname}`;
  state.fetches[key] = (state.fetches[key] ?? 0) + 1;
  if (url.pathname.startsWith('/api/')) {
    state.headersSeen.push(req.headers['x-api-key'] ?? null);
    if (state.requireKey && req.headers['x-api-key'] !== API_KEY) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"Missing or invalid API key"}'); }
  }
  const body = await new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });
  const send = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const b = JSON.parse(body); state.chats.push(b);
    await new Promise((r) => setTimeout(r, state.chatDelayMs));
    if (b.message === 'explode') return send({ error: 'provider down' }, 500);
    if (b.message.startsWith('plan')) return send({ action: 'goal', reply: 'I can do that in 3 steps. Confirm?', meta: { task: { id: 't-plan' }, awaitingConfirmation: true } });
    return send({ action: 'chat', reply: `echo: ${b.message}` });
  }
  const ap = url.pathname.match(/^\/api\/approvals\/([^/]+)\/(approve|reject)$/);
  if (req.method === 'POST' && ap) { state.approvalCalls.push([ap[1], ap[2]]); state.approvals = []; return send({ approval: { id: ap[1] } }); }
  const mp = url.pathname.match(/^\/api\/missions\/([^/]+)\/(pause|resume|cancel)$/);
  if (req.method === 'POST' && mp) { state.calls.push([mp[2], mp[1], body ? JSON.parse(body) : null]); const m = state.missions.find((x) => x.id === mp[1]); if (mp[2] === 'pause') { m.status = 'paused'; m.pausedReason = 'paused from dashboard'; } if (mp[2] === 'resume') { m.status = 'planned'; m.pausedReason = null; if (body && JSON.parse(body).extendBudget) m.budget = { ...m.budget, ...JSON.parse(body).extendBudget }; } if (mp[2] === 'cancel') m.status = 'cancelled'; return send(m); }
  if (req.method === 'POST' && url.pathname === '/api/emergency-stop/activate') { state.emergency = true; state.calls.push(['estop-on', JSON.parse(body || '{}').reason]); return send({ active: true }); }
  if (req.method === 'POST' && url.pathname === '/api/emergency-stop/deactivate') { state.emergency = false; state.calls.push(['estop-off']); return send({ active: false }); }
  if (req.method === 'POST' && url.pathname === '/api/ai/model') return send({ provider: 'experiential', model: JSON.parse(body).model });
  if (routes[key]) return send(routes[key]());
  // static files from the real ./public
  let file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'text/plain' });
  fs.createReadStream(file).pipe(res);
});
server.on('upgrade', (req, sock, head) => { if (req.url.startsWith('/ws')) wss.handleUpgrade(req, sock, head, (ws) => { wss.emit('connection', ws); ws.send(JSON.stringify({ type: 'connected' })); }); else sock.destroy(); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---------------- harness ----------------
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  -> ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();

async function open(viewport, { reducedMotion = 'no-preference', isMobile = false, fresh = true, ctxOpts = {} } = {}) {
  const ctx = await browser.newContext({ viewport, reducedMotion, isMobile, hasTouch: isMobile, ...ctxOpts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/401|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  return { ctx, page, errors };
}
const rect = async (page, sel) => page.locator(sel).first().boundingBox();
const coreState = (page) => page.locator('.cc-core').getAttribute('data-state');
const waitState = (page, s, t = 4000) => page.waitForFunction((x) => document.querySelector('.cc-core')?.dataset.state === x, s, { timeout: t });

try {
  // ===== 1. desktop: first load, boot sequence, 3-column layout =====
  {
    const { ctx, page, errors } = await open({ width: 1440, height: 900 });
    await page.goto(BASE + '/');
    await page.waitForSelector('.cc-boot', { timeout: 3000 });
    const bootText = await page.locator('.cc-boot').innerText();
    check('boot: initialization sequence shows real check lines', /INITIALIZING CORE/.test(bootText));
    await page.waitForSelector('.cc-boot', { state: 'detached', timeout: 8000 });
    check('boot: overlay finishes and dashboard is usable', await page.locator('#cc-input').isVisible());
    check('boot: preference stored for returning users', (await page.evaluate(() => localStorage.getItem('xoft_boot_seen'))) === '1');
    check('route: "/" opens the Command Center as the primary screen', (await page.evaluate(() => document.body.dataset.route)) === 'command');
    check('legacy sidebar hidden in command view', !(await page.locator('#sidebar').isVisible()));

    const l = await rect(page, '.cc-p-system'); const c = await rect(page, '.cc-core'); const r = await rect(page, '.cc-p-task');
    check('desktop: left panels | core | right panels are three columns', l.x + l.width <= c.x + 2 && c.x + c.width <= r.x + 2, JSON.stringify({ lx: l.x, cx: c.x, rx: r.x }));
    const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    check('desktop: no horizontal overflow', noScroll);
    check('topbar: XOFT / AI OPERATING SYSTEM / ● ONLINE', /XOFT/.test(await page.locator('.cc-brand').innerText()) && /AI OPERATING SYSTEM/.test(await page.locator('.cc-brand').innerText()) && /ONLINE/.test(await page.locator('[data-overall]').innerText()));
    check('topbar: shows network, current model, notification count', /LIVE/.test(await page.locator('[data-net]').innerText()) && /gpt-5\.6-luna/.test(await page.locator('[data-model]').innerText()) && (await page.locator('[data-notif-count]').innerText()) === '1');

    // real data bound to panels
    await page.waitForFunction(() => /\d+%/.test(document.querySelector('[data-mount="system"]')?.innerText ?? ''));
    const sys = await page.locator('[data-mount="system"]').innerText();
    check('system status: CPU/MEMORY/STORAGE/NETWORK/UPTIME/SERVER from telemetry endpoint', /CPU/.test(sys) && /62%/.test(sys) && /40%/.test(sys) && /1h 2m/.test(sys) && /SERVER/.test(sys) && /NETWORK/.test(sys));
    const provText = await page.locator('[data-mount="providers"]').innerText();
    check('providers: all six listed', ['OpenAI', 'Gemini', 'Claude', 'Grok', 'Ollama', 'Experiential Labs'].every((n) => provText.includes(n)));
    check('providers: degraded provider shows DEGRADED + latency unavailable', /Experiential Labs[\s\S]*DEGRADED/.test(provText) && /unavailable/.test(provText));
    check('providers: healthy provider shows model + latency', /claude-sonnet-4-6 · 812 ms/.test(provText));
    await page.locator('[data-prov="experiential"]').click();
    check('providers: click expands controls incl. RETRY CHECK + SWITCH MODEL + OPEN SETTINGS', (await page.locator('[data-act="retry"]').count()) === 1 && (await page.locator('[data-act="load-models"]').count()) === 1 && (await page.locator('[data-act="settings"]').count()) === 1);
    await page.locator('[data-act="load-models"]').click();
    await page.waitForSelector('[data-model-select] option:nth-child(2)', { state: 'attached' });
    await page.selectOption('[data-model-select]', 'other-model');
    await page.locator('[data-act="apply-model"]').click();
    await sleep(300);
    check('providers: SWITCH MODEL calls existing POST /api/ai/model', (state.fetches['POST /api/ai/model'] ?? 0) === 1);
    const mem = await page.locator('[data-mount="memory"]').innerText();
    check('memory panel: status, count, graph, recent, OPEN MEMORY', /CONNECTED/.test(mem) && /ENTRIES\s*2/.test(mem) && /12 nodes/.test(mem) && /Prefers concise/.test(mem) && /OPEN MEMORY/.test(mem));
    const nav = await page.locator('.cc-nav a').allInnerTexts();
    check('bottom nav: 8 entries in order', nav.map((t) => t.replace(/[^A-Z]/g, '')).join('|').startsWith('COMMAND|CHAT|TASKS|MEMORY|AGENTS|AUTOMATIONS|DEVICES|SETTINGS'), nav.join('|'));
    const log = await page.locator('[data-mount="log"]').innerText();
    check('system log: shows errors/system events, hides routine tool calls; has FILTER/CLEAR/OPEN LOGS', /task_failed/.test(log) && !/tool_executed/.test(log) && /FILTER/.test(log) && /CLEAR/.test(log) && /OPEN LOGS/.test(log));
    await page.locator('[data-mount="log"] [data-act="filter"]').click(); await page.locator('[data-mount="log"] [data-act="filter"]').click();
    check('system log: filter cycles ALL→WARN→ERROR and filters', /ERROR/.test(await page.locator('[data-mount="log"] [data-act="filter"]').innerText()) && !/ai_model_selected/.test(await page.locator('[data-mount="log"]').innerText()));
    await page.locator('[data-mount="log"] [data-act="clear"]').click();
    check('system log: CLEAR empties the view', /No matching/.test(await page.locator('[data-mount="log"]').innerText()));

    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'desktop-idle.png') });

    // ===== command submission: THINKING state + reply =====
    state.chatDelayMs = 900;
    await page.fill('#cc-input', 'Run system diagnostics.');
    await page.locator('[data-act="send"]').click();
    await waitState(page, 'THINKING');
    check('command: core switches to THINKING while request is in flight', true);
    await page.waitForSelector('.cc-exchange[data-status="done"]');
    state.chatDelayMs = 0;
    check('command: request reaches existing /api/chat with sessionId', state.chats.at(-1)?.message === 'Run system diagnostics.' && Boolean(state.chats.at(-1)?.sessionId));
    check('command: reply displayed, input cleared, core returns to IDLE', /echo: Run system diagnostics/.test(await page.locator('[data-exchanges]').innerText()) && (await page.inputValue('#cc-input')) === '' && (await coreState(page)) === 'IDLE');
    await page.fill('#cc-input', 'plan a deploy');
    await page.keyboard.press('Enter');
    await page.waitForSelector('text=CONFIRM PLAN');
    check('command: Enter sends; plan awaiting confirmation offers CONFIRM PLAN / CANCEL', (await page.locator('[data-say="cancel that"]').count()) === 1);
    await page.locator('[data-say="yes, go ahead"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.cc-exchange').length >= 3 && /echo: yes, go ahead/.test(document.querySelector('[data-exchanges]').innerText));
    check('command: CONFIRM PLAN goes through the same agent endpoint', state.chats.at(-1)?.message === 'yes, go ahead');
    await page.fill('#cc-input', 'explode'); await page.keyboard.press('Enter');
    await page.waitForSelector('.cc-exchange[data-status="error"]', );
    await waitState(page, 'ERROR');
    check('error: failed request shows ERROR core state but page stays usable', await page.locator('#cc-input').isEnabled() && (await page.locator('[data-act="send"]').isEnabled()));
    await page.locator('[data-act="command"]').click();
    check('COMMAND menu lists the example commands', (await page.locator('.cc-menu button').count()) === 9);
    await page.locator('.cc-menu button', { hasText: 'Open memory.' }).click();
    check('COMMAND menu fills the input', (await page.inputValue('#cc-input')) === 'Open memory.');
    check('ATTACH is honestly disabled (backend has no attachment support)', await page.locator('[data-act="attach"]').isDisabled());

    // ===== WebSocket-driven core states + activity =====
    await page.waitForFunction(() => document.querySelector('.cc-core').dataset.state !== 'ERROR', null, { timeout: 9000 });
    broadcast('task.created', { taskId: 'T1', goal: 'Research deployment', stepCount: 6 });
    await waitState(page, 'PLANNING');
    broadcast('task.started', { taskId: 'T1' }); await waitState(page, 'EXECUTING');
    check('websocket: task.started -> EXECUTING', true);
    broadcast('task.verifying', { taskId: 'T1' }); await waitState(page, 'VERIFYING');
    check('websocket: task.verifying -> VERIFYING', true);
    broadcast('task.recovering', { taskId: 'T1' }); await waitState(page, 'RECOVERING');
    check('websocket: task.recovering -> RECOVERING', true);
    const act = await page.locator('[data-mount="activity"]').innerText();
    check('live activity: real events appear with timestamps, newest first', /Task created — Research deployment \(6 steps\)/.test(act) && /Task started/.test(act) && /Verifying task/.test(act) && /\d\d:\d\d:\d\d/.test(act));
    state.tasks = [{ id: 'T1', goal: 'RESEARCH DEPLOYMENT', status: 'running', createdAt: new Date(Date.now() - 30000).toISOString(), createdBy: 'user', steps: [{ status: 'completed', description: 'a' }, { status: 'completed', description: 'b' }, { status: 'completed', description: 'c' }, { status: 'completed', description: 'd' }, { status: 'running', description: 'Testing Render deployment' }] }];
    broadcast('task.started', { taskId: 'T1' });
    await page.waitForFunction(() => /Testing Render deployment/.test(document.querySelector('[data-mount="task"]')?.innerText ?? ''));
    const task = await page.locator('[data-mount="task"]').innerText();
    check('current task: name, status, step, progress bar %, elapsed, agent, model', /RESEARCH DEPLOYMENT/.test(task) && /RUNNING/.test(task) && /████████░░/.test(task) && /80%/.test(task) && /\d+s/.test(task) && /gpt-5\.6-luna|other-model/.test(task));
    state.tasks = state.tasks.map((t) => ({ ...t, status: 'completed', completedAt: new Date().toISOString() })); // real backend persists 'completed' before emitting the event
    broadcast('task_completed', { taskId: 'T1' }); await waitState(page, 'LEARNING');
    check('websocket: task_completed -> LEARNING then back to IDLE', true);
    await waitState(page, 'IDLE', 6000);
    broadcast('task_failed', { taskId: 'T2', error: 'step blew up' }); await waitState(page, 'ERROR');
    check('websocket: task_failed -> ERROR (activity shows the failure)', /Task failed: step blew up/.test(await page.locator('[data-mount="activity"]').innerText()));
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'desktop-error.png') });

    // ===== approvals =====
    state.approvals = [{ id: 'ap1', toolName: 'deploy_production', input: { env: 'prod' }, riskLevel: 3, status: 'pending', reason: 'high_impact' }];
    broadcast('approval_required', { approvalId: 'ap1', toolName: 'deploy_production', riskLevel: 3 });
    await page.waitForSelector('.cc-approval');
    const card = await page.locator('.cc-approval').innerText();
    check('approval card: APPROVAL REQUIRED, risk HIGH, action, APPROVE / DENY', /APPROVAL REQUIRED/.test(card) && /HIGH/.test(card) && /deploy_production/.test(card) && /APPROVE/.test(card) && /DENY/.test(card));
    check('approval: nothing is executed until the user acts', state.approvalCalls.length === 0);
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'desktop-approval.png') });
    await page.locator('[data-approve="ap1"]').click();
    await page.waitForSelector('.cc-approval', { state: 'detached' });
    check('approval: APPROVE calls existing POST /api/approvals/:id/approve', state.approvalCalls[0]?.join(' ') === 'ap1 approve');
    state.approvals = [{ id: 'ap2', toolName: 'send_email', input: {}, riskLevel: 2, status: 'pending' }];
    broadcast('approval_required', { approvalId: 'ap2' });
    await page.waitForSelector('[data-deny="ap2"]');
    await page.locator('[data-deny="ap2"]').click();
    await page.waitForSelector('.cc-approval', { state: 'detached' });
    check('approval: DENY calls existing POST /api/approvals/:id/reject', state.approvalCalls[1]?.join(' ') === 'ap2 reject');

    // ===== missions / autonomy / diagnostics / emergency stop =====
    await page.waitForFunction(() => /Keep my website healthy/.test(document.querySelector('[data-mount="missions"]')?.innerText ?? ''));
    const mt = await page.locator('[data-mount="missions"]').innerText();
    check('missions: goal, status, usage vs budget, pause reason, next-up', /Keep my website healthy/.test(mt) && /PLANNED/.test(mt) && /runs 1\/5/.test(mt) && /PAUSED/.test(mt) && /budget_exhausted: runs \(2\/2\)/.test(mt) && /NEXT UP/.test(mt));
    await page.locator('[data-m="pause"][data-id="ms1"]').click();
    await page.waitForFunction(() => /paused from dashboard/.test(document.querySelector('[data-mount="missions"]').innerText));
    check('missions: PAUSE calls existing POST /api/missions/:id/pause', state.calls.some((c) => c[0] === 'pause' && c[1] === 'ms1'));
    page.once('dialog', (d) => d.accept('4'));
    await page.locator('[data-m="resume"][data-id="ms2"]').click();
    await page.waitForFunction(() => !/budget_exhausted/.test(document.querySelector('[data-mount="missions"]').innerText));
    const rc = state.calls.find((c) => c[0] === 'resume' && c[1] === 'ms2');
    check('missions: RESUME of an exhausted budget asks for authorization and sends extendBudget', rc?.[2]?.extendBudget?.maxRuns === 6, JSON.stringify(rc));
    page.once('dialog', (d) => d.accept());
    await page.locator('[data-m="stop"][data-id="ms1"]').click();
    await sleep(300);
    check('missions: STOP asks for confirmation then cancels', state.calls.some((c) => c[0] === 'cancel' && c[1] === 'ms1'));
    const at = await page.locator('[data-mount="autonomy"]').innerText();
    check('autonomy panel: level, per-risk policy, honest note about domains', /2 · APPROVAL/.test(at) && /HIGH_IMPACT[\s\S]*ALWAYS ASKS/.test(at) && /not implemented/.test(at));
    const dg = await page.locator('[data-mount="diagnostics"]').innerText();
    check('diagnostics panel: overall + real checks with levels', /DEGRADED/.test(dg) && /memory/i.test(dg) && /websocket/i.test(dg));
    check('emergency stop: button visible in top bar', /STOP XOFT/.test(await page.locator('[data-stop]').innerText()));
    page.once('dialog', (d) => d.accept());
    await page.locator('[data-stop]').click();
    await page.waitForFunction(() => /RESUME XOFT/.test(document.querySelector('[data-stop]').innerText));
    check('emergency stop: STOP XOFT confirms, calls existing endpoint, core shows ERROR', state.calls.some((c) => c[0] === 'estop-on') && (await coreState(page)) === 'ERROR');
    await page.locator('[data-stop]').click();
    await page.waitForFunction(() => /STOP XOFT/.test(document.querySelector('[data-stop]').innerText));
    check('emergency stop: RESUME XOFT releases it', state.calls.some((c) => c[0] === 'estop-off') && state.emergency === false);

    // ===== WebSocket disconnect / reconnect / resync =====
    const tasksBefore = state.fetches['GET /api/tasks'];
    wss.clients.forEach((c) => c.terminate());
    await page.waitForFunction(() => /RECONNECTING/.test(document.querySelector('[data-net]')?.innerText ?? ''), null, { timeout: 4000 });
    check('websocket: disconnect shows ● RECONNECTING', true);
    await page.waitForFunction(() => /LIVE/.test(document.querySelector('[data-net]')?.innerText ?? ''), null, { timeout: 8000 });
    check('websocket: reconnects automatically', true);
    await sleep(600);
    check('websocket: resyncs from REST after reconnect', state.fetches['GET /api/tasks'] > tasksBefore);
    check('websocket: dashboard reuses the single existing /ws client (one socket)', wss.clients.size === 1, String(wss.clients.size));

    // ===== provider failure never breaks the dashboard =====
    state.providerDegraded = false;
    await page.locator('[data-mount="providers"] [data-act="retry"]').count();
    check('no uncaught errors during desktop session', errors.length === 0, errors.join(' | '));

    // ===== keyboard + aria =====
    await page.goto(BASE + '/#command'); await page.reload();
    await page.waitForSelector('#cc-input'); await page.waitForSelector('button[data-prov]');
    await page.keyboard.press('Tab');
    check('a11y: skip link is first tab stop', await page.evaluate(() => document.activeElement?.className === 'cc-skip'));
    check('a11y: regions labelled (aria-labelledby on panels, nav label, live region for core state)', (await page.locator('section.cc-panel[aria-labelledby]').count()) === 9 && (await page.locator('nav[aria-label]').count()) >= 1 && (await page.locator('.cc-core-readout[aria-live]').count()) === 1);
    check('a11y: provider rows are real buttons with aria-expanded', (await page.locator('button[data-prov][aria-expanded]').count()) === 6);
    const focusOutline = await page.evaluate(() => { const b = document.querySelector('.cc-nav a'); b.focus(); return getComputedStyle(b).outlineStyle; });
    check('a11y: visible focus outline', focusOutline !== 'none');
    await ctx.close();
  }

  // ===== 2. tablet =====
  {
    const { ctx, page, errors } = await open({ width: 900, height: 1100 });
    await page.goto(BASE + '/'); await page.waitForSelector('.cc-boot', { state: 'detached', timeout: 8000 });
    const t = await rect(page, '.cc-p-task'); const a = await rect(page, '.cc-p-missions'); const c = await rect(page, '.cc-core');
    check('tablet: two-column panel grid under a full-width core', Math.abs(t.y - a.y) < 4 && a.x > t.x + 100 && c.y < t.y);
    check('tablet: no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'tablet.png'), fullPage: true });
    check('tablet: no errors', errors.length === 0, errors.join(' | ')); await ctx.close();
  }

  // ===== 3. mobile =====
  {
    const { ctx, page, errors } = await open({ width: 390, height: 844 }, { isMobile: true });
    await page.goto(BASE + '/'); await page.waitForSelector('.cc-boot', { state: 'detached', timeout: 8000 });
    const ys = {};
    for (const [k, sel] of Object.entries({ header: '.cc-top', core: '.cc-core', cmd: '.cc-cmd', task: '.cc-p-task', activity: '.cc-p-activity', providers: '.cc-p-providers', system: '.cc-p-system' })) ys[k] = (await page.evaluate((s) => { const e = document.querySelector(s); const sc = document.querySelector('#content'); return e.getBoundingClientRect().top + sc.scrollTop; }, sel));
    const order = Object.keys(ys).sort((x, y) => ys[x] - ys[y]).join('>');
    check('mobile: order header>core>command>task>activity>providers>system (nav is sticky-pinned below)', order === 'header>core>cmd>task>activity>providers>system', order);
    const widths = await page.evaluate(() => ({ sw: document.querySelector('#content').scrollWidth, cw: document.querySelector('#content').clientWidth }));
    check('mobile: single column, no horizontal overflow', widths.sw <= widths.cw + 1, JSON.stringify(widths));
    const tx = await rect(page, '.cc-p-task'); const ax = await rect(page, '.cc-p-activity');
    check('mobile: panels stacked (not a shrunken 3-col HUD)', Math.abs(tx.x - ax.x) < 2 && ax.y > tx.y);
    check('mobile: input font >=16px (no iOS zoom)', (await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#cc-input')).fontSize))) >= 16);
    const navBox = await rect(page, '.cc-nav');
    check('mobile: bottom navigation pinned at bottom of viewport', Math.abs(navBox.y + navBox.height - 844) < 3, JSON.stringify(navBox));
    const touchOk = await page.evaluate(() => [...document.querySelectorAll('.cc-nav a, [data-act="send"]')].every((e) => e.getBoundingClientRect().height >= 32));
    check('mobile: touch targets >= 32px', touchOk);
    if (shotsDir) { await page.screenshot({ path: path.join(shotsDir, 'mobile.png') }); await page.screenshot({ path: path.join(shotsDir, 'mobile-full.png'), fullPage: false }); }
    // navigation reuses existing routes
    await page.locator('.cc-nav a[href="#memory"]').click();
    await page.waitForFunction(() => document.body.dataset.route === 'memory');
    await page.waitForSelector('text=Remember something');
    check('nav: MEMORY opens the existing memory view (legacy shell visible again)', /remember something/i.test(await page.locator('#content').innerText()) && (await page.locator('#sidebar').count()) === 1);
    await page.goBack(); await page.waitForFunction(() => document.body.dataset.route === 'command'); await page.waitForSelector('.cc [data-mount="nav"] a');
    check('nav: back returns to Command Center without duplicate sockets/intervals', (await page.locator('.cc').count()) === 1);
    check('mobile: no errors', errors.length === 0, errors.join(' | ')); await ctx.close();
  }

  // ===== 4. reduced motion =====
  {
    const { ctx, page } = await open({ width: 1280, height: 800 }, { reducedMotion: 'reduce' });
    await page.goto(BASE + '/'); await page.waitForSelector('#cc-input', { timeout: 8000 });
    const anim = await page.evaluate(() => ['.cc-ring-a', '.cc-orbit-1', '.cc-hub-core', '.cc-ring-ticks'].map((s) => getComputedStyle(document.querySelector(s)).animationName));
    check('reduced-motion: ring/orbit/pulse animations are off', anim.every((n) => n === 'none'), anim.join(','));
    check('reduced-motion: state is still conveyed as text', /IDLE/.test(await page.locator('[data-core-state]').innerText()));
    await ctx.close();
    const m = await open({ width: 1280, height: 800 });
    await m.page.goto(BASE + '/'); await m.page.waitForSelector('#cc-input', { timeout: 8000 });
    const anim2 = await m.page.evaluate(() => getComputedStyle(document.querySelector('.cc-ring-a')).animationName);
    check('normal motion: rings do animate (control for the test above)', anim2 === 'cc-spin', anim2);
    await m.ctx.close();
  }

  // ===== 5. returning user skips full intro =====
  {
    const { ctx, page } = await open({ width: 1280, height: 800 }, { ctxOpts: { storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: 'xoft_boot_seen', value: '1' }] }] } } });
    const t0 = Date.now();
    await page.goto(BASE + '/');
    await page.waitForSelector('.cc-boot');
    await page.waitForFunction(() => /READY/.test(document.querySelector('.cc-boot')?.innerText ?? ''), null, { timeout: 4000 });
    const bootText = await page.locator('.cc-boot').innerText();
    await page.waitForSelector('.cc-boot', { state: 'detached', timeout: 4000 });
    check('boot: returning user gets only the short "XOFT READY" flash, no per-subsystem lines', !/AI PROVIDERS|MEMORY|AGENTS/.test(bootText) && Date.now() - t0 < 2500, `${Date.now() - t0}ms :: ${bootText.replace(/\n/g, ' ')}`);
    await ctx.close();
  }

  // ===== 6. authentication =====
  {
    state.requireKey = true; state.headersSeen = [];
    const { ctx, page } = await open({ width: 1280, height: 800 });
    let prompted = 0;
    page.on('dialog', async (d) => { prompted += 1; await d.accept(API_KEY); });
    await page.goto(BASE + '/'); await page.waitForSelector('#cc-input', { timeout: 10000 });
    await page.waitForFunction(() => /claude-sonnet/.test(document.querySelector('[data-mount="providers"]')?.innerText ?? ''), null, { timeout: 8000 });
    check('auth: 401 triggers the existing API-key prompt exactly once (not once per widget)', prompted === 1, `prompted=${prompted}`);
    check('auth: after login every API call carries X-API-Key', state.headersSeen.slice(-8).every((h) => h === API_KEY));
    check('auth: key is never rendered into the DOM', !(await page.content()).includes(API_KEY));
    await page.locator('[data-user]').click();
    check('user/device menu: shows device id and key status without exposing the key', /dev-local/.test(await page.locator('[data-usermenu]').innerText()) && /set in this browser/.test(await page.locator('[data-usermenu]').innerText()) && !(await page.locator('[data-usermenu]').innerText()).includes(API_KEY));
    await ctx.close(); state.requireKey = false;
  }

  // ===== 7. offline =====
  {
    const { ctx, page } = await open({ width: 1280, height: 800 });
    await page.goto(BASE + '/'); await page.waitForSelector('#cc-input', { timeout: 8000 });
    await sleep(500);
    await ctx.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.waitForFunction(() => /OFFLINE/.test(document.querySelector('[data-overall]')?.innerText ?? ''), null, { timeout: 4000 });
    check('offline: top bar shows OFFLINE, dashboard stays rendered', (await page.locator('.cc-core').count()) === 1);
    await page.fill('#cc-input', 'hello while offline'); await page.keyboard.press('Enter');
    await page.waitForSelector('.cc-exchange[data-status="queued"]');
    check('offline: command is queued through the existing offline queue, not lost', /queued/.test(await page.locator('[data-exchanges]').innerText()));
    await ctx.close();
  }
} catch (err) {
  check('harness completed without throwing', false, err.stack);
} finally {
  await browser.close();
  wss.close(); server.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
