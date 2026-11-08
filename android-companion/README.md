# XOFT Android Companion

Native Android agent for XOFT Core. It registers a device, sends heartbeats/state/capabilities, polls the command channel, and executes only capabilities the OS/user has actually enabled.

## Setup
1. Start XOFT Core with a public HTTPS URL reachable by the phone.
2. Set `AUTH_API_KEYS` on the server and enter the same key in the app.
3. Enter the Core URL and API key in the app, then **Save & Start Agent**.
4. Trust the newly registered device from the Core API/UI.
5. Enable Accessibility for screen actions and Notification Access for notification reading.

The companion does not bypass Android sandboxing, lock screens, biometrics, permissions, or Play policy. For production, use HTTPS and a device-specific credential rather than a shared key.
