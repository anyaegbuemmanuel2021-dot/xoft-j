/**
 * GoalDrift — ADVISORY, lexical heuristic (not semantic understanding).
 * Measures how many meaningful words of a mission goal appear in a proposed
 * action's text. Low overlap => "possible drift, review". It can produce false
 * positives/negatives, so it only flags; it never stops anything by itself.
 */
const STOP = new Set('the a an and or to of in on for with my me i is are be it this that at by from as do get make keep please'.split(' '));
const stem = (w) => w.replace(/(ing|ed|es|s)$/, '');
const words = (t) => new Set(String(t ?? '').toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((w) => !STOP.has(w)).map(stem) ?? []);

export function assessDrift(goal, actionText, { threshold = 0.15 } = {}) {
  const g = words(goal);
  const a = words(actionText);
  if (!g.size || !a.size) return { drift: false, score: null, note: 'not enough text to judge', heuristic: true };
  let hit = 0;
  for (const w of g) if (a.has(w)) hit += 1;
  const score = Number((hit / g.size).toFixed(2));
  return { drift: score < threshold, score, note: score < threshold ? 'action shares little vocabulary with the goal — review' : 'action overlaps the goal', heuristic: true };
}

/** Assess every step of a task against the mission goal. */
export function assessTaskDrift(goal, task) {
  const steps = (task?.steps ?? []).map((s) => ({ id: s.id, ...assessDrift(goal, `${s.description ?? ''} ${s.toolName ?? ''}`) }));
  return { steps, flagged: steps.filter((s) => s.drift).map((s) => s.id), heuristic: true };
}
