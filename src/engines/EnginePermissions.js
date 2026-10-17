/**
 * Unified engine permission model (spec sections 20, 21, 30).
 *
 * One permission vocabulary covers BOTH ways an engine can act:
 *   1. through Xoft's Tool Gateway   — every call is checked here *before* it runs (preventive, enforced in code);
 *   2. through the engine's own native tools (e.g. Hermes' terminal/file tools) — Xoft sees these only as events,
 *      so they are checked here as they start and the run is stopped on a violation (detective/containment).
 * Nothing in this file trusts the model to behave.
 */
import path from 'node:path';
import { isInside, isSensitivePath } from './redact.js';

/** Every permission that exists, grouped. Anything not listed here is denied. */
export const PERMISSION_SCHEMA = Object.freeze({
  filesystem: ['read', 'write', 'delete'],
  terminal: ['execute', 'unsafe'], // `unsafe` = privileged / system-level / pipe-to-shell commands
  browser: ['read', 'navigate', 'interact', 'submit_forms'],
  pc: ['control'], // keyboard / mouse / screen / launching applications
  memory: ['read', 'write'],
  network: ['search'],
  integrations: ['use'], // email, calendar, WhatsApp, phone, social, connectors, media generation
});

const all = (value) => Object.fromEntries(Object.entries(PERMISSION_SCHEMA).map(([g, acts]) => [g, Object.fromEntries(acts.map((a) => [a, value]))]));
const withOverrides = (base, overrides) => {
  const out = JSON.parse(JSON.stringify(base));
  for (const [g, acts] of Object.entries(overrides)) Object.assign(out[g], acts);
  return out;
};

export const PROFILES = Object.freeze({
  /** Read-only: inspect and report. Used automatically for autonomy levels 0–1. */
  observe: withOverrides(all(false), { filesystem: { read: true }, browser: { read: true }, memory: { read: true } }),
  /** Default. Reads/writes files, runs ordinary commands, browses. No deletes, no form submits, no PC control. */
  standard: withOverrides(all(false), {
    filesystem: { read: true, write: true },
    terminal: { execute: true },
    browser: { read: true, navigate: true, interact: true },
    memory: { read: true },
    network: { search: true },
  }),
  /** Standard + remembers things + may delete (deletes still go through approvals at lower autonomy). */
  developer: withOverrides(all(false), {
    filesystem: { read: true, write: true, delete: true },
    terminal: { execute: true },
    browser: { read: true, navigate: true, interact: true },
    memory: { read: true, write: true },
    network: { search: true },
  }),
  /** Everything. Still subject to approvals, autonomy level and Xoft's own device permission grants. */
  full: all(true),
});

export const PROFILE_DESCRIPTIONS = Object.freeze({
  observe: 'Read-only: inspect files, read pages, recall memory. Nothing is changed.',
  standard: 'Read/write files, run ordinary commands, browse. No deletes, no form submits, no PC control, no integrations.',
  developer: 'Standard plus deleting files and writing memory.',
  full: 'Everything — including PC control, form submission, unsafe shell commands and integrations. Approvals still apply.',
});

export function permissionNames() {
  return Object.entries(PERMISSION_SCHEMA).flatMap(([g, acts]) => acts.map((a) => `${g}.${a}`));
}

/**
 * Accepts a profile name ('standard'), an object `{base?:'standard', filesystem:{delete:true}, …}` or a full profile
 * and returns a complete, validated profile. Unknown groups/actions throw; missing values are DENIED (or taken from `base`).
 */
export function normalizeProfile(input, { fallback = 'standard' } = {}) {
  if (input === undefined || input === null || input === '') return JSON.parse(JSON.stringify(PROFILES[fallback]));
  if (typeof input === 'string') {
    if (!PROFILES[input]) throw new Error(`Unknown permission profile '${input}'. Known: ${Object.keys(PROFILES).join(', ')}`);
    return JSON.parse(JSON.stringify(PROFILES[input]));
  }
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Permission profile must be a profile name or an object');
  const { base, ...groups } = input;
  if (base !== undefined && !PROFILES[base]) throw new Error(`Unknown base profile '${base}'`);
  const out = base ? JSON.parse(JSON.stringify(PROFILES[base])) : all(false);
  for (const [group, acts] of Object.entries(groups)) {
    if (!PERMISSION_SCHEMA[group]) throw new Error(`Unknown permission group '${group}'. Known: ${Object.keys(PERMISSION_SCHEMA).join(', ')}`);
    if (typeof acts !== 'object' || acts === null) throw new Error(`Permission group '${group}' must be an object of booleans`);
    for (const [act, val] of Object.entries(acts)) {
      if (!PERMISSION_SCHEMA[group].includes(act)) throw new Error(`Unknown permission '${group}.${act}'`);
      out[group][act] = val === true; // only a literal `true` grants
    }
  }
  return out;
}

