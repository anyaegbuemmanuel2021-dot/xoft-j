import { JsonStore } from '../persistence/JsonStore.js';

/**
 * Domains XOFT actually has tools in, mapped from real registered tool
 * names — not an aspirational list. 'general' is the fallback for any tool
 * that doesn't match a more specific domain (e.g. calculate, get_current_time).
 */
export const DOMAINS = ['files', 'browser', 'devices', 'communication', 'social', 'finance', 'memory', 'media', 'terminal', 'general'];

const TOOL_DOMAIN = {
  device_list_files: 'files', device_transfer_file: 'files',
  device_open_url: 'browser', device_screen_capture: 'browser', device_screen_click: 'browser',
  device_screen_type: 'browser', device_screen_scroll: 'browser', device_screen_understand: 'browser', device_screen_verify: 'browser',
  device_computer_use: 'devices', device_get_state: 'devices', device_launch_app: 'devices', device_close_app: 'devices',
  device_list_apps: 'devices', device_restart_app: 'devices', device_media_control: 'devices',
  send_email: 'communication', read_email: 'communication', search_emails: 'communication',
  send_whatsapp_message: 'communication', make_phone_call: 'communication',
  create_calendar_event: 'communication', delete_calendar_event: 'communication', list_calendar_events: 'communication', find_available_time: 'communication',
  device_social_post: 'social', device_social_open: 'social',
  remember_fact: 'memory', recall_facts: 'memory', forget_facts: 'memory', forget_fact_by_id: 'memory', restore_facts: 'memory',
  generate_image: 'media', generate_video: 'media', check_video_generation: 'media',
};

// Device Runtime tools (src/tools/builtins/runtimeTools.js) — browser automation, file intelligence, terminal.
for (const n of ['browser_list_tabs', 'browser_attach_tab', 'browser_new_tab', 'browser_navigate', 'browser_back', 'browser_forward', 'browser_reload', 'browser_get_page', 'browser_get_dom', 'browser_query', 'browser_click', 'browser_type', 'browser_fill', 'browser_press', 'browser_scroll', 'browser_wait_for', 'browser_get_text', 'browser_get_attribute', 'browser_screenshot', 'browser_element_screenshot']) TOOL_DOMAIN[n] = 'browser';
for (const n of ['file_search', 'file_locate', 'file_inspect', 'file_read', 'file_list', 'file_compare', 'file_write', 'file_create', 'file_edit', 'file_delete', 'file_move', 'file_copy', 'file_rename', 'file_archive', 'file_extract', 'file_history', 'file_open', 'file_restore', 'file_undo_last', 'file_restore_version', 'workspace_list', 'workspace_set_active', 'workspace_inspect', 'workspace_locate_project', 'operations_list']) TOOL_DOMAIN[n] = 'files';
TOOL_DOMAIN.terminal_run = 'terminal';
TOOL_DOMAIN.runtime_halt = 'devices'; TOOL_DOMAIN.runtime_status = 'devices'; TOOL_DOMAIN.runtime_recover_browser = 'devices';

/** Best-effort domain for a tool name — 'finance' has no tools yet (spec gap: no payment/transaction tool exists in this codebase), kept in DOMAINS so a level can be pre-set for when one is added. */
export function domainForTool(toolName) {
  return TOOL_DOMAIN[toolName] ?? 'general';
}

/**
 * DomainAutonomy — per-domain autonomy levels (spec: "per-domain autonomy
 * — files/browser/finance/…"), layered ON TOP of the existing global
 * AutonomyManager level rather than replacing it. A domain with no
 * explicit override uses the global level unchanged (today's behavior);
 * setting a domain override narrows or widens autonomy for just that
 * domain. HIGH_IMPACT tools are still never auto-approved by
 * ApprovalSystem regardless of any level set here — this module cannot
 * override that floor, by construction (see ApprovalSystem.evaluate).
 */
export class DomainAutonomy {
  constructor({ dataDir = './data', activityLog, eventBus, sqliteStore = null } = {}) {
    this._store = new JsonStore({ dataDir, fileName: 'domain-autonomy.json', kvKey: 'domain_autonomy', defaultValue: { overrides: {} }, sqliteStore });
    this.activityLog = activityLog;
    this.eventBus = eventBus;
  }

  _load() { return this._store.load(); }

  /** Explicit per-domain overrides only (does not fill in the global default — callers combine with AutonomyManager.get().level themselves). */
  list() { return this._load().overrides; }

  get(domain) {
    return this._load().overrides[domain] ?? null;
  }

  set(domain, level, reason = 'user change') {
    if (!DOMAINS.includes(domain)) throw new Error(`DomainAutonomy: unknown domain '${domain}'. Known: ${DOMAINS.join(', ')}`);
    const n = Number(level);
    if (!Number.isInteger(n) || n < 0 || n > 5) throw new Error('Autonomy level must be an integer from 0 to 5');
    const data = this._load();
    data.overrides[domain] = n;
    this._store.save(data);
    this.activityLog?.log({ type: 'domain_autonomy_changed', detail: { domain, level: n, reason } });
    this.eventBus?.emitEvent('autonomy.domain_changed', { domain, level: n, reason });
    return { domain, level: n };
  }

  clear(domain) {
    const data = this._load();
    delete data.overrides[domain];
    this._store.save(data);
    this.activityLog?.log({ type: 'domain_autonomy_cleared', detail: { domain } });
    return { domain, cleared: true };
  }

  /** Effective level for a domain: explicit override if set, otherwise the global level. */
  effectiveLevel(domain, globalLevel) {
    const override = this.get(domain);
    return override ?? globalLevel;
  }
}
