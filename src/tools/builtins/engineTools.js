import { RiskLevel, Tool } from '../Tool.js';

/**
 * Tools that let Xoft's own AI (planner / executive brain) delegate work to an execution engine and follow it.
 * They are thin wrappers over EngineTaskManager — the same code path the API and UI use — so permissions, autonomy,
 * limits and approvals are identical however a task was started.
 *
 * `engine_run_task` is EXTERNAL risk: with the default autonomy it needs a human approval before an autonomous agent is
 * launched. An AI-originated task may only pick a NAMED permission profile (never a custom permission object), and the
 * engine's configured profile remains the ceiling.
 */
export function buildEngineTools({ getManager, getRegistry }) {
  const summarize = (t) => ({
    taskId: t.id, engine: t.engine, state: t.state, stateReason: t.stateReason ?? null, goal: t.goal?.slice(0, 200),
    activity: t.progress?.currentActivity ?? null, toolCalls: t.progress?.toolCalls ?? 0, filesChanged: t.progress?.filesChanged?.length ?? 0,
    pendingApprovals: (t.pendingApprovals ?? []).length, routing: t.routing?.reason ?? null,
    result: t.result ? { summary: t.result.summary, verification: t.result.verification?.status ?? null, verificationNote: t.result.verification?.statement ?? null } : null, error: t.error ?? null,
  });
  return [
    new Tool({
      name: 'engine_run_task',
      description: 'Delegate a long-running or multi-step task (coding, running commands, working through project files, multi-step computer work) to an autonomous execution engine such as Hermes. Returns immediately with a taskId; poll engine_task_status. Do not use for simple questions.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'What the engine should accomplish, in plain language.' },
          engine: { type: 'string', description: "Engine id, or 'auto' (default) to let Xoft choose and fall back." },
          workingDirectory: { type: 'string', description: 'Project folder the task works in (required for coding / file / terminal tasks unless a default is configured).' },
          permissionProfile: { type: 'string', enum: ['observe', 'standard', 'developer', 'full'], description: "Named permission profile (default: the engine's configured profile)." },
          autonomy: { type: 'integer', minimum: 0, maximum: 5 },
        },
        required: ['goal'],
      },
      requiredPermissions: [],
      riskLevel: RiskLevel.EXTERNAL,
      status: 'IMPLEMENTED',
      execute: async (input, ctx) => {
        const manager = getManager();
        if (!manager) throw new Error('Engine task manager is not available');
        const t = await manager.createTask({ goal: input.goal, engine: input.engine, workingDirectory: input.workingDirectory, permissions: input.permissionProfile, autonomy: input.autonomy, metadata: { origin: 'xoft-ai', missionId: ctx?.missionId ?? null } }, { createdBy: 'xoft-ai' });
        return summarize(t);
      },
    }),
    new Tool({
      name: 'engine_task_status',
      description: 'Get the live status, current activity, result and verification of an engine task started with engine_run_task.',
      inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
      requiredPermissions: [], riskLevel: RiskLevel.SAFE, status: 'IMPLEMENTED',
      execute: async (input) => {
        const t = getManager()?.get(input.taskId);
        if (!t) throw new Error(`No engine task '${input.taskId}'`);
        return summarize(t);
      },
    }),
    new Tool({
      name: 'engine_cancel_task',
      description: 'Stop a running or queued engine task.',
      inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, reason: { type: 'string' } }, required: ['taskId'] },
      requiredPermissions: [], riskLevel: RiskLevel.LOW, status: 'IMPLEMENTED',
      execute: async (input) => summarize(await getManager().cancel(input.taskId, { reason: input.reason ?? 'cancelled by Xoft' })),
    }),
    new Tool({
      name: 'engine_list',
      description: 'List the available execution engines, their status and capabilities.',
      inputSchema: { type: 'object', properties: {} },
      requiredPermissions: [], riskLevel: RiskLevel.SAFE, status: 'IMPLEMENTED',
      execute: async () => ({ engines: getRegistry().list().map((e) => ({ id: e.id, name: e.name, status: e.status, available: e.health?.available ?? null, reason: e.health?.reason ?? e.statusReason ?? null, capabilities: e.capabilities })) }),
    }),
  ];
}
