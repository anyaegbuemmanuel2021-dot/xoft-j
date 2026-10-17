'use strict';
/**
 * Agent-side action policy — defense in depth BEHIND core's PermissionSystem / ApprovalSystem /
 * per-domain autonomy. Core decides whether a command is issued; this decides whether THIS
 * machine is willing to run it. 'confirm' cannot be answered locally (the agent has no UI), so it
 * is refused with an instruction to use core's approval flow.
 */
const ACTION_CLASS = {
  browser: { observe: ['list_tabs', 'get_page', 'get_dom', 'query_selector', 'get_text', 'get_attribute', 'screenshot', 'element_screenshot', 'wait_for', 'wait_for_navigation'],
    navigate: ['navigate', 'back', 'forward', 'reload', 'new_tab', 'attach_tab'], interact: ['click', 'type', 'fill', 'press', 'scroll'] },
  file: { read: ['search', 'locate', 'inspect', 'read', 'compare', 'list', 'watch'], write: ['write', 'create', 'edit', 'copy', 'archive', 'extract'],
    move: ['move', 'rename'], delete: ['delete'], restore: ['restore', 'undo'] },
  terminal: { safe: ['safe'], build: ['build'], other: ['other'] },
  app: { observe: ['list', 'processes'], launch: ['launch', 'focus', 'open_file'], close: ['close'] },
};

const DEFAULTS = {
  'browser.observe': 'allow', 'browser.navigate': 'allow', 'browser.interact': 'allow',
  'file.read': 'allow', 'file.write': 'allow', 'file.move': 'allow', 'file.delete': 'allow', 'file.restore': 'allow',
  'terminal.safe': 'allow', 'terminal.build': 'confirm', 'terminal.other': 'deny',
  'app.observe': 'allow', 'app.launch': 'allow', 'app.close': 'confirm',
};

const MUTATING = new Set(['browser.navigate', 'browser.interact', 'file.write', 'file.move', 'file.delete', 'file.restore', 'terminal.safe', 'terminal.build', 'terminal.other', 'app.launch', 'app.close']);

function classify(capabilityAction) {
  const [domain, action] = String(capabilityAction).split('.');
  const classes = ACTION_CLASS[domain];
  if (!classes) return null;
  for (const [cls, actions] of Object.entries(classes)) if (actions.includes(action)) return `${domain}.${cls}`;
  return null;
}

class ActionPolicy {
  constructor(overrides = {}) {
    for (const [k, v] of Object.entries(overrides)) {
      if (!(k in DEFAULTS)) throw new Error(`ActionPolicy: unknown policy class '${k}'. Known: ${Object.keys(DEFAULTS).join(', ')}`);
      if (!['allow', 'confirm', 'deny'].includes(v)) throw new Error(`ActionPolicy: '${k}' must be allow|confirm|deny`);
    }
    this.levels = { ...DEFAULTS, ...overrides };
  }
  /** Unknown actions are denied — the policy is an allowlist, not a blocklist. */
  decide(capabilityAction) {
    const cls = classify(capabilityAction);
    if (!cls) return { level: 'deny', cls: null, reason: `'${capabilityAction}' is not a recognised action` };
    return { level: this.levels[cls], cls, mutating: MUTATING.has(cls), reason: this.levels[cls] === 'allow' ? null : this.levels[cls] === 'confirm' ? `'${capabilityAction}' (${cls}) requires human approval — route it through xoft-core approvals` : `'${capabilityAction}' (${cls}) is denied by local policy` };
  }
}

module.exports = { ActionPolicy, classify, DEFAULTS, MUTATING };
