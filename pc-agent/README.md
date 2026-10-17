# XOFT Windows Agent

The Windows-side half of the Device Operating Layer. Runs as a background
process on your PC, registers itself with `xoft-core`, and executes an
allowlisted set of commands (open apps, open URLs, read system info, list
files in folders you specifically allow, basic media control) — nothing
more. See `../docs/MOBILE_COMPANION_CONTRACT.md` and
`../docs/DEVICE_OPERATING_LAYER.md` for the full protocol and
security model this implements against.

Verified end-to-end against a live xoft-core instance: register → pair →
human explicitly trusts the device → capabilities reported → core queues a
command → agent polls, executes, reports a verified result back. Nothing in
this agent fabricates a success — every result comes from a real OS-level
check (process exit code, on-disk file size, live `os.*` reads).

## Requirements

- Node.js 18+ on the Windows machine, OR use the packaged `.exe` (below) —
  no Node install needed if you use that.
- `xoft-core` running somewhere reachable from the Windows PC (same machine,
  same LAN, or a real server — whatever `coreUrl` in your config points to).

## Setup

```powershell
npm install
node src\index.js
```

First run creates `config.json` next to itself from `config.example.json`
and exits — **edit it before running again**:

- `coreUrl` — where xoft-core is running.
- `allowedRoots` — the ONLY directories file commands can ever touch.
  Defaults to `Documents\XoftShared`; change or add more, but keep it
  narrow. Nothing outside these paths is reachable no matter what a command
  requests (see `src/executors/files.js`).
- `appAllowlist` — the ONLY applications `device_launch_app` /
  `device_close_app` can touch. Add entries for apps you actually want to
  control; anything not listed here is refused, not attempted.

Run it again:

```powershell
node src\index.js
```

It will:
1. Register itself with xoft-core and print a `curl` command.
2. **Wait** — it will not receive any commands until a human runs that
   `curl ... /trust` command (or hits the equivalent button once a UI
   exists). Discovery is never the same as trust.
3. Report its capabilities, then start heartbeating, reporting system state,
   and polling for commands every few seconds.

## Running at startup

To have XOFT start automatically when you log in:

```powershell
npm run install-startup
```

This registers a Windows Task Scheduler task (`XOFT Agent`) that runs the
same start command you'd run manually, at your next login, with your normal
user privileges (no admin rights requested, and it does not run before
anyone logs in — see below if you need that instead). This is **entirely
opt-in** — it never happens as a side effect of `npm start` or anything
else, so you always decide when XOFT gets standing access to your machine.

To undo it:

```powershell
npm run uninstall-startup
```

If you need it to run even when nobody is logged in (e.g. a headless
always-on PC), that requires storing Windows credentials in Task Scheduler,
which this command deliberately does not do for you automatically — set
that up yourself via `schtasks /create ... /ru <user> /rp <password>` or the
Task Scheduler GUI ("Run whether user is logged on or not"), or use the
manual Task Scheduler approach below.

### Manual alternative

You can also register it yourself (or on platforms other than Windows, via
that OS's own login-item/service mechanism — a systemd user unit on Linux,
a LaunchAgent on macOS) — run `node C:\path\to\src\index.js` (or the
packaged `.exe`) at login.

## Building a standalone .exe

```powershell
npm install
npm run build:exe
```

This uses [`pkg`](https://github.com/vercel/pkg) to bundle Node + this
agent into a single `dist\xoft-agent.exe` — no separate Node.js install
needed on the target machine. `config.json`/`pairing.json` still live next
to wherever you run the `.exe` from, not inside it.

## What's real vs. what needs your own setup

| Capability | Status |
|---|---|
| Pairing / trust / heartbeat / capability & state reporting | Real, tested against a live core |
| Startup registration (`npm run install-startup`) | Real Task Scheduler registration; opt-in only, not tested on an actual Windows machine in this environment (built/reviewed on Linux — logic is unit-tested cross-platform, the actual `schtasks` call itself is not) |
| `system.read_system_info` | Real (cross-platform via Node's `os` module) |
| `applications.list/open/close` | Real on Windows (`tasklist`/`start`/`taskkill`); allowlist-only |
| `browser.open_url` | Real on Windows (`cmd /c start`); scheme-validated |
| `files.list_files` / transfer | Real, hard-confined to `allowedRoots`, 25MB transfer cap |
| `media.*` | Requires `nircmd.exe` on PATH — reports a real, honest error if it's missing rather than pretending volume changed |
| Notifications, clipboard, keyboard/mouse input, screen capture | Not implemented in this pass — genuine gap, not stubbed to look done |
