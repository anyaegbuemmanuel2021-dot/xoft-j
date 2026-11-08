# XOFT Adaptive Agent v2

XOFT's execution loop is now designed around **Observe -> Plan -> Act -> Verify -> Recover -> Learn**.

## Adaptive recovery

After a failed tool call, XOFT asks a reasoning provider to classify the failure and choose one bounded strategy: retry, restart an explicitly named application, adjust an existing input field, use an existing alternative tool, or abort.

Safety invariants:
- invented tools are rejected;
- new input keys are rejected;
- alternative tools may not increase the original tool risk;
- permissions and emergency stop remain enforced by ToolRegistry;
- device recovery uses capability-scoped actions only;
- recovery is bounded by the task retry limit.

## Computer use

`device_computer_use` is a capability-scoped natural-language action. It is intentionally not a generic shell or unrestricted automation endpoint. The native device agent must opt in by advertising `computer_use` and implementing the command.

`device_screen_verify` captures the current screen and sends it to the configured vision provider to independently inspect the expected outcome.

## Production gap

The core is ready for native computer-use agents, but each OS still needs its native implementation and permission UX. The backend cannot truthfully claim OS control until that agent reports the capability and returns a real result.

## 0.8.0 hardening: real computer-use loop

XOFT now has a core-side `ComputerUseEngine` that uses only existing screen primitives:

1. Capture a real screenshot from the trusted device.
2. Ask a configured vision provider for one bounded action.
3. Validate the action locally (normalized coordinates, text length, scroll bounds).
4. Execute exactly one `screen.click`, `screen.type`, or `screen.scroll` command.
5. Capture the screen again.
6. Re-plan from the new screen state.
7. If an expected outcome was supplied, perform a separate visual verification.
8. Stop when the model says `done`, the budget is exhausted, or the task is unsafe/unverifiable.

This is deliberately bounded: there is no arbitrary shell/process tool and no infinite agent loop. The Windows agent already supplies real screenshot/click/type/scroll primitives. Android must still implement real MediaProjection capture before visual computer use can operate there.
