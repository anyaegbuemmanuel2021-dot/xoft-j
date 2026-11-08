# XOFT 0.10.2 — Fixes Applied After the Forensic Audit

This follows `XOFT_0.10.2_FORENSIC_AUDIT.md`, which was delivered audit-only
(no modifications) per its own explicit instruction. Everything below was
implemented afterward, as a separate, explicit follow-up.

## What was fixed

1. **`WorkflowEngine._listeners` never initialized** — every call to
   `define()` threw `TypeError: Cannot read properties of undefined
   (reading 'set')`. Fixed: initialized in the constructor.
   (`src/workflows/WorkflowEngine.js`)

2. **Ambiguous-execution approval ordering** — the generic risk-based
   approval gate ran before the ambiguity-specific check, so a dangling
   EXTERNAL/HIGH_IMPACT step got a generic, reason-less approval instead of
   the intended ambiguity-tagged one — and would have silently bypassed the
   safety gate entirely under an autonomy config that auto-approves that
   risk level. Fixed: the ambiguity check now runs first, always requesting
   a fresh, explicit, reason-tagged approval via `requestApproval()` (which
   bypasses autonomy auto-approval by design) before any risk-based
   auto-execution path is considered. SAFE/LOW-risk ambiguous retries still
   auto-proceed as before, but now log the ambiguity honestly rather than
   silently retrying. (`src/planner/TaskPlanner.js`)

3. **Experiential Labs `:free` model-slug corruption — the significant one.**
   The forensic audit checked Experiential Labs' real, current API docs
   (`platform.experientiallabs.ai/docs`) and confirmed there is no `:free`
   slug suffix convention on that platform (models are addressed by plain
   slugs like `claude-opus-5`; free-vs-paid is governed by BYOK vs.
   platform-funded lanes and per-model pricing). The code was appending
   `:free` to every model slug whenever `EXPERIENTIAL_FREE_ONLY=true` — the
   documented *recommended, safe* setting — which would have turned every
   request into an invalid model ID and broken every call. Rewritten:
   - The model slug is never mutated.
   - Free-only mode now checks the real, authenticated `/v1/models`
     catalog and only calls a model when its pricing fields positively
     confirm zero cost.
   - An unrecognized or missing pricing shape is treated as **not** free —
     fails closed, never assumes free to avoid an unexpected charge.
   - `docs/EXPERIENTIAL_LABS.md` rewritten to describe this accurately
     instead of asserting the old, incorrect mechanism as fact.
   (`src/providers/ExperientialProvider.js`)

4. **`POST /api/ai/model` accepted any string** — now validates the
   submitted model id against the live catalog before accepting it,
   returning a clear 400 for an unknown model rather than deferring the
   failure to actual request time. (`src/index.js`)

5. **Dead code removed**: `src/tools/builtins/placeholderTools.js` —
   confirmed unreferenced anywhere, removed.

6. **Test coverage added/restored:**
   - `test/experientialProvider.test.js` (rewritten — the prior version's
     one test claimed to verify the `:free` behavior but never actually
     called `complete()` or `_resolveModel()`, so it never could have
     caught the bug in #3). Now 12 real tests: config/model state,
     free-only fail-closed behavior (including the specific regression —
     asserts the slug is never mutated), request/response shape, tool-call
     mapping, error surfacing, catalog auth.
   - `test/experientialProviderUnconfigured.test.js` (new): honest refusal
     with no API key, public-catalog fallback.
   - `test/whatsappService.test.js`, `test/twilioService.test.js`,
     `test/channelGateway.test.js` — restored from a sibling build of this
     same codebase where they were already written and passing (the
     underlying source files are byte-identical between the two builds;
     only the tests were missing from this specific upload).

## About the live test call you asked for

I attempted the real `curl` call to `https://api.experientiallabs.ai/v1/chat/completions`
with the key you provided, from this sandbox, to give you a real answer
instead of a guess:

```
Host not in allowlist: api.experientiallabs.ai. HTTP_STATUS:403
```

This sandbox's network egress is restricted to an allowlist (package
registries, GitHub, etc.) that doesn't include that domain — the request
was blocked at my environment's own proxy before it ever reached
Experiential Labs. **Your key was never transmitted anywhere outside this
sandbox, and nothing was billed.** I did not write your real key into any
file in this project or into anything packaged for you — only the
placeholder `.env.example` entries exist in the delivered zip. To actually
run the live test, use the exact `curl` command already given to you, from
a machine with normal internet access, with `EXPERIENTIAL_API_KEY` (or
`EXPLABS_API_KEY`, same value) set to your real key in your own local
`.env`, which is git-ignored and was never part of anything I packaged.

## Test results

```
Core (xoft-core):    209 tests / 55 suites — 209 pass, 0 fail
PC Agent:               6 tests /  1 suite  —   6 pass, 0 fail
```

Verified via a genuine clean install + full run, not asserted from memory.

## Still open (not fixed this pass, flagged for you to decide)

- Experiential is placed first in every task-type provider-preference
  order whenever it's configured, ahead of direct OpenAI/Gemini/Claude/
  Grok — this is a reasonable default but isn't currently configurable.
  Not changed, since the master prompt didn't specify an ordering and
  changing it wasn't part of the audit's findings.
- The exact JSON field names Experiential's `/v1/models` uses for per-model
  pricing were not independently confirmed against a real, authenticated
  response (no live credentials reachable from this sandbox). The
  free-only check is deliberately conservative about this — see
  `docs/EXPERIENTIAL_LABS.md`'s note on this for what to check if a
  genuinely free model gets rejected.
- Everything already listed as an open item in the forensic audit that
  wasn't a source-code defect (Android on a real device, Docker build,
  live WhatsApp/Twilio delivery, etc.) is unchanged — those need real
  external accounts/hardware, not more code.
