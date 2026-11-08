/**
 * Tool — describes one capability the system can execute.
 *
 * Per the spec: every tool exposes name, description, input schema, required
 * permissions, risk level, approval requirement, execution handler, result
 * schema. Nothing gets called by name-guessing; the registry is the only
 * thing that invokes `execute`.
 */

export const RiskLevel = {
  SAFE: 0, // read-only, reversible, internal — auto-executes always
  LOW: 1, // reversible, low-impact — auto-executes unless user config says otherwise
  EXTERNAL: 2, // touches the outside world — approval required by default
  HIGH_IMPACT: 3, // financial, destructive, irreversible — approval ALWAYS required, no override
};

export class Tool {
  /**
   * @param {object} def
   * @param {string} def.name
   * @param {string} def.description
   * @param {object} def.inputSchema JSON-schema-ish shape, used for both AI tool-calling and validation
   * @param {string[]} [def.requiredPermissions] permission strings that must be granted (see PermissionSystem later)
   * @param {number} def.riskLevel one of RiskLevel
   * @param {(input:object, ctx:object) => Promise<object>} def.execute
   * @param {string} [def.status] IMPLEMENTED | PARTIALLY_IMPLEMENTED | REQUIRES_API | REQUIRES_DEVICE_PERMISSION | REQUIRES_THIRD_PARTY_SERVICE | NOT_CURRENTLY_POSSIBLE
   * @param {(input:object, result:object) => ({toolName:string, input:object}|null)} [def.computeUndo]
   *   Given the input and result of a successful run, returns the tool call
   *   that would reverse it, or null if this tool's effect isn't reversible.
   * @param {(input:object, result:object, ctx:object) => Promise<{verified:boolean, note?:string}>} [def.verify]
   *   Independent post-hoc check that the action actually took effect (spec:
   *   "self-verification" — success is never assumed just because the call
   *   didn't throw). Optional: a tool without one is simply unverifiable,
   *   which TaskPlanner records honestly rather than treating as verified.
   */
  constructor(def) {
    this.name = def.name;
    this.description = def.description;
    this.inputSchema = def.inputSchema ?? { type: 'object', properties: {} };
    this.requiredPermissions = def.requiredPermissions ?? [];
    this.riskLevel = def.riskLevel ?? RiskLevel.SAFE;
    this._execute = def.execute;
    this.status = def.status ?? 'IMPLEMENTED';
    this.computeUndo = def.computeUndo ?? null;
    this.verify = def.verify ?? null;
  }

  async run(input, ctx) {
    if (this.status !== 'IMPLEMENTED' && this.status !== 'PARTIALLY_IMPLEMENTED') {
      throw new Error(
        `Tool '${this.name}' is not runnable in this environment (status: ${this.status}). ` +
          `It has not been faked — it genuinely cannot execute without what's missing.`
      );
    }
    return this._execute(input, ctx);
  }
}
