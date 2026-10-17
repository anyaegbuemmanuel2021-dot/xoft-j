# Device Runtime

The bridge between XOFT's brain and the computer it runs on: **browser automation (CDP), file intelligence with
recovery, allowlisted terminal, workspaces, operation journal, application open, and a voice companion** — added to the
existing pc-agent and core without replacing anything.

```
XOFT core: mission engine → tool registry (PermissionSystem, ApprovalSystem, DomainAutonomy, EmergencyStop)
        │  48 new tools (src/tools/builtins/runtimeTools.js) → DeviceManager command queue (unchanged)
        ▼
pc-agent: dispatchCommand → HaltGuard → DeviceRuntime → RuntimeGuard/ActionPolicy (2nd, independent gate)
            ├─ BrowserController → cdp-page / cdp-dom → cdp-connection (only raw CDP WebSocket code)
            ├─ FileSystemService → WorkspaceRegistry · RecoveryStore · OperationJournal
            ├─ TerminalService (allowlist, no shell)      └─ openFile (no scripts/executables)
            └─ legacy executors (system/applications/browser.open_url/files/screen) — untouched
```

## Status: IMPLEMENTED / TESTED / REQUIRES LOCAL TESTING

| Area | Implemented | Tested here | Requires local testing |
|---|---|---|---|
| CDP connection, id correlation, timeouts, abort, events | ✅ | ✅ unit (fake transport) | real Chrome |
| Browser tools (tabs, navigate, DOM, click, type, fill, press, scroll, wait, text, attribute, screenshots) | ✅ | ✅ logic vs. scripted CDP + page scripts in a `vm` DOM stub | **All of it against real Chrome** (layout, focus, Input events, screenshots) |
| Chrome launch / attach to existing | ✅ | ✅ arg building, discovery | actually launching Chrome; attaching to your everyday Chrome |
| File search/locate/inspect/read/write/create/edit/copy/move/rename/delete/archive/extract/compare/watch | ✅ | ✅ real temp dirs, real `tar`, mutation-tested safeguards | Windows path/permission edge cases |
| Recovery: checkpoints, trash, undo, restore-version | ✅ | ✅ | Windows cross-volume moves |
| Operation journal (+ crash detection) | ✅ | ✅ | — |
| Workspaces + project detection | ✅ | ✅ | — |
| Terminal allowlist, secret-free env, tree-kill on timeout/halt | ✅ | ✅ real processes | Windows `taskkill` / `.cmd` path |
| Kill switch (local HALT file, core emergency-stop sync, remote halt) | ✅ | ✅ | core↔agent over real HTTP |
| Watchdog `device_runtime` check, bounded browser recovery | ✅ | ✅ | — |
| Core↔agent mission flow (locate→edit→failing test→rollback→passing test) | ✅ | ✅ in-process pump | HTTP polling hop |
| Dashboard "Device Runtime" view | ✅ | ✅ static contract test only | **Visual/interaction check in a browser** |
| Voice: VAD, wake matching, confirm-before-risky state machine | ✅ | ✅ unit | — |
| Voice: microphone, SpeechRecognition / server STT glue (`companion.js`) | ✅ | ⚠️ syntax only | **Everything** — needs a real mic + browser |
| Fully on-device wake-word/STT engine | ❌ not bundled (needs model files) | — | see limitations |
| `applications.focus` | ❌ not implemented | — | — |

## Security model
* **Workspaces are the sandbox.** File and terminal work can only touch registered folders (symlinks resolved). Only a
  human can register one, on the device: `node src/index.js --add-workspace <name> <path>`. No remote command can.
* **Sensitive files** (`.env`, keys, tokens, the agent's own `config.json`/`pairing.json`, browser profiles…) are never
  readable, writable, deletable, copied or archived. Embedded secrets in other files are redacted (heuristic).
* **Not exposed at all:** arbitrary JavaScript in pages, arbitrary shell, force-undo, remote resume, workspace add/remove.
* **Two gates:** core (permissions → approvals → per-domain autonomy → emergency stop) and the agent's own `ActionPolicy`
  (allowlist; unknown actions denied). `confirm` locally means "refuse unless approved via core".
* **Kill switch** is independent of the model and of core reachability: `HALT` file (`node src/index.js --halt`), core
  emergency stop (polled), or dashboard button. Halt aborts in-flight operations and kills terminal process trees.
  Only a human resumes: `node src/index.js --resume`.
* Every mutation is journaled (`<stateDir>/journal/operations.jsonl`) and denials are audited (`audit.log`).

## Run / test
```
cd pc-agent && npm test            # 89+ tests, no network, no Chrome needed
cd .. && npm install && npm test   # core suite (needs the npm packages installed)
node pc-agent/src/index.js --add-workspace Projects "C:\Projects"
node pc-agent/src/index.js         # then trust the device in the dashboard → Device Runtime → grant permissions
```
Browser: start Chrome with `--remote-debugging-port=9222 --user-data-dir=<a NON-default folder>` (Chrome 136+ ignores
the flag on the default profile), or set `browser.autoLaunch: true` in `config.json` so XOFT starts its own.
Voice: open `/companion.html` (HTTPS or localhost required for the microphone).

## Known limitations
* No on-device wake-word/STT model is bundled. "browser-speech" in Chrome/Edge sends audio to the vendor's cloud (only
  while local VAD hears speech); "server-stt" uploads only VAD segments to *your* server. A WASM engine can be added as a backend.
* Energy VAD is simple: steady loud noise can trigger it.
* Text/DOM location is heuristic; pages in cross-origin iframes and shadow DOM are not traversed.
* Refactors span many files: `file_edit` is single-file; multi-file changes are separate journaled operations (undo each, or `file_history`).
* The dashboard view was contract-tested but not rendered.