/** The most restrictive combination of several profiles (every permission must be granted by ALL of them). */
export function intersectProfiles(...profiles) {
  const list = profiles.filter(Boolean);
  if (!list.length) return all(false);
  const out = all(false);
  for (const [g, acts] of Object.entries(PERMISSION_SCHEMA)) for (const a of acts) out[g][a] = list.every((p) => p?.[g]?.[a] === true);
  return out;
}

/** Autonomy 0–1 means "observe / suggest": the profile is cut down to read-only no matter what was requested. */
export function clampToAutonomy(profile, level) {
  return Number.isInteger(level) && level <= 1 ? intersectProfiles(profile, PROFILES.observe) : profile;
}

export function isAllowed(profile, permission) {
  const [g, a] = String(permission).split('.');
  return profile?.[g]?.[a] === true;
}

export function deniedPermissions(profile) {
  return permissionNames().filter((p) => !isAllowed(profile, p));
}
export function grantedPermissions(profile) {
  return permissionNames().filter((p) => isAllowed(profile, p));
}

// ------------------------------------------------------------------------------------------------------------
// Xoft tools -> required engine permissions. Unknown tools need `integrations.use` (deny-by-default posture).
// ------------------------------------------------------------------------------------------------------------

const FS_READ = ['file_search', 'file_locate', 'file_inspect', 'file_read', 'file_list', 'file_compare', 'file_history', 'workspace_list', 'workspace_set_active', 'workspace_inspect', 'workspace_locate_project', 'operations_list', 'runtime_status', 'device_list_files'];
const FS_WRITE = ['file_create', 'file_write', 'file_edit', 'file_copy', 'file_move', 'file_rename', 'file_archive', 'file_extract', 'device_transfer_file'];
const FS_DELETE = ['file_delete', 'file_restore', 'file_undo_last', 'file_restore_version'];
const BROWSER_READ = ['browser_list_tabs', 'browser_get_page', 'browser_get_dom', 'browser_query', 'browser_wait_for', 'browser_get_text', 'browser_get_attribute', 'browser_screenshot', 'browser_element_screenshot', 'runtime_recover_browser'];
const BROWSER_NAV = ['browser_attach_tab', 'browser_new_tab', 'browser_navigate', 'browser_back', 'browser_forward', 'browser_reload', 'device_open_url'];
const BROWSER_INTERACT = ['browser_click', 'browser_type', 'browser_fill', 'browser_press', 'browser_scroll'];
const PC = ['file_open', 'device_computer_use', 'device_get_state', 'device_launch_app', 'device_close_app', 'device_list_apps', 'device_restart_app', 'device_media_control', 'device_screen_capture', 'device_screen_click', 'device_screen_scroll', 'device_screen_type', 'device_screen_understand', 'device_screen_verify'];
const MEMORY_READ = ['recall_facts'];
const MEMORY_WRITE = ['remember_fact', 'forget_facts', 'forget_fact_by_id', 'restore_facts'];
const NETWORK = ['search_web', 'fetch_page'];
const HARMLESS = ['calculate', 'get_current_time', 'runtime_halt']; // runtime_halt is a safety stop — it must never be blockable

const TOOL_REQUIREMENTS = new Map();
for (const [names, perms] of [
  [FS_READ, ['filesystem.read']], [FS_WRITE, ['filesystem.write']], [FS_DELETE, ['filesystem.write', 'filesystem.delete']],
  [BROWSER_READ, ['browser.read']], [BROWSER_NAV, ['browser.navigate']], [BROWSER_INTERACT, ['browser.interact']],
  [PC, ['pc.control']], [MEMORY_READ, ['memory.read']], [MEMORY_WRITE, ['memory.write']], [NETWORK, ['network.search']],
  [HARMLESS, []], [['terminal_run'], ['terminal.execute']],
]) for (const n of names) TOOL_REQUIREMENTS.set(n, perms);

