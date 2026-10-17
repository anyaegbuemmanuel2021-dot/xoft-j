import { TaskType } from '../providers/ProviderRouter.js';

const CRITIQUE_PROMPT = `You are XOFT's plan critic. Inspect a proposed task plan against the user's goal and the supplied context.
Look for missing steps, wrong ordering, unnecessary actions, unsupported assumptions, device mismatches, and risky ambiguity.
Do not rewrite the plan. Return ONLY JSON:
{"score":0,"issues":[{"severity":"low|medium|high","issue":"...","fix":"..."}],"summary":"one concise sentence"}
Score 0-100 where 100 means the plan is coherent, complete, and grounded.`;

function parseJSON(text, fallback) {
  try { return JSON.parse(text.trim().replace(/^```json\s*|\s*```$/g, '')); }
  catch { return fallback; }
}

export class IntelligenceDirector {
  constructor({ router, reasoningEngine, confidenceEngine, memory, contextEngine, activityLog }) {
    this.router = router;
    this.reasoningEngine = reasoningEngine;
    this.confidenceEngine = confidenceEngine;
    this.memory = memory;
    this.contextEngine = contextEngine;
    this.activityLog = activityLog;
  }

  async _recall(goal) {
    const structured = this.memory?.recallStructured?.({ textIncludes: goal.slice(0, 80) }) ?? [];
    let semantic = [];
    if (this.memory?.vectorEnabled) {
      try { semantic = await this.memory.recallSemantic(goal, 5); } catch { /* optional */ }
    }
    const procedures = this.memory?.recallProcedures?.(goal.slice(0, 80).toLowerCase(), 3) ?? [];
    return { structured: structured.slice(-8), semantic: semantic.slice(0, 5), procedures };
  }

  async preflight(goal, task) {
    const recall = await this._recall(goal);
    const decomposition = await this.reasoningEngine.decompose(goal);
    const planText = task.steps.map((s, i) => `${i + 1}. ${s.description} [${s.toolName}] deps=${JSON.stringify(s.dependsOn)}`).join('\n');
    const context = this.contextEngine?.describe?.() ?? '';

    const [critique, uncertainty] = await Promise.all([
      this.router.complete(TaskType.REASONING, {
        system: CRITIQUE_PROMPT,
        messages: [{ role: 'user', content: `GOAL:\n${goal}\n\nPLAN:\n${planText}\n\nKNOWN CONTEXT:\n${context}\n\nRELEVANT MEMORY:\n${JSON.stringify(recall)}` }],
        maxTokens: 700,
      }).then(r => parseJSON(r.text, { score: 0, issues: [{ severity: 'high', issue: 'Plan critique could not be parsed.', fix: 'Ask the user to clarify before acting.' }], summary: 'Plan validation unavailable.' })),
      this.reasoningEngine.detectUncertainty(`GOAL:\n${goal}\n\nPLAN:\n${planText}\n\nKNOWN CONTEXT:\n${context}`),
    ]);

    const confidence = await this.confidenceEngine.assess(
      'the proposed plan is safe, complete, and correctly matches the user intent',
      `Goal: ${goal}\nPlan: ${planText}\nCritique: ${JSON.stringify(critique)}\nUncertainties: ${JSON.stringify(uncertainty)}\nRelevant memory: ${JSON.stringify(recall)}`
    );

    const result = {
      decomposition,
      critique,
      uncertainty,
      confidence,
      recall,
      recommendation: critique.score >= 70 && confidence.score >= 70 && uncertainty.uncertainties.length === 0 ? 'proceed' : 'review',
    };
    this.activityLog?.log({ type: 'intelligence_preflight', detail: { goal, critiqueScore: critique.score, confidence: confidence.score, uncertaintyCount: uncertainty.uncertainties.length, recommendation: result.recommendation } });
    return result;
  }

  async learn(goal, task) {
    const failed = task.steps.filter(s => s.status === 'failed');
    const completed = task.steps.filter(s => s.status === 'completed');
    const outcome = task.status === 'completed' ? 'completed' : failed.length ? 'failed' : task.status;
    if (failed.length || task.steps.length >= 3) {
      const summary = `Goal: ${goal}. Outcome: ${outcome}. Completed ${completed.length}/${task.steps.length} steps.` +
        (failed.length ? ` Failed: ${failed.map(s => `${s.description}: ${s.error}`).join(' | ')}` : '');
      try {
        await this.memory.remember('execution_outcome', summary, { taskId: task.id, outcome }, { source: 'SYSTEM_OBSERVED', confidence: 1, relatedTaskId: task.id });
      } catch { /* learning never breaks execution */ }
    }
    // Episodic + procedural learning — real observations only, never invented.
    try { this.memory.recordEpisode?.({ kind: 'task', summary: `Goal: ${goal}. Outcome: ${outcome}.`, outcome, participants: { taskId: task.id }, tags: ['task'] }); } catch { /* non-critical */ }
    try { if (task.status === 'completed' || task.steps.length >= 2) this.memory.learnProcedure?.(goal.slice(0, 80).toLowerCase(), task); } catch { /* non-critical */ }
    this.activityLog?.log({ type: 'intelligence_learned', detail: { taskId: task.id, outcome, completed: completed.length, failed: failed.length } });
    return { outcome, completed: completed.length, failed: failed.length };
  }
}
