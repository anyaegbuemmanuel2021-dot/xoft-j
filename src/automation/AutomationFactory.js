import { TaskType } from '../providers/ProviderRouter.js';

const CLASSIFY_PROMPT = `Decide how a personal-assistant automation request should be built.

"rule" = a single trigger firing one action (RulesEngine): e.g. "every morning at 8am check my
inbox for anything urgent", "when I say 'start my day' do X".

"workflow" = a chain of two or more distinct tool actions that should run in sequence, each
possibly using an earlier step's result (WorkflowEngine): e.g. "when a new calendar event is
created, look up the attendee then send them a welcome email".

Respond with ONLY JSON: {"kind":"rule"|"workflow","reason":"one short sentence"}`;

function parseJSON(text, fallback) {
  try { return JSON.parse(text.trim().replace(/^```json\s*|\s*```$/g, '')); }
  catch { return fallback; }
}

/**
 * AutomationFactory — the single "build me an automation from plain
 * language" entry point the spec asks for. It does not reimplement
 * triggering/execution (RulesEngine and WorkflowEngine already own that,
 * correctly, with restart-accurate re-arming and persistence); it decides
 * WHICH of those two real engines a request belongs to, then delegates.
 *
 * A "workflow" here still needs the caller to identify a triggerEventType
 * and concrete steps — this factory drafts that shape via the router (same
 * "propose, never silently invent an unverifiable tool call" discipline as
 * RulesEngine.createRule) and validates every step's toolName against the
 * real ToolRegistry before ever calling WorkflowEngine.define(), so a
 * hallucinated tool name fails loudly here rather than inside the engine.
 */
export class AutomationFactory {
  constructor({ router, toolRegistry, rulesEngine, workflowEngine, activityLog }) {
    this.router = router;
    this.toolRegistry = toolRegistry;
    this.rulesEngine = rulesEngine;
    this.workflowEngine = workflowEngine;
    this.activityLog = activityLog;
  }

  async _classify(naturalLanguageRule) {
    const result = await this.router.complete(TaskType.SIMPLE, {
      system: CLASSIFY_PROMPT,
      messages: [{ role: 'user', content: naturalLanguageRule }],
      maxTokens: 150,
    });
    return parseJSON(result.text, { kind: 'rule', reason: 'classification unparseable — defaulting to the simpler mechanism' });
  }

  async _draftWorkflow(naturalLanguageRule) {
    const toolList = this.toolRegistry.list().map((t) => `- ${t.name}: ${t.description}`).join('\n');
    const result = await this.router.complete(TaskType.REASONING, {
      system: `Convert a personal-assistant automation request into a WorkflowEngine definition.
Respond with ONLY JSON:
{"name":"short name","triggerEventType":"one of: task_completed|task_failed|automation_triggered|monitor_triggered|device.online|device.offline|goal_created","steps":[{"toolName":"...","input":{}}]}
Use "{{steps.N.result.field}}" inside an input value to reference an earlier step's result field.
Every toolName MUST be one of the tools listed below — never invent one.

AVAILABLE TOOLS:
${toolList}`,
      messages: [{ role: 'user', content: naturalLanguageRule }],
      maxTokens: 500,
    });
    const parsed = parseJSON(result.text, null);
    if (!parsed?.name || !parsed?.triggerEventType || !Array.isArray(parsed?.steps) || !parsed.steps.length) {
      throw new Error(`AutomationFactory: could not draft a workflow from that request: ${result.text.slice(0, 200)}`);
    }
    for (const step of parsed.steps) {
      if (!this.toolRegistry.has(step.toolName)) {
        throw new Error(`AutomationFactory: drafted workflow references unknown tool '${step.toolName}' — refusing to create it.`);
      }
    }
    return parsed;
  }

  /**
   * @param {string} naturalLanguageRule
   * @returns {Promise<{kind:'rule'|'workflow', reason:string, automation:object}>}
   */
  async create(naturalLanguageRule) {
    if (!naturalLanguageRule || typeof naturalLanguageRule !== 'string') {
      throw new Error('AutomationFactory.create requires a natural-language description');
    }
    const { kind, reason } = await this._classify(naturalLanguageRule);
    this.activityLog?.log({ type: 'automation_factory_classified', detail: { kind, reason, text: naturalLanguageRule } });

    if (kind === 'workflow') {
      const draft = await this._draftWorkflow(naturalLanguageRule);
      const automation = this.workflowEngine.define(draft);
      this.activityLog?.log({ type: 'automation_factory_built', detail: { kind: 'workflow', id: automation.id, name: automation.name } });
      return { kind: 'workflow', reason, automation };
    }

    const automation = await this.rulesEngine.createRule(naturalLanguageRule);
    this.activityLog?.log({ type: 'automation_factory_built', detail: { kind: 'rule', id: automation.id } });
    return { kind: 'rule', reason, automation };
  }

  /** Everything built through this factory, across both underlying engines, in one list. */
  list() {
    return [
      ...this.rulesEngine.list().map((r) => ({ kind: 'rule', ...r })),
      ...this.workflowEngine.list().map((w) => ({ kind: 'workflow', ...w })),
    ].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }
}
