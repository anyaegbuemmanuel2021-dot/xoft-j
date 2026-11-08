import { Tool, RiskLevel } from '../Tool.js';
import { DeviceRiskLevel } from '../../devices/DeviceManager.js';

/**
 * Device Runtime tools — the AI-facing surface of the pc-agent's DeviceRuntime
 * (browser automation over CDP, file intelligence with recovery, terminal, workspaces, journal).
 *
 * Design rules (see docs/DEVICE_RUNTIME.md):
 *  - Every tool queues a real command to a real agent via DeviceManager and returns only what the
 *    agent verified. No agent online => a real error, never a fabricated success.
 *  - There is deliberately NO tool for: arbitrary JavaScript in a page, arbitrary shell commands,
 *    registering/removing workspaces, or forcing an undo over newer changes. Those are not exposed.
 *  - Risk levels feed the existing ApprovalSystem/DomainAutonomy: observation SAFE, page interaction and
 *    recoverable file edits LOW, deletes/terminal/undo EXTERNAL (approval unless autonomy level allows).
 *  - Agent-side ActionPolicy is a second, independent gate behind these.
 */
const DRM = DeviceRiskLevel;
const dev = { deviceId: { type: 'string', description: 'Target device id from GET /api/devices' } };
const locator = { type: 'object', description: 'Exactly one of {selector} (CSS) or {text} (visible text); optional index to pick the nth match.', properties: { selector: { type: 'string', maxLength: 500 }, text: { type: 'string', maxLength: 200 }, index: { type: 'integer', minimum: 0 } } };
const ctxOf = (ctx) => ({ missionId: ctx?.missionId ?? ctx?.taskId ?? null, agent: ctx?.agent ?? 'xoft', reason: ctx?.reason ?? null });

