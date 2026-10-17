/**
 * ToolRegistry — every tool the system can call lives here. Nothing outside
 * this class invokes a tool's execute function directly; that keeps
 * permission checks and logging in one enforced place instead of scattered
 * across agents.
 */
export class ToolRegistry {
  /**
   * @param {object} [deps]
   * @param {import('../security/EmergencyStop.js').EmergencyStop} [deps.emergencyStop]
   * @param {import('../security/PermissionSystem.js').PermissionSystem} [deps.permissionEngine]
   *   If provided, every execute() call with a tool that has requiredPermissions
   *   is actually gated on it — this was previously defined (checkPermissions)
   *   but never enforced anywhere. Omit to run without enforcement (e.g. tests).
   * @param {string} [deps.defaultDeviceId] which device's grants to check when
   *   the caller doesn't specify one via ctx.deviceId — represents the
   *   server-initiated context (TaskPlanner, RulesEngine, MonitorManager).
   */
  constructor(deps = {}) {
    /** @type {Map<string, import('./Tool.js').Tool>} */
    this.tools = new Map();
    this.emergencyStop = deps.emergencyStop ?? null;
    this.permissionEngine = deps.permissionEngine ?? null;
    this.defaultDeviceId = deps.defaultDeviceId ?? 'local';
  }

  register(tool) {
    if (this.tools.has(tool.name)) {
      throw new Error(`ToolRegistry: a tool named '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`ToolRegistry: no tool named '${name}'`);
    return tool;
  }

  has(name) {
    return this.tools.has(name);
  }

  list() {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      riskLevel: t.riskLevel,
      requiredPermissions: t.requiredPermissions,
      status: t.status,
    }));
  }

  /** Schema shape usable directly as AI provider tool definitions. */
  schemasForAI() {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  /**
   * Checks a tool's required permissions against a granted-permissions set.
   * Kept for callers that want a dry check without executing (e.g. a UI
   * showing which tools a device can currently use).
   * @param {string} toolName
   * @param {Set<string>|string[]} grantedPermissions
   * @returns {{allowed:boolean, missing:string[]}}
   */
  checkPermissions(toolName, grantedPermissions) {
    const tool = this.get(toolName);
    const granted = grantedPermissions instanceof Set ? grantedPermissions : new Set(grantedPermissions);
    const missing = tool.requiredPermissions.filter((p) => !granted.has(p));
    return { allowed: missing.length === 0, missing };
  }

  /**
   * Executes a tool. Gates on, in order: emergency stop, then permission
   * (if a permissionEngine is configured and the tool declares
   * requiredPermissions), then the tool's own implementation-status check
   * inside tool.run(). Permission is checked fresh on every call — nothing
   * cached, so a revoke takes effect on the very next execution.
   */
  async execute(toolName, input, ctx = {}) {
    this.emergencyStop?.assertNotStopped();
    const tool = this.get(toolName);

    if (this.permissionEngine && tool.requiredPermissions.length > 0) {
      const deviceId = ctx.deviceId ?? this.defaultDeviceId;
      const missing = tool.requiredPermissions.filter((p) => !this.permissionEngine.check(deviceId, p));
      if (missing.length > 0) {
        throw new Error(
          `ToolRegistry: '${toolName}' requires permission(s) not granted to device '${deviceId}': ${missing.join(', ')}. ` +
            `Grant via POST /api/devices/${deviceId}/permissions.`
        );
      }
      for (const p of tool.requiredPermissions) this.permissionEngine.markUsed(deviceId, p);
    }

    return tool.run(input, ctx);
  }
}
