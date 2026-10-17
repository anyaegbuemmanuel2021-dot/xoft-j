# Mobile Companion App Contract

This backend (`xoft-core`) cannot control a phone, read WhatsApp, place
calls, or capture the screen by itself — those require OS-level access only
a native app with the right permissions can have. This document is the
interface such an app would implement, so the XOFT core can drive it.

This is not optional glue code Claude skipped — it's a genuinely separate
codebase (Android/iOS, likely Kotlin/Swift or React Native with native
modules for Accessibility Service / SiriKit) that's out of scope for a
backend-only build. What's below is exactly what it needs to expose.

## 1. Registration

On install/login, the app calls:

```
POST /api/devices  { "name": "Ikenna's Pixel 8", "platform": "android" }
-> { id, name, platform, trust: "unverified", status: "connected" }
```

and stores the returned `id`. It should call `POST /api/devices/:id/heartbeat`
periodically (e.g. every 60s while foregrounded) so the core knows it's live.

## 2. Permission grants

The app's own OS-level permission prompts (contacts, calls, SMS, camera,
mic, accessibility service, notification listener) happen first, natively.
Once the user has granted a capability at the OS level, the app tells the
core so the ToolRegistry will actually allow related tools to run:

```
POST /api/devices/:id/permissions  { "permission": "whatsapp.send" }
```

using the permission strings in `src/security/PermissionSystem.js`.

## 3. Command channel — now implemented (poll-based)

This part of the contract is now real, backed by `DeviceManager`
(`src/devices/DeviceManager.js`). The app should:

1. **Trust step first.** Registration alone leaves a device `unverified`.
   A human must call `POST /api/devices/:id/trust` (e.g. from a dashboard
   confirming a pairing code) before any command will be queued to it.
   Discovery/registration is never enough on its own (spec section 5).
2. **Report capabilities** once OS permissions are granted:
   `POST /api/devices/:id/capabilities  { "capabilities": ["applications","files","browser","media","system"] }`.
   A command is only ever queued for a capability the device has reported.
3. **Report state periodically** (battery, network, active app, lock state):
   `POST /api/devices/:id/state  { "state": { "battery": 62, "charging": false } }`.
4. **Poll for work** (simple long-poll-style; hold-open SSE can replace this
   later without changing the contract):
   `GET /api/devices/:id/commands/pending` -> `[{id, capability, action, parameters}, ...]`.
   Call this on an interval (e.g. every 2-5s while foregrounded/backgrounded
   with a wake mechanism) or wake via FCM/APNs for near-real-time capability.
5. **Report the result** — this is what actually resolves the tool call on
   the core side; nothing is assumed to have succeeded before this arrives:
   `POST /api/devices/:id/commands/:commandId/result
   { "success": true, "data": {...}, "verification": { "verified": true, "evidence": {...} } }`.
   If the action genuinely failed or couldn't be verified, report
   `"success": false` with a real `"error"` — never a fabricated success.

If the app never registers a capability or never polls, commands to that
device simply time out (spec section 18/28) — the core does not pretend
otherwise.

## 4. What the app implements per capability

| Tool (already registered, status `NOT_CURRENTLY_POSSIBLE` today) | What the app must do |
|---|---|
| `send_whatsapp_message` | WhatsApp Business API call *or*, for personal WhatsApp, Android AccessibilityService driving the WhatsApp UI (fragile, ToS-sensitive — Business API is the legitimate path) |
| `make_phone_call` | `Intent.ACTION_CALL` (Android) / CallKit (iOS), or route through Twilio if the "call" should come from an assistant number, not the user's own line |
| screen control tools | AccessibilityService (Android) / VoiceOver-based automation (iOS) — enumerate UI nodes, dispatch synthetic taps; genuinely fragile across app updates, matches spec section 48's own caution about not hard-coding coordinates |
| `read_notifications` | NotificationListenerService (Android) / Notification Service Extension (iOS, limited) |
| camera/mic capture tools | standard platform camera/audio APIs, gated behind the OS permission prompt |

## 4a. Capability actions the core already routes (desktop or Android)

These are wired up in `src/tools/builtins/deviceTools.js` and will reach the
app the moment it polls and answers them — no core changes needed:

| capability | action | what the app does |
|---|---|---|
| `system` | `read_system_info` | return battery/network/CPU/memory snapshot |
| `applications` | `list` / `open_application` / `close_application` | enumerate/launch/close apps the OS permits |
| `browser` | `open_url` | open the default browser to a URL |
| `files` | `list_files` / `prepare_transfer` / `receive_transfer` | list a permitted directory; read a file for outbound transfer; accept and save an inbound one |
| `media` | `play` / `pause` / `stop` / `volume_up` / `volume_down` / `mute` | standard media session controls |

`device_transfer_file` chains two commands (`prepare_transfer` on the source,
`receive_transfer` on the target) and only queues the second if the first
genuinely reports success — see spec section 19.

## 5. Security requirements the app must uphold

Per spec section 54 (zero-bypass rule): the app must never attempt to
defeat biometric auth, extract stored credentials, or operate outside what
the OS permission model allows. If the OS blocks an action, the app reports
that back as a failure — the core already surfaces "I don't have permission
to perform that action" rather than guessing.
