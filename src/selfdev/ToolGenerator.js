import path from 'node:path';
import { TaskType } from '../providers/ProviderRouter.js';
import { Tool } from '../tools/Tool.js';

const GEN_DIR = 'src/tools/builtins/generated';

const TOOL_GEN_PROMPT = `Write a single new tool for the XOFT assistant as an ES module.

Hard requirements:
- The file's only export is a named function "buildTool" with signature: export function buildTool(deps) { return { name, description, inputSchema, riskLevel, requiredPermissions, execute }; }
- "deps" may be used for anything the tool genuinely needs (fetch, fs, etc.) but must not assume any specific object is passed — treat it as optional and guard against it being undefined.
- riskLevel must be one of: 0 (SAFE — read-only/reversible), 1 (LOW — reversible/low-impact), 2 (EXTERNAL — touches the outside world), 3 (HIGH_IMPACT — irreversible/financial/destructive). Pick the HONEST level — never SAFE for something that writes, sends, or spends.
- execute(input, ctx) must be an async function that returns a plain object. It must genuinely attempt the real operation described — if it cannot (e.g. missing credentials), it must return {success:false, error:'...'} explaining exactly what's missing, never a fabricated success.
- No shell execution, no eval, no dynamic imports, no network calls to anything other than what the tool's stated purpose requires.
- No import of anything under src/security/, src/approval/, src/selfdev/, src/autonomy/, src/privacy/, src/watchdog/, or any Node built-in that spawns processes.

Respond with ONLY the raw JavaScript file content — no markdown fences, no commentary.`;

function safeFileName(name) {
  const clean = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!clean) throw new Error('ToolGenerator: could not derive a safe file name from the tool name');
  return `${clean}.js`;
}

/**
 * ToolGenerator — "tool generation" from the spec, wired through the
 * EXISTING SelfDevelopmentEngine rather than a parallel unsafe path: a
 * generated tool is a proposal like any other self-dev change. It still
 * goes through sandboxTest() (syntax check + full test run in a throwaway
 * copy of the repo) and apply() (named human approver required, protected
 * paths enforced, backup + post-apply syntax re-check + auto-rollback on
 * failure) before a single byte reaches the live tree. Nothing here can
 * register a tool without going through that same human-in-the-loop gate.
 */
export class ToolGenerator {
  constructor({ router, selfDev, toolRegistry, activityLog }) {
    this.router = router;
    this.selfDev = selfDev;
    this.toolRegistry = toolRegistry;
    this.activityLog = activityLog;
  }

  /**
   * Drafts a tool implementation from a plain-language description and
   * files it as a SelfDevelopmentEngine proposal. Returns the proposal —
   * it is NOT live yet; call sandboxTest() then apply() (see
   * SelfDevelopmentEngine) exactly like any other self-dev change, then
   * registerApplied() to actually load it into this running process.
   */
  async propose(description, { toolName } = {}) {
    if (!description) throw new Error('ToolGenerator.propose requires a description of the tool to build');
    const result = await this.router.complete(TaskType.CODING, {
      system: TOOL_GEN_PROMPT,
      messages: [{ role: 'user', content: description }],
      maxTokens: 1800,
    });
    const code = result.text.trim().replace(/^```(?:javascript|js)?\s*|\s*```$/g, '');
    if (!/export\s+function\s+buildTool\s*\(/.test(code)) {
      throw new Error('ToolGenerator: drafted code did not export the required buildTool(deps) function — refusing to propose it.');
    }
    const fileName = safeFileName(toolName ?? description.slice(0, 40));
    const rel = path.posix.join(GEN_DIR, fileName);
    const proposal = this.selfDev.propose({
      title: `Generated tool: ${toolName ?? description.slice(0, 60)}`,
      rationale: `Requested: ${description}`,
      files: { [rel]: code },
    });
    this.activityLog?.log({ type: 'tool_generated_proposed', detail: { proposalId: proposal.id, file: rel } });
    return proposal;
  }

  /**
   * After a proposal has been applied (SelfDevelopmentEngine.apply — which
   * already required a named human approver and a passing sandbox run),
   * load the new file from the now-live tree and register its tool with
   * the running ToolRegistry so it's usable without a process restart.
   * Deliberately separate from apply(): registering a tool is a distinct,
   * narrower action than writing files to disk, and keeping it a separate
   * explicit call means a generated file can be applied to disk (e.g. for
   * review, or picked up on next restart) without necessarily being wired
   * into THIS process's live tool set.
   */
  async registerApplied(proposalId, deps = {}) {
    const proposal = this.selfDev.get(proposalId);
    if (proposal.status !== 'applied') throw new Error(`ToolGenerator: proposal '${proposalId}' has not been applied yet`);
    const rel = Object.keys(proposal.files).find((f) => f.startsWith(GEN_DIR));
    if (!rel) throw new Error('ToolGenerator: applied proposal did not contain a generated tool file');
    const abs = path.resolve(this.selfDev.repoRoot, rel);
    const mod = await import(`${abs}?t=${Date.now()}`); // cache-bust in case of a prior failed load
    if (typeof mod.buildTool !== 'function') throw new Error(`ToolGenerator: ${rel} does not export buildTool`);
    const def = mod.buildTool(deps);
    const tool = new Tool(def);
    this.toolRegistry.register(tool);
    this.activityLog?.log({ type: 'tool_generated_registered', detail: { proposalId, toolName: tool.name, file: rel } });
    return tool;
  }
}
