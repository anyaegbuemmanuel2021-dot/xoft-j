import { TaskType } from '../../providers/ProviderRouter.js';

/**
 * Specialist — a narrow, role-scoped reasoning agent. Unlike AdvisorAgent
 * (one general "give me options" persona) or TaskPlanner (turns a goal into
 * executable tool-call steps), a Specialist is consulted for a bounded
 * expert judgement within its domain and returns text, not a plan or a
 * tool call — the caller (ExecutiveBrain, a workflow step, or a human via
 * the API) decides what to do with that judgement.
 */
export class Specialist {
  /**
   * @param {object} def
   * @param {string} def.name
   * @param {string} def.domain short domain label, e.g. 'research', 'code', 'data', 'writing'
   * @param {string} def.systemPrompt
   * @param {string} [def.taskType] one of TaskType — defaults to REASONING
   */
  constructor({ name, domain, systemPrompt, taskType = TaskType.REASONING }, router, injectionGuard = null) {
    this.name = name;
    this.domain = domain;
    this.systemPrompt = systemPrompt;
    this.taskType = taskType;
    this.router = router;
    this.injectionGuard = injectionGuard;
  }

  /**
   * @param {string} question
   * @param {string} [context]
   * @param {{isExternal?:boolean}} [options] set isExternal when context came from outside XOFT's own generation (spec: untrusted content must be wrapped, never trusted as instructions)
   */
  async consult(question, context = '', { isExternal = false } = {}) {
    const contextBlock = !context
      ? ''
      : isExternal && this.injectionGuard
        ? this.injectionGuard.process(context, `externally supplied context for ${this.name}`).wrapped
        : context;
    const result = await this.router.complete(this.taskType, {
      system: this.systemPrompt + (contextBlock ? `\n\nCONTEXT:\n${contextBlock}` : ''),
      messages: [{ role: 'user', content: question }],
      maxTokens: 900,
    });
    return { specialist: this.name, domain: this.domain, text: result.text };
  }
}

export const SPECIALIST_DEFS = [
  {
    name: 'research_specialist',
    domain: 'research',
    taskType: TaskType.RESEARCH,
    systemPrompt: `You are XOFT's research specialist. Given a question and any supplied search/fetch
results as context, produce a grounded, sourced synthesis. State explicitly when the supplied
context is insufficient to answer confidently rather than filling gaps from general knowledge
without flagging it as such.`,
  },
  {
    name: 'code_specialist',
    domain: 'code',
    taskType: TaskType.CODING,
    systemPrompt: `You are XOFT's code specialist. Given a coding question, a bug description, or a
snippet, give a precise, correct, minimal-diff answer. Call out any real risk (breaking change,
missing test coverage, security implication) explicitly. Never claim code was run or tested unless
the caller's context says it actually was.`,
  },
  {
    name: 'data_specialist',
    domain: 'data',
    taskType: TaskType.REASONING,
    systemPrompt: `You are XOFT's data-analysis specialist. Given a question and any supplied data or
summary statistics as context, reason carefully about what the data does and does not support.
Flag small sample sizes, confounds, or missing context instead of overstating certainty.`,
  },
  {
    name: 'writing_specialist',
    domain: 'writing',
    taskType: TaskType.REASONING,
    systemPrompt: `You are XOFT's writing specialist. Given a drafting or editing request, produce or
improve text matching the requested tone/audience/length. Where the request is ambiguous, make one
reasonable assumption, state it in one line, then proceed.`,
  },
];
