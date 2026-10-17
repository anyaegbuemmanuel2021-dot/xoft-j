import { Capability } from './constants.js';

const RX = {
  coding: /\b(code|coding|bug|bugs|fix|refactor|implement|function|class|module|repo|repository|commit|branch|pull request|unit tests?|tests?|lint|compile|build|typescript|javascript|python|react|node(?:\.js)?|express|api endpoint|stack trace|authentication|auth system|codebase|source code|debug|patch|dependency|dependencies)\b/i,
  terminal: /\b(run|execute|install|npm|pnpm|yarn|pip|git|command|script|shell|bash|powershell|cmd|terminal|cli|compile|docker|make)\b/i,
  filesystem: /\b(file|files|folder|folders|directory|directories|rename|move|organi[sz]e|project|workspace|path|read|create|edit|delete|search the|inspect)\b/i,
  browser: /\b(browse|website|web ?page|webpage|click|fill (?:in|out)|form|download|navigate|open (?:the )?(?:site|page|url)|https?:\/\/|url|scrape|login page)\b/i,
  pc: /\b(mouse|keyboard|desktop|window|launch (?:the )?app|open (?:the )?app|application|screen|screenshot|click on the)\b/i,
  web: /\b(search the web|look up|research|google|find online)\b/i,
  longRunning: /\b(end[- ]to[- ]end|whole|entire|all (?:the )?files|migrat(?:e|ion)|overhaul|autonomous(?:ly)?|overnight|multi[- ]step|step by step|until|thorough(?:ly)?|from scratch|investigate|audit|rewrite|restructure)\b/i,
  action: /\b(fix|build|create|write|implement|change|update|modify|refactor|run|install|delete|remove|rename|move|organi[sz]e|open|click|download|deploy|set up|configure|generate|add|find and|inspect|investigate|debug|migrate|test)\b/i,
  question: /^\s*(what|why|how|who|when|where|which|explain|tell me|define|summari[sz]e|describe|compare)\b/i,
};

/**
 * TaskAnalyzer — deterministic, dependency-free task classification (spec section 4: "Xoft Task Analyzer").
 *
 * Deliberately NOT an LLM call: routing must work when no AI provider is configured and must be cheap, predictable
 * and testable. It produces requirements (capabilities) and a rough shape; the router does the rest.
 *
 * @param {{goal:string, workingDirectory?:string|null, requiredCapabilities?:string[], hints?:object}} input
 */
export function analyzeTask(input = {}) {
  const goal = String(input.goal ?? '').trim();
  const signals = [];
  const has = (k) => RX[k].test(goal);

  const coding = has('coding');
  const terminal = has('terminal') && (coding || has('action'));
  const files = has('filesystem') || coding || Boolean(input.workingDirectory);
  const browser = has('browser');
  const pc = has('pc');
  const web = has('web');
  const actionVerb = has('action');
  // A goal is conversational when it is an information question (what/why/how/explain…) about something, or when nothing in it
  // asks for work to be done. Imperatives ("fix…", "run…", "open…") and browser/PC goals are actionable.
  const infoQuestion = RX.question.test(goal) && goal.length < 200 && !input.workingDirectory;
  const actionable = !infoQuestion && (actionVerb || browser || pc || (coding && terminal));
  const isQuestion = infoQuestion;
  const sentences = goal.split(/[.!?;\n]+/).filter((s) => s.trim().length > 12).length;
  const stepWords = (goal.match(/\b(then|after that|next|finally|and then|afterwards)\b/gi) ?? []).length;
  const longRunning = has('longRunning') || goal.length > 280 || sentences >= 4 || stepWords >= 2;

  const required = new Set(input.requiredCapabilities ?? []);
  if (!actionable) {
    if (!required.size) required.add(Capability.CHAT);
    signals.push('conversational');
  } else {
    if (coding) { required.add(Capability.CODING); signals.push('coding'); }
    if (terminal) { required.add(Capability.TERMINAL); signals.push('terminal'); }
    if (files) { required.add(Capability.FILESYSTEM); signals.push('filesystem'); }
    if (browser) { required.add(Capability.BROWSER); signals.push('browser'); }
    if (pc) { required.add(Capability.PC_CONTROL); signals.push('pc-control'); }
    if (web) { required.add(Capability.WEB_SEARCH); signals.push('web-search'); }
  }

  const autonomous = actionable && (longRunning || (coding && (terminal || sentences >= 2)) || required.size >= 3);
  if (autonomous) signals.push('autonomous');
  if (longRunning) signals.push('long-running');

  const simple = !autonomous && (required.has(Capability.CHAT) || (!longRunning && required.size <= 1 && goal.length < 160));
  const complexity = autonomous ? (longRunning ? 'complex' : 'moderate') : simple ? 'simple' : 'moderate';

  return {
    goal,
    requiredCapabilities: [...required],
    autonomous,
    longRunning,
    simple,
    complexity,
    signals,
    workingDirectory: input.workingDirectory ?? null,
  };
}