export function buildRuntimeTools({ deviceManager }) {
  const status = 'PARTIALLY_IMPLEMENTED'; // routing + verification pipeline real; needs the pc-agent online (browser tools also need Chrome — see docs)
  const run = (capability, action, riskLevel, timeoutMs) => (params, ctx) =>
    deviceManager.execute({ deviceId: params.deviceId, capability, action, parameters: (({ deviceId, ...rest }) => ({ ...rest, _context: ctxOf(ctx) }))(params), riskLevel, requestedBy: 'xoft', timeoutMs });
  const T = (name, description, properties, required, requiredPermissions, riskLevel, exec) =>
    new Tool({ name, description, inputSchema: { type: 'object', properties: { ...dev, ...properties }, required: ['deviceId', ...required] }, requiredPermissions, riskLevel, status, execute: exec });

  return [
    // ---------------- browser (CDP) ----------------
    T('browser_list_tabs', 'List open browser tabs (id, title, url) on the device. Requires Chrome/Chromium with remote debugging enabled.', {}, [], ['browser.read'], RiskLevel.SAFE, run('browser', 'list_tabs', DRM.LOW)),
    T('browser_attach_tab', 'Attach to an existing browser tab by id so later browser_* calls act on it.', { tabId: { type: 'string' } }, ['tabId'], ['browser.read'], RiskLevel.LOW, run('browser', 'attach_tab', DRM.LOW)),
    T('browser_new_tab', 'Open a new tab (http/https only) and attach to it.', { url: { type: 'string' } }, [], ['browser.navigate'], RiskLevel.LOW, run('browser', 'new_tab', DRM.LOW)),
    T('browser_navigate', 'Navigate the attached tab to an http/https URL and wait for load. Returns the final URL and whether it redirected to a different host.', { url: { type: 'string' } }, ['url'], ['browser.navigate'], RiskLevel.LOW, run('browser', 'navigate', DRM.LOW, 45000)),
    T('browser_back', 'Go back in the attached tab history.', {}, [], ['browser.navigate'], RiskLevel.LOW, run('browser', 'back', DRM.LOW, 45000)),
    T('browser_forward', 'Go forward in the attached tab history.', {}, [], ['browser.navigate'], RiskLevel.LOW, run('browser', 'forward', DRM.LOW, 45000)),
    T('browser_reload', 'Reload the attached tab.', {}, [], ['browser.navigate'], RiskLevel.LOW, run('browser', 'reload', DRM.LOW, 45000)),
    T('browser_get_page', 'Current URL, title, readyState and counts of links/buttons/forms/inputs.', {}, [], ['browser.read'], RiskLevel.SAFE, run('browser', 'get_page', DRM.LOW)),
    T('browser_get_dom', 'Compact structured snapshot of interactive elements and forms (not raw HTML). Password/card/OTP field values are always redacted.', { limit: { type: 'integer', minimum: 1, maximum: 400 } }, [], ['browser.read'], RiskLevel.SAFE, run('browser', 'get_dom', DRM.LOW)),
    T('browser_query', 'Find elements by CSS selector or visible text; returns tag, text, attributes, visibility, disabled/checked state and position.', { locator, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['locator'], ['browser.read'], RiskLevel.SAFE, run('browser', 'query_selector', DRM.LOW)),
    T('browser_click', 'Click an element (scrolls into view; refuses hidden, disabled or covered elements). Reports whether the page actually changed.', { locator }, ['locator'], ['browser.interact'], RiskLevel.LOW, run('browser', 'click', DRM.LOW, 30000)),
    T('browser_type', 'Type text into an element without clearing it.', { locator, text: { type: 'string', maxLength: 5000 } }, ['locator', 'text'], ['browser.interact'], RiskLevel.LOW, run('browser', 'type', DRM.LOW)),
    T('browser_fill', 'Clear and fill an input, then read the value back to verify it took.', { locator, text: { type: 'string', maxLength: 5000 } }, ['locator', 'text'], ['browser.interact'], RiskLevel.LOW, run('browser', 'fill', DRM.LOW)),
    T('browser_press', 'Press a key: Enter, Tab, Escape, Backspace, Delete, Space, Arrow keys, Home, End, PageUp, PageDown.', { key: { type: 'string' } }, ['key'], ['browser.interact'], RiskLevel.LOW, run('browser', 'press', DRM.LOW)),
    T('browser_scroll', 'Scroll the page by x/y pixels, or scroll an element into view.', { x: { type: 'number' }, y: { type: 'number' }, locator }, [], ['browser.interact'], RiskLevel.LOW, run('browser', 'scroll', DRM.LOW)),
    T('browser_wait_for', 'Wait until an element is attached | visible | hidden | detached (max 30s).', { locator, state: { type: 'string', enum: ['attached', 'visible', 'hidden', 'detached'] }, timeoutMs: { type: 'integer', minimum: 100, maximum: 30000 } }, ['locator'], ['browser.read'], RiskLevel.SAFE, run('browser', 'wait_for', DRM.LOW, 40000)),
    T('browser_get_text', 'Visible text of an element, or of the whole page when no locator is given. Secret fields return [redacted].', { locator, maxChars: { type: 'integer', minimum: 1, maximum: 100000 } }, [], ['browser.read'], RiskLevel.SAFE, run('browser', 'get_text', DRM.LOW)),
    T('browser_get_attribute', 'Read one attribute of an element (e.g. href, value). Secret field values are redacted.', { locator, name: { type: 'string' } }, ['locator', 'name'], ['browser.read'], RiskLevel.SAFE, run('browser', 'get_attribute', DRM.LOW)),
    T('browser_screenshot', 'Screenshot of the attached tab (viewport or full page) as base64 PNG.', { fullPage: { type: 'boolean' } }, [], ['browser.read'], RiskLevel.SAFE, run('browser', 'screenshot', DRM.LOW, 45000)),
    T('browser_element_screenshot', 'Screenshot of a single element as base64 PNG.', { locator }, ['locator'], ['browser.read'], RiskLevel.SAFE, run('browser', 'element_screenshot', DRM.LOW, 45000)),

    // ---------------- files (workspace-bounded, journaled, recoverable) ----------------
    T('file_search', 'Search registered workspaces by file name / glob (kind:name), content (kind:content) or both. Skips node_modules/.git; never reads secrets.', { query: { type: 'string', maxLength: 200 }, path: { type: 'string' }, kind: { type: 'string', enum: ['name', 'content', 'both'] }, extensions: { type: 'array', items: { type: 'string' } }, maxResults: { type: 'integer', minimum: 1, maximum: 200 } }, ['query'], ['files.read'], RiskLevel.SAFE, run('files', 'search', DRM.LOW, 30000)),
    T('file_locate', 'Locate a project or file from a natural description (e.g. "browser executor", "SocialPulse").', { query: { type: 'string' } }, ['query'], ['files.read'], RiskLevel.SAFE, run('files', 'locate', DRM.LOW, 30000)),
    T('file_inspect', 'Metadata, workspace/project association, and (for JS/TS) imports, related files, package dependencies and exports.', { path: { type: 'string' } }, ['path'], ['files.read'], RiskLevel.SAFE, run('files', 'inspect', DRM.LOW)),
    T('file_read', 'Read a text file (optionally a line range). Sensitive files (.env, keys, tokens) are refused; embedded secrets are redacted.', { path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } }, ['path'], ['files.read'], RiskLevel.SAFE, run('files', 'read', DRM.LOW)),
    T('file_list', 'List a directory inside a workspace (sensitive files are flagged).', { path: { type: 'string' } }, ['path'], ['files.read'], RiskLevel.SAFE, run('files', 'list', DRM.LOW)),
    T('file_compare', 'Compare two files (identical check + line diff).', { a: { type: 'string' }, b: { type: 'string' } }, ['a', 'b'], ['files.read'], RiskLevel.SAFE, run('files', 'compare', DRM.LOW)),
    T('file_history', 'Journal history for a file: past operations, and which can be rolled back.', { path: { type: 'string' } }, ['path'], ['operations.read'], RiskLevel.SAFE, run('files', 'history', DRM.LOW)),
    T('file_create', 'Create a NEW file (fails if it exists). Verified by read-back hash and journaled.', { path: { type: 'string' }, content: { type: 'string' }, reason: { type: 'string' } }, ['path', 'content'], ['files.write'], RiskLevel.LOW, run('files', 'create', DRM.MEDIUM)),
    T('file_write', 'Write a file. Overwriting requires overwrite:true and takes a checkpoint first.', { path: { type: 'string' }, content: { type: 'string' }, overwrite: { type: 'boolean' }, createDirs: { type: 'boolean' }, reason: { type: 'string' } }, ['path', 'content'], ['files.write'], RiskLevel.LOW, run('files', 'write', DRM.MEDIUM)),
    T('file_edit', 'Targeted edit: {find, replace} (must match exactly expectedCount times, default 1) or {startLine, endLine, replacement}. Checkpointed, verified, journaled. Prefer this over rewriting files.', { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' }, replacement: { type: 'string' }, expectedCount: { type: 'integer', minimum: 1 }, reason: { type: 'string' } }, ['path'], ['files.write'], RiskLevel.LOW, run('files', 'edit', DRM.MEDIUM)),
    T('file_copy', 'Copy a file or directory inside workspaces (sensitive files are skipped).', { from: { type: 'string' }, to: { type: 'string' }, overwrite: { type: 'boolean' }, reason: { type: 'string' } }, ['from', 'to'], ['files.write'], RiskLevel.LOW, run('files', 'copy', DRM.MEDIUM)),
    T('file_move', 'Move a file or directory. An overwritten destination goes to recovery.', { from: { type: 'string' }, to: { type: 'string' }, overwrite: { type: 'boolean' }, reason: { type: 'string' } }, ['from', 'to'], ['files.move'], RiskLevel.LOW, run('files', 'move', DRM.MEDIUM)),
    T('file_rename', 'Rename a file or directory (plain new name, no path).', { path: { type: 'string' }, newName: { type: 'string' }, reason: { type: 'string' } }, ['path', 'newName'], ['files.rename'], RiskLevel.LOW, run('files', 'rename', DRM.MEDIUM)),
    T('file_archive', 'Create a .tar.gz of sibling paths (secret-like files excluded) with a verified listing.', { paths: { type: 'array', items: { type: 'string' } }, dest: { type: 'string' }, reason: { type: 'string' } }, ['paths', 'dest'], ['files.write'], RiskLevel.LOW, run('files', 'archive', DRM.MEDIUM, 150000)),
    T('file_extract', 'Extract a .tar.gz into an empty/new directory; archives with path traversal or links are refused.', { archive: { type: 'string' }, destDir: { type: 'string' }, reason: { type: 'string' } }, ['archive', 'destDir'], ['files.write'], RiskLevel.LOW, run('files', 'extract', DRM.MEDIUM, 150000)),
    T('file_open', 'Open a workspace file in the OS default program (or an appAllowlist app). Executables and scripts are never opened; success only means the launcher started.', { path: { type: 'string' }, application: { type: 'string' } }, ['path'], ['apps.launch'], RiskLevel.LOW, run('applications', 'open_file', DRM.MEDIUM)),
    T('file_delete', 'Delete a file or directory by moving it to XOFT recovery (never permanent). Undo with file_restore.', { path: { type: 'string' }, reason: { type: 'string' } }, ['path'], ['files.delete'], RiskLevel.EXTERNAL, run('files', 'delete', DRM.HIGH)),
    T('file_restore', 'Undo one journaled operation by id (restores checkpoint / trash / move). Refuses if the file changed since — never overwrites newer work.', { operationId: { type: 'integer' }, reason: { type: 'string' } }, ['operationId'], ['operations.undo', 'files.write'], RiskLevel.EXTERNAL, run('files', 'restore', DRM.HIGH)),
    T('file_undo_last', '"Undo what you just did": reverts the most recent rollback-able operation.', {}, [], ['operations.undo', 'files.write'], RiskLevel.EXTERNAL, run('files', 'undo_last', DRM.HIGH)),
    T('file_restore_version', 'Restore a file to the version it had before the first recorded edit after a given time ("yesterday\'s version").', { path: { type: 'string' }, asOf: { type: 'string', description: 'ISO date/time' } }, ['path', 'asOf'], ['operations.undo', 'files.write'], RiskLevel.EXTERNAL, run('files', 'restore_version', DRM.HIGH)),

    // ---------------- workspaces / operations / terminal ----------------
    T('workspace_list', 'List registered workspaces and which is active. (Registering workspaces is only possible locally on the device.)', {}, [], ['workspace.read'], RiskLevel.SAFE, run('workspace', 'list', DRM.LOW)),
    T('workspace_set_active', 'Set the active workspace used to resolve relative paths.', { name: { type: 'string' } }, ['name'], ['workspace.select'], RiskLevel.LOW, run('workspace', 'set_active', DRM.LOW)),
    T('workspace_inspect', 'Detect project type, package manager, scripts, entry points, dependencies and test/build commands for a workspace.', { name: { type: 'string' } }, [], ['workspace.read'], RiskLevel.SAFE, run('workspace', 'inspect_project', DRM.LOW)),
    T('workspace_locate_project', 'Find a project folder by fuzzy name across workspaces.', { query: { type: 'string' } }, ['query'], ['workspace.read'], RiskLevel.SAFE, run('workspace', 'locate_project', DRM.LOW, 30000)),
    T('operations_list', 'Recent journaled operations (action, target, reason, mission, agent, result, rollback availability).', { limit: { type: 'integer', minimum: 1, maximum: 200 } }, [], ['operations.read'], RiskLevel.SAFE, run('operations', 'list', DRM.LOW)),
    T('terminal_run', 'Run ONE allowlisted command without a shell: read-only git (status/diff/log/branch/show), --version checks, or project checks (npm|pnpm|yarn test, run <script from package.json>, node --test, pytest). Anything else is refused. Secrets are not inherited and output is redacted; the process tree is killed on timeout or halt.', { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' }, maxItems: 20 }, cwd: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 }, reason: { type: 'string' } }, ['command'], ['terminal.safe'], RiskLevel.EXTERNAL, run('terminal', 'run', DRM.HIGH, 620000)),

    // ---------------- runtime control ----------------
    T('runtime_status', 'Device Runtime status: halted?, active workspace, browser connection, interrupted operations, local policy.', {}, [], ['workspace.read'], RiskLevel.SAFE, run('runtime', 'status', DRM.LOW)),
    T('runtime_recover_browser', 'Bounded self-healing: drop and re-establish the browser debugging connection (max 3 automatic attempts / 10 min).', {}, [], ['browser.read'], RiskLevel.LOW, run('runtime', 'recover_browser', DRM.LOW, 30000)),
    T('runtime_halt', 'Immediately halt ALL actions on the device (kills running terminal processes). Only a human can resume it locally.', { reason: { type: 'string' } }, [], ['runtime.halt'], RiskLevel.SAFE, run('runtime', 'halt', DRM.LOW)),
  ];
}
