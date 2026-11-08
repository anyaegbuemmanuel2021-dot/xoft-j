/**
 * ToolGateway — exposes Xoft's ToolRegistry to an engine over MCP (Streamable HTTP, JSON responses), so Hermes consumes
 * the SAME tools Xoft uses instead of growing a duplicate set (spec sections 14–16, 20).
 *
 * Why this is safe to expose:
 *   • Bearer token (random, stored 0600, constant-time compared) and loopback-only by default.
 *   • Every call is checked against the *task's* permission profile BEFORE it runs (the model's compliance is not relied on),
 *     then through Xoft's own gates: ApprovalSystem risk rules, device permission grants, emergency stop, agent-side policy.
 *   • Paths in arguments are checked: protected files are refused, and writes/deletes must stay inside the task's directories.
 *   • Results are secret-redacted before they go back to the model.
 *
 * Stateless: no MCP session is kept. `connected` means "a client has talked to this endpoint since Xoft started".
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { checkToolAgainstProfile, intersectProfiles, normalizeProfile, parseToolPreview } from './EnginePermissions.js';
import { isInside, isSensitivePath, redactDeep, redactString } from './redact.js';

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_RESULT_CHARS = 100_000;
const WRITE_PERMS = new Set(['filesystem.write', 'filesystem.delete']);
const PATH_ARGS = ['path', 'paths', 'from', 'to', 'a', 'b', 'dest', 'destDir', 'archive'];
// Engine-layer tools are never exposed to an engine: an engine launching engine tasks would be unbounded recursive delegation.
const HIDDEN_FROM_ENGINES = /^engine_/;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result });
const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ToolGateway {
  /**
   * @param {object} deps
   * @param {import('../tools/ToolRegistry.js').ToolRegistry} deps.toolRegistry
   * @param {import('./EngineTaskStore.js').EngineTaskStore|null} [deps.secretStore] EngineSecretStore
   * @param {() => import('./EngineTaskManager.js').EngineTaskManager|null} deps.getTaskManager
   * @param {() => object} deps.getSettings   resolved Hermes settings (permission ceiling, wait time, device id…)
   */
  constructor({ toolRegistry, secretStore, getTaskManager, getSettings, approvalSystem = null, emergencyStop = null, activityLog = null, deviceManager = null, ctxFactory = () => ({}), localDeviceId = 'local', publicUrl = null, allowRemote = false, engineId = 'hermes', pollMs = 500 }) {
    Object.assign(this, { toolRegistry, secretStore, getTaskManager, getSettings, approvalSystem, emergencyStop, activityLog, deviceManager, ctxFactory, localDeviceId, publicUrl, allowRemote, engineId, pollMs });
    this._waiting = new Map(); // call fingerprint → approvalId
    this._seen = { at: null, client: null, protocol: null };
    this._stats = { calls: 0, denied: 0, errors: 0 };
    this._window = { start: Date.now(), count: 0 };
  }

  /** The bearer token Hermes must present. Created on first use. */
  token() { return this.secretStore?.ensure?.('xoft-tool-token') ?? null; }
  rotateToken() { return this.secretStore?.rotate?.('xoft-tool-token') ?? null; }

  _enabled() { return this.getSettings?.().bridgeEnabled !== false; }

  _bridgeDevice() {
    const s = this.getSettings?.() ?? {};
    if (s.bridgeDeviceId) return s.bridgeDeviceId;
    const online = this._onlineDevices();
    return online[0]?.id ?? null;
  }

  _onlineDevices() {
    try { return (this.deviceManager?.listDevices?.() ?? []).filter((d) => d.platform !== 'server' && d.trust === 'trusted' && d.online); } catch { return []; }
  }

  status() {
    return {
      enabled: this._enabled(), connected: Boolean(this._seen.at), lastSeenAt: this._seen.at, client: this._seen.client, protocol: this._seen.protocol,
      url: this.publicUrl ? `${this.publicUrl.replace(/\/+$/, '')}/engine-bridge/mcp` : null, deviceOnline: this._onlineDevices().length > 0,
      tools: this.listTools().length, calls: this._stats.calls, denied: this._stats.denied, errors: this._stats.errors, tokenCreated: this.secretStore?.info?.('xoft-tool-token')?.createdAt ?? null,
    };
  }

  // ---- HTTP entry -------------------------------------------------------------------------------------------

  /**
   * Framework-agnostic handler. `req` = { method, headers, body, remoteAddress }. Returns { status, headers?, body? }.
   */
  async handleHttp(req) {
    if (!this._enabled()) return { status: 404, body: { error: 'Tool Gateway is disabled' } };
    if (!this.allowRemote && !LOOPBACK.has(String(req.remoteAddress ?? ''))) return { status: 403, body: { error: 'Tool Gateway only accepts loopback connections' } };
    if (!this._authorized(req.headers)) return { status: 401, headers: { 'WWW-Authenticate': 'Bearer' }, body: { error: 'invalid or missing token' } };
    if (!this._rateOk()) return { status: 429, body: { error: 'too many requests' } };
    if (req.method === 'GET' || req.method === 'DELETE') return { status: 405, headers: { Allow: 'POST' }, body: { error: 'stateless endpoint: use POST' } };
    if (req.method !== 'POST') return { status: 405, headers: { Allow: 'POST' }, body: { error: 'method not allowed' } };

    const body = req.body;
    if (body === undefined || body === null || typeof body !== 'object') return { status: 400, body: rpcError(null, -32700, 'Parse error') };
    const batch = Array.isArray(body);
    const messages = batch ? body : [body];
    const responses = [];
    for (const m of messages) {
      const r = await this._dispatch(m);
      if (r) responses.push(r);
    }
    if (!responses.length) return { status: 202 };
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: batch ? responses : responses[0] };
  }

  _authorized(headers = {}) {
    const expected = this.token();
    if (!expected) return false;
    const h = headers.authorization ?? headers.Authorization ?? '';
    const given = String(h).startsWith('Bearer ') ? String(h).slice(7) : '';
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
  }

  _rateOk() {
    const now = Date.now();
    if (now - this._window.start > 60_000) this._window = { start: now, count: 0 };
    this._window.count += 1;
    return this._window.count <= 1200;
  }

  async _dispatch(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return rpcError(msg?.id, -32600, 'Invalid Request');
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;
    this._seen.at = new Date().toISOString();
    try {
      switch (method) {
        case 'initialize': {
          const asked = params?.protocolVersion;
          this._seen.client = params?.clientInfo?.name ?? this._seen.client; this._seen.protocol = asked ?? null;
          return rpcOk(id, { protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'xoft-tool-gateway', version: '1.0.0' }, instructions: 'Xoft tools. Include "task_id" (given in your task instructions) in every call so Xoft applies the right permissions.' });
        }
        case 'notifications/initialized': case 'notifications/cancelled': return isNotification ? null : rpcOk(id, {});
        case 'ping': return rpcOk(id, {});
        case 'tools/list': return rpcOk(id, { tools: this.listTools() });
        case 'tools/call': return rpcOk(id, await this.callTool(params?.name, params?.arguments ?? {}));
        case 'resources/list': return rpcOk(id, { resources: [] });
        case 'resources/templates/list': return rpcOk(id, { resourceTemplates: [] });
        case 'prompts/list': return rpcOk(id, { prompts: [] });
        default: return isNotification ? null : rpcError(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      return rpcError(id, -32603, 'Internal error', { message: redactString(err?.message ?? 'error') });
    }
  }

  // ---- tools ------------------------------------------------------------------------------------------------

  listTools() {
    const ceiling = this._ceiling();
    return this.toolRegistry.schemasForAI()
      .filter((t) => !HIDDEN_FROM_ENGINES.test(t.name) && checkToolAgainstProfile(ceiling, t.name, {}).allowed)
      .map((t) => {
        const schema = JSON.parse(JSON.stringify(t.inputSchema ?? { type: 'object', properties: {} }));
        schema.type = 'object'; schema.properties = { ...(schema.properties ?? {}), task_id: { type: 'string', description: 'The Xoft task id from your instructions (required so Xoft applies this task\'s permissions).' } };
        if (schema.properties.deviceId && Array.isArray(schema.required)) schema.required = schema.required.filter((r) => r !== 'deviceId'); // the gateway fills in the default device
        return { name: t.name, description: String(t.description ?? '').slice(0, 1000), inputSchema: schema };
      });
  }

  _ceiling() { try { return normalizeProfile(this.getSettings?.().permissionProfile ?? 'standard'); } catch { return normalizeProfile('standard'); } }

  /** Which task + policy a call belongs to. Unknown/ambiguous callers get the most restrictive applicable policy, never a wider one. */
  _resolvePolicy(taskId) {
    const manager = this.getTaskManager?.();
    const active = manager?.activeTasks?.(this.engineId) ?? [];
    if (taskId) {
      const t = active.find((x) => x.id === taskId);
      if (!t) return { error: `task_id '${taskId}' is not an active Xoft task on this engine` };
      return { task: t, profile: t.permissions, roots: t.allowedRoots ?? [], cwd: t.workspace?.cwd ?? t.workingDirectory, autonomy: t.autonomy };
    }
    if (active.length === 0) return { error: 'no active Xoft task: the Tool Gateway only serves tasks Xoft is currently running' };
    if (active.length === 1) { const t = active[0]; return { task: t, profile: t.permissions, roots: t.allowedRoots ?? [], cwd: t.workspace?.cwd ?? t.workingDirectory, autonomy: t.autonomy }; }
    return { task: null, ambiguous: true, profile: intersectProfiles(...active.map((t) => t.permissions)), roots: active.flatMap((t) => t.allowedRoots ?? []).filter((r, i, a) => a.indexOf(r) === i), cwd: null, autonomy: Math.min(...active.map((t) => t.autonomy)) };
  }

  _toolResult(text, isError = false, extra = []) { return { content: [{ type: 'text', text }, ...extra], isError }; }

  /** @returns {Promise<{content:object[], isError:boolean}>} — tool failures are results (isError), not protocol errors. */
  async callTool(name, rawArgs) {
    this._stats.calls += 1;
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? { ...rawArgs } : {};
    const taskId = typeof args.task_id === 'string' ? args.task_id : null;
    delete args.task_id;
    const manager = this.getTaskManager?.();
    const deny = (why, code = 'denied') => {
      this._stats.denied += 1;
      this.activityLog?.log({ type: 'engine_bridge_denied', detail: { tool: name, taskId, code, why } });
      if (taskId) manager?.noteBridgeCall?.(taskId, { tool: name, decision: 'denied', code, why });
      return this._toolResult(`Xoft denied this tool call: ${why}`, true);
    };

    if (!name || !this.toolRegistry.has(name) || HIDDEN_FROM_ENGINES.test(name)) return this._toolResult(`Unknown Xoft tool '${name}'`, true);
    if (this.emergencyStop?.isActive?.()) return deny('emergency stop is active', 'emergency_stop');
    const tool = this.toolRegistry.get(name);

    const policy = this._resolvePolicy(taskId);
    if (policy.error) return deny(policy.error, 'no_task');
    const ceiling = this._ceiling();
    const profile = intersectProfiles(policy.profile, ceiling);

    const defaultDevice = this._bridgeDevice();
    if (tool.inputSchema?.properties?.deviceId && args.deviceId === undefined && defaultDevice) args.deviceId = defaultDevice;

    const verdict = checkToolAgainstProfile(profile, name, args);
    if (!verdict.allowed) return deny(`this task's permission profile does not grant ${verdict.missing.join(', ')}`, 'permission');
    if (policy.autonomy !== undefined && policy.autonomy <= 1 && tool.riskLevel > 0) return deny('autonomy level 0–1 is observe-only', 'autonomy');

    // Path scoping: protected files are never reachable; writes/deletes stay inside the task's directories.
    const writes = verdict.required.some((p) => WRITE_PERMS.has(p));
    const { paths } = parseToolPreview(Object.fromEntries(PATH_ARGS.filter((k) => args[k] !== undefined).map((k) => [k, args[k]])));
    for (const p of paths) {
      const abs = path.resolve(policy.cwd ?? process.cwd(), String(p));
      if (isSensitivePath(abs)) return deny(`'${path.basename(abs)}' is a protected file (credentials, keys or system files)`, 'sensitive_path');
      if (writes && policy.roots.length && !policy.roots.some((r) => isInside(abs, r))) return deny(`'${p}' is outside the directories this task may modify`, 'outside_workspace');
    }

    // Xoft's own approval rules (risk level × autonomy × per-domain autonomy), with a human in the loop where required.
    const fingerprint = crypto.createHash('sha1').update(`${taskId ?? '*'}|${name}|${stable(args)}`).digest('hex');
    const gate = await this._approvalGate({ fingerprint, tool, args, taskId: policy.task?.id ?? taskId });
    if (gate.blocked) return gate.result;

    const started = Date.now();
    try {
      const ctx = { ...this.ctxFactory(), deviceId: args.deviceId ?? defaultDevice ?? this.localDeviceId, missionId: policy.task?.id ?? null, agent: 'hermes', reason: `engine task ${policy.task?.id ?? ''}`.trim() };
      const result = await this.toolRegistry.execute(name, args, ctx);
      manager?.noteBridgeCall?.(policy.task?.id ?? taskId, { tool: name, decision: 'allowed', ok: true, ms: Date.now() - started });
      return this._format(result);
    } catch (err) {
      this._stats.errors += 1;
      manager?.noteBridgeCall?.(policy.task?.id ?? taskId, { tool: name, decision: 'allowed', ok: false, ms: Date.now() - started, error: redactString(err.message).slice(0, 300) });
      return this._toolResult(redactString(`Tool '${name}' failed: ${err.message}`).slice(0, 4000), true);
    }
  }

  /**
   * Approval gate. A human decision can take longer than an MCP tool-call timeout, so: wait up to bridgeApprovalWaitMs for
   * the decision; if it is still pending, tell the model to retry — the retry finds the same pending approval and, once
   * approved, runs exactly once.
   */
  async _approvalGate({ fingerprint, tool, args, taskId }) {
    if (!this.approvalSystem) return { blocked: false };
    const manager = this.getTaskManager?.();
    let approvalId = this._waiting.get(fingerprint) ?? null;

    if (!approvalId) {
      if (this.approvalSystem.decide({ tool, input: args }) === 'auto') return { blocked: false };
      const summary = `${tool.name} ${redactString(stable(redactDeep(args))).slice(0, 200)}`;
      ({ approvalId } = this.approvalSystem.requestApproval({ tool, input: redactDeep(args), taskId: null, reason: 'engine_tool_call', metadata: { engineTaskId: taskId ?? null, engineId: this.engineId, bridge: true } }));
      this._waiting.set(fingerprint, approvalId);
      if (taskId) manager?.addBridgeApproval?.(taskId, { approvalId, tool: tool.name, summary });
    }

    const waitMs = Number(this.getSettings?.().bridgeApprovalWaitMs) || 100_000;
    const until = Date.now() + waitMs;
    for (;;) {
      const rec = this.approvalSystem.get(approvalId);
      if (!rec || rec.status === 'rejected') {
        this._waiting.delete(fingerprint); if (taskId) manager?.removeBridgeApproval?.(taskId, approvalId);
        this._stats.denied += 1;
        return { blocked: true, result: this._toolResult('A human rejected this action in Xoft. Do not retry it; choose another approach.', true) };
      }
      if (rec.status === 'approved') {
        this._waiting.delete(fingerprint); if (taskId) manager?.removeBridgeApproval?.(taskId, approvalId);
        return { blocked: false }; // consumed: a later identical call needs a fresh approval
      }
      if (this.emergencyStop?.isActive?.()) return { blocked: true, result: this._toolResult('Emergency stop is active.', true) };
      if (Date.now() >= until) return { blocked: true, result: this._toolResult(`This action is waiting for a human to approve it in Xoft (approval ${approvalId}). It has not run. Retry the same call in a minute; once approved it will execute.`, true) };
      await sleep(this.pollMs);
    }
  }

  _format(result) {
    const extra = [];
    let value = result;
    const b64 = result && typeof result === 'object' ? (result.base64 ?? result.screenshot ?? result.pngBase64 ?? null) : null;
    if (typeof b64 === 'string' && b64.length > 100) {
      extra.push({ type: 'image', data: b64, mimeType: 'image/png' });
      value = { ...result }; for (const k of ['base64', 'screenshot', 'pngBase64']) if (k in value) value[k] = '[image attached]';
    }
    let text;
    try { text = JSON.stringify(redactDeep(value, { maxString: 20000 }), null, 2); } catch { text = String(value); }
    if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated ${text.length - MAX_RESULT_CHARS} chars]`;
    return this._toolResult(text ?? 'null', false, extra);
  }
}