// Engine-layer tools are the engine talking back to Xoft's own task system — they are gated by the task manager, not here.
const ENGINE_LAYER_TOOLS = ['engine_run_task', 'engine_task_status', 'engine_cancel_task'];

const SUBMIT_HINT = /\b(submit|send|buy|purchase|pay|checkout|place order|confirm|delete account|sign ?up|register|post|publish)\b/i;

/** @returns {string[]} permissions needed for this call (empty = none). */
export function requirementsForTool(toolName, input = {}) {
  if (ENGINE_LAYER_TOOLS.includes(toolName)) return ['integrations.use'];
  let perms = TOOL_REQUIREMENTS.get(toolName);
  if (perms === undefined) perms = ['integrations.use']; // unknown / third-party / communication / media → most restrictive group
  perms = [...perms];
  if (toolName === 'browser_press' && /^enter$/i.test(String(input?.key ?? ''))) perms.push('browser.submit_forms');
  if (toolName === 'browser_click') {
    const loc = input?.locator ?? {};
    if (SUBMIT_HINT.test(String(loc.text ?? '')) || /type\s*=\s*["']?submit/i.test(String(loc.selector ?? ''))) perms.push('browser.submit_forms');
  }
  if (toolName === 'device_open_url') perms.push('browser.navigate');
  return [...new Set(perms)];
}

/** @returns {{allowed:boolean, missing:string[], required:string[]}} */
export function checkToolAgainstProfile(profile, toolName, input = {}) {
  const required = requirementsForTool(toolName, input);
  const missing = required.filter((p) => !isAllowed(profile, p));
  return { allowed: missing.length === 0, missing, required };
}

// ------------------------------------------------------------------------------------------------------------
// Native engine tools (seen only as events) — classification + violation detection.
// ------------------------------------------------------------------------------------------------------------

const NATIVE_RULES = [
  [/^(terminal|shell|bash|sh|zsh|powershell|pwsh|cmd|exec|execute_code|code_execution|run_command|run_shell|run_terminal|process|python|python_exec|run_python)$/i, ['terminal.execute']],
  [/^(delete_file|remove_file|rm|file_delete|trash|delete_path|remove_path)$/i, ['filesystem.write', 'filesystem.delete']],
  [/^(write_file|patch|edit_file|apply_patch|create_file|file_write|file_edit|append_file|move_file|rename_file|copy_file|str_replace|str_replace_editor|replace_in_file|mkdir|make_dir)$/i, ['filesystem.write']],
  [/^(read_file|read|view_file|file_read|list_dir|list_directory|list_files|ls|search_files|find_files|grep|glob|get_file|file_search|stat_file)$/i, ['filesystem.read']],
  [/^browser_(submit|submit_form)/i, ['browser.interact', 'browser.submit_forms']],
  [/^browser_(click|type|press|scroll|select|fill|hover|drag|upload|dialog|evaluate)/i, ['browser.interact']],
  [/^browser_(navigate|open|back|forward|goto|new_tab|reload|tab)/i, ['browser.navigate']],
  [/^browser_/i, ['browser.read']],
  [/^(web_search|web_extract|web_fetch|fetch_url|http_request|search_web|web_crawl)$/i, ['network.search']],
  [/^(computer_use|computer|desktop_.*|screen_.*|mouse_.*|keyboard_.*|click_at|type_text|screenshot_desktop)$/i, ['pc.control']],
  [/^(send_message|send_email|email_.*|calendar_.*|cronjob|cron_.*|whatsapp_.*|text_to_speech|image_generate|generate_image|generate_video)$/i, ['integrations.use']],
];
// Hermes' own memory/skills are the engine's internal learning state — NOT Xoft's user memory (that is reached only through the
// Tool Gateway and governed by memory.read / memory.write there) — so they are not classified as a permission use.
const BENIGN_NATIVE = /^(todo|clarify|skills_list|skill_view|skill_search|skill_manage|vision_analyze|delegate_task|think|plan|sleep|wait|memory|memory_write|memory_add|remember|save_memory|recall|memory_read|memory_search|memory_get|session_search)$/i;
const BRIDGED = /^(mcp[_.-])?xoft([_.-]|$)/i;

/** True when the tool is one of Xoft's own (reached through the Tool Gateway) — the gateway already enforced it. */
export function isBridgedTool(name, serverName = 'xoft') {
  const n = String(name ?? '');
  return BRIDGED.test(n) || new RegExp(`^(mcp[_.-])?${serverName}([_.-]|$)`, 'i').test(n);
}

/** @returns {string[]|null} permissions the tool needs; [] for benign tools; null when the tool is not recognised. */
export function nativeToolRequirements(name) {
  const n = String(name ?? '');
  for (const [re, perms] of NATIVE_RULES) if (re.test(n)) return perms;
  if (BENIGN_NATIVE.test(n)) return [];
  return null;
}

const DESTRUCTIVE_RULES = [
  { klass: 'delete', re: /(^|[\s;&|(])rm\s+(-[a-z]*[rf][a-z]*|--recursive|--force)\b/i, reason: 'recursive/forced rm' },
  { klass: 'delete', re: /(^|[\s;&|(])(rmdir\s+\/s|rd\s+\/s|del\s+(\/[a-z]\s+)*\/[fsq]|erase\s+\/[fsq])\b/i, reason: 'recursive delete (cmd)' },
  { klass: 'delete', re: /Remove-Item\b[^|;\n]*-Recurse/i, reason: 'Remove-Item -Recurse' },
  { klass: 'delete', re: /\bshred\b|\btruncate\s+-s\s*0\b|\bunlink\b/i, reason: 'file destruction' },
  { klass: 'delete', re: /\bgit\s+clean\s+(-[a-z]*[fdx][a-z]*)/i, reason: 'git clean' },
  { klass: 'delete', re: /\bgit\s+(reset\s+--hard|checkout\s+--\s+\.|restore\s+\.)/i, reason: 'discards uncommitted work' },
  { klass: 'delete', re: /\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/i, reason: 'force push' },
  { klass: 'delete', re: /\bgit\s+branch\s+-D\b/i, reason: 'force-delete branch' },
  { klass: 'delete', re: /\b(drop\s+(table|database|schema)|truncate\s+table)\b/i, reason: 'destructive SQL' },
  { klass: 'system', re: /\bmkfs(\.[a-z0-9]+)?\b|\bdd\s+[^\n]*\bof=\/dev\/|\bformat\s+[a-z]:|>\s*\/dev\/(sd|nvme|hd)[a-z0-9]*/i, reason: 'disk-level destruction' },
  { klass: 'system', re: /:\(\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;\s*:/, reason: 'fork bomb' },
  { klass: 'system', re: /\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/i, reason: 'power control' },
  { klass: 'system', re: /\bchmod\s+-R\s+[0-7]*7[0-7]*\s+\/(\s|$)|\bchown\s+-R\b[^\n]*\s\/(\s|$)/i, reason: 'recursive permission change on /' },
  { klass: 'remote_exec', re: /\b(curl|wget|iwr|Invoke-WebRequest|irm)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b|\biex\s*\(?\s*(irm|iwr|Invoke-WebRequest)/i, reason: 'pipes a download into a shell' },
  { klass: 'privileged', re: /(^|[\s;&|(])sudo\s|(^|[\s;&|(])su\s+-|\brunas\b/i, reason: 'privilege escalation' },
];

/** @returns {{destructive:boolean, classes:string[], reasons:string[]}} */
export function detectDestructiveCommand(command) {
  const text = String(command ?? '');
  const classes = new Set();
  const reasons = [];
  for (const rule of DESTRUCTIVE_RULES) if (rule.re.test(text)) { classes.add(rule.klass); reasons.push(rule.reason); }
  return { destructive: classes.size > 0, classes: [...classes], reasons };
}

const PATH_KEYS = /^(path|paths|file|files|file_path|filepath|filename|target|source|src|dest|destdir|destination|dst|cwd|directory|dir|from|to|old_path|new_path|workdir|working_directory|archive)$/i;

/** Pulls command text and path-like arguments out of an engine tool's argument preview (JSON or plain text). */
export function parseToolPreview(preview) {
  let args = null;
  let text = '';
  if (preview && typeof preview === 'object') args = preview;
  else if (typeof preview === 'string') {
    text = preview;
    const trimmed = preview.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) { try { args = JSON.parse(trimmed); } catch { /* preview may be truncated JSON */ } }
  }
  const paths = [];
  let command = null;
  const walk = (obj, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 3) return;
    for (const [k, v] of Object.entries(obj)) {
      if (PATH_KEYS.test(k)) for (const item of (Array.isArray(v) ? v : [v])) if (typeof item === 'string' && item) paths.push(item);
      if (/^(command|cmd|code|script|commands)$/i.test(k) && command === null) command = Array.isArray(v) ? v.join('\n') : (typeof v === 'string' ? v : null);
      if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };
  if (args) walk(args);
  else if (text) {
    // truncated / non-JSON preview: best-effort extraction
    const m = text.match(/"(?:command|cmd|code)"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (m) command = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    for (const pm of text.matchAll(/"(?:path|file_path|filepath|file|target|dest|destination|cwd)"\s*:\s*"((?:[^"\\]|\\.)*)"/gi)) paths.push(pm[1]);
    if (command === null && !text.trim().startsWith('{')) command = text;
  }
  return { args, command, paths: [...new Set(paths)] };
}

/**
 * Decide whether a native engine tool starting (as reported in its event stream) breaks the task's policy.
 * Returns `null` when fine, otherwise `{ code, permission?, message }`.
 */
export function evaluateNativeToolEvent(profile, { tool, preview }, { allowedRoots = [], workingDirectory = null, strictReadScope = false, bridgeName = 'xoft' } = {}) {
  if (isBridgedTool(tool, bridgeName)) return null; // the Tool Gateway enforces these before execution
  const requirements = nativeToolRequirements(tool);
  if (requirements === null) return null; // unknown tool: cannot classify — surfaced in health, never guessed at
  const missing = requirements.filter((p) => !isAllowed(profile, p));
  if (missing.length) return { code: 'permission_denied', permission: missing[0], message: `Tool '${tool}' needs ${missing.join(', ')} which this task's permission profile does not grant.` };

  const { command, paths } = parseToolPreview(preview);

  if (requirements.includes('terminal.execute') && command) {
    const verdict = detectDestructiveCommand(command);
    if (verdict.classes.includes('delete') && !isAllowed(profile, 'filesystem.delete')) {
      return { code: 'destructive_command', permission: 'filesystem.delete', message: `Command looks destructive (${verdict.reasons.join(', ')}) and filesystem.delete is not granted.` };
    }
    const unsafeClasses = verdict.classes.filter((c) => c !== 'delete');
    if (unsafeClasses.length && !isAllowed(profile, 'terminal.unsafe')) {
      return { code: 'unsafe_command', permission: 'terminal.unsafe', message: `Command is ${unsafeClasses.join('/')}-class (${verdict.reasons.join(', ')}); terminal.unsafe is not granted.` };
    }
  }

  const roots = allowedRoots.filter(Boolean).map((r) => path.resolve(r));
  const writesOrDeletes = requirements.includes('filesystem.write') || requirements.includes('filesystem.delete');
  for (const p of paths) {
    const abs = path.resolve(workingDirectory ?? process.cwd(), p);
    if (isSensitivePath(abs)) return { code: 'sensitive_path', message: `Tool '${tool}' touched a protected path (${path.basename(abs)}).` };
    if (roots.length && (writesOrDeletes || strictReadScope) && !roots.some((r) => isInside(abs, r))) {
      return { code: 'outside_workspace', message: `Tool '${tool}' targeted a path outside the task's allowed directories.` };
    }
  }
  return null;
}

/** Classifies a native tool event into file-change notifications for the observability layer. */
export function fileChangeFromToolEvent({ tool, preview }) {
  const reqs = nativeToolRequirements(tool) ?? [];
  const { paths } = parseToolPreview(preview);
  if (!paths.length) return null;
  if (reqs.includes('filesystem.delete')) return { kind: 'deleted', paths };
  if (reqs.includes('filesystem.write')) return { kind: /^(create_file|write_file|mkdir|make_dir)$/i.test(tool) ? 'created' : 'modified', paths };
  return null;
}
