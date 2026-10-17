# XOFT Intelligence Layer

XOFT now has a deliberative `IntelligenceDirector` between planning and execution.

## Pipeline

`recall -> decompose -> plan -> critique -> uncertainty -> confidence -> risk/approval -> execute -> verify -> learn`

The director does not expose private chain-of-thought. It produces compact decision artifacts: relevant memory, a problem decomposition, plan critique, material uncertainties, confidence, and a proceed/review recommendation.

Execution outcomes that contain failures or span multiple steps are stored as `execution_outcome` memories so later planning can learn from prior attempts without filling memory with trivial actions.

## Safety

- High-severity plan critique blocks execution.
- Material uncertainty blocks execution until clarified.
- Confidence is fail-closed when its JSON cannot be parsed.
- Existing approval, permission, emergency-stop, and device-trust gates remain authoritative.

## Self-healing execution, scheduling and social actions

XOFT now supports a bounded self-healing loop for device-targeted app tasks: on a failed app operation, the planner records the failure in memory, asks the RecoveryEngine to restart the explicitly named application through the device capability layer, and retries the original step. Retry counts remain bounded; XOFT never falls back to arbitrary shell/process execution.

The BackgroundJobManager can schedule either a tool call or a complete autonomous task. Task schedules persist to `background_jobs.json`, survive process restarts, retry with exponential backoff, and can be paused/resumed/cancelled.

The device tool layer also exposes `device_social_post` and `device_social_open`. These route publishing through a paired phone/desktop agent and are marked EXTERNAL, so approval remains required. Actual social posting still depends on the target platform's supported API/login/session and the native agent's implementation; XOFT never claims a post succeeded until the target agent reports success.
