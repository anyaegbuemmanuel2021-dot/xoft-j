# XOFT God-Level Upgrade Status

This document records what was actually added to the existing XOFT-Core codebase in this upgrade. It is deliberately an implementation record, not a claim that XOFT has fictional unlimited powers.

## Implemented in this upgrade

- Persistent autonomy levels 0-5 (`src/autonomy/AutonomyManager.js`).
- Autonomy-aware approval decisions; HIGH_IMPACT actions remain approval-only.
- Proactive suggestion engine with device-battery and approval awareness.
- Context snapshot service.
- Long-running mission records with plan/run/cancel lifecycle.
- Recovery engine with bounded retries, verification hooks, and recovery events.
- New APIs for autonomy, context, suggestions, and missions.
- Windows screen capture, mouse click, typing, and scrolling executors using fixed, allowlisted native operations.
- New XOFT device tools for screen capture and interaction, protected by existing permission/risk/emergency-stop gates.
- Android companion project integrated into the same repository; it uses the existing XOFT device command channel and provides an AccessibilityService for explicitly authorized click/type operations.
- Additional test coverage for autonomy policy.

## Added in this pass (2026-08-14)

- Fixed a real bug in `ProactiveEngine`: suggestion dedup keys were added to
  a `Set` that was never cleared, so a condition (e.g. low battery) could
  only ever raise a suggestion once, permanently, even after it resolved
  and recurred later. Dedup now tracks currently-active condition keys per
  evaluation pass and clears on dismiss. Covered by
  `test/proactiveEngine.test.js` (3 tests, run and passing).
- Added `src/vision/VisionInterpreter.js`: takes a `device_screen_capture`
  result and asks a vision-capable provider (Claude or OpenAI — Gemini is
  explicitly excluded because `GeminiProvider.complete()` has no image
  branch and would silently mishandle image input) to return structured
  JSON describing the application, window, visible UI elements, and a
  plain-language summary. Deliberately does not invent pixel coordinates —
  only qualitative regions ("top-left", "center"). Parse failures are
  surfaced as `parseError`, never silently converted into a fake result.
  Covered by `test/visionInterpreter.test.js` (5 tests, run and passing,
  using a mocked provider — no live API call was made).
- Added `ProviderRouter.selectVision()` and a new `device_screen_understand`
  tool that chains capture → interpret in one authorized, permission-gated
  action, so the ExecutiveBrain can ask "what's on screen" instead of only
  getting raw image bytes back.
- This wiring is real but **narrower than full spec section 8**: it is a
  request/response interpretation of a single screenshot, not a
  continuous, event-driven, change-detecting perception loop, and it is
  not yet used automatically by the ExecutiveBrain to decide next actions
  on its own — it is available as a tool the brain can choose to call.

## Still genuinely dependent on the environment

- A Windows agent must actually be installed and paired for PC actions.
- Android Accessibility Service must be manually enabled by the user.
- `device_screen_understand` needs a live `ANTHROPIC_API_KEY` or
  `OPENAI_API_KEY` to actually call a vision model — it was only exercised
  here against a mocked provider, never a real API, since this development
  environment has no network access.
- Browser DOM automation is still limited compared with a full Playwright-style browser agent.
- Camera, microphone, notification, calls, SMS and other Android capabilities require their respective OS permissions and implementations.
- No system can bypass OS security boundaries; unsupported capabilities remain unavailable.

## Verification

JavaScript source files pass `node --check` in the upgraded tree, including
all files touched in this pass. The pre-existing test suite could not be
run end-to-end in this environment because it has no network access to
`npm install` dependencies (`express`, `dotenv`, `helmet`,
`express-rate-limit`); a prior run in a networked environment reported 22
passing tests before hitting that same dependency gap. The two new
zero-dependency test files added in this pass (`node:test` only, no
external packages) were actually executed here and all 8 assertions pass.
Nothing in this document should be read as "the full suite passes" — that
still needs to be run in an environment with `npm install` available.
