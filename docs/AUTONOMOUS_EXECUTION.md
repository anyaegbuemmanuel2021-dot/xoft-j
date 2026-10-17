# XOFT Autonomous Execution

## Failure recovery
1. Execute a planned step.
2. Verify the result.
3. If it fails, record the error and learned outcome.
4. For a named device application, restart that application through the allowlisted `restart_application` capability.
5. Retry the original operation, bounded by the planner retry limit.
6. If recovery fails, mark the step/task failed and retain the failure for future planning.

## Scheduling
`POST /api/task-schedules` accepts a `goal` and either `executeAt` (ISO timestamp) or `delayMs`. XOFT creates the plan immediately, persists the schedule, and executes the task when due. Scheduled jobs survive a Core restart.

## Social publishing
`device_social_post` is an external-risk tool. It can target a paired Android/iOS/Windows/Linux agent that implements the social capability. XOFT requires the appropriate permission and approval and waits for a real result. Platform credentials and policies remain external dependencies.
