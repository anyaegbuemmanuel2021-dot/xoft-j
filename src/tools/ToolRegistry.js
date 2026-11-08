/**
 * ToolRegistry — every tool the system can call lives here. Nothing outside
 * this class invokes a tool's execute function directly; that keeps
 * permission checks and logging in one enforced place instead of scattered
 * across agents.
 */
/**
 * Small dependency-free JSON Schema validator for the schema subset used by
 * XOFT tools. Tool schemas are already sent to models; enforce the same
 * contract at execution time so malformed model output cannot reach handlers.
 */
function schemaErrors(value, schema, path = 'input') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const errors = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const matchesType = (v, type) => {
    if (type === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
    if (type === 'array') return Array.isArray(v);
    if (type === 'integer') return Number.isInteger(v);
    if (type === 'number') return typeof v === 'number' && Number.isFinite(v);
    if (type === 'string') return typeof v === 'string';
    if (type === 'boolean') return typeof v === 'boolean';
    if (type === 'null') return v === null;
    return true;
  };

  if (types.length && !types.some((type) => matchesType(value, type))) {
    return [`${path} must be ${types.join(' or ')}.`];
  }
  if (Object.hasOwn(schema, 'const') && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${path} must equal the declared constant.`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push(`${path} must be one of the allowed values.`);
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) errors.push(`${path} is shorter than the minimum length ${schema.minLength}.`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) errors.push(`${path} exceeds the maximum length ${schema.maxLength}.`);
    if (schema.pattern) {
      try { if (!(new RegExp(schema.pattern)).test(value)) errors.push(`${path} does not match the required pattern.`); }
      catch { errors.push(`${path} has an invalid schema pattern.`); }
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push(`${path} must be at least ${schema.minimum}.`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) errors.push(`${path} must be at most ${schema.maximum}.`);
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) errors.push(`${path} must contain at least ${schema.minItems} item(s).`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(`${path} must contain at most ${schema.maxItems} item(s).`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${path} must not contain duplicate items.`);
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, index) => errors.push(...schemaErrors(item, schema.items, `${path}[${index}]`)));
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) errors.push(`${path}.${required} is required.`);
    }
    if (Number.isInteger(schema.minProperties) && Object.keys(value).length < schema.minProperties) errors.push(`${path} must contain at least ${schema.minProperties} propert(ies).`);
    if (Number.isInteger(schema.maxProperties) && Object.keys(value).length > schema.maxProperties) errors.push(`${path} must contain at most ${schema.maxProperties} propert(ies).`);
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) errors.push(...schemaErrors(child, properties[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed.`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...schemaErrors(child, schema.additionalProperties, `${path}.${key}`));
      }
    }
  }

  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (!Array.isArray(schema[keyword])) continue;
    const matches = schema[keyword].filter((part) => schemaErrors(value, part, path).length === 0).length;
    if (keyword === 'allOf' && matches !== schema[keyword].length) errors.push(`${path} does not satisfy all required schemas.`);
    if (keyword === 'anyOf' && matches === 0) errors.push(`${path} does not satisfy any allowed schema.`);
    if (keyword === 'oneOf' && matches !== 1) errors.push(`${path} must satisfy exactly one allowed schema.`);
  }
  return errors;
}

function assertValidToolInput(toolName, input, schema) {
  const errors = schemaErrors(input, schema);
  if (errors.length) throw new Error(`ToolRegistry: invalid input for '${toolName}': ${errors.slice(0, 5).join(' ')}`);
}

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
    assertValidToolInput(toolName, input, tool.inputSchema);

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
