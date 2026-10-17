# XOFT Connectors & Background AI

XOFT now has a connector layer for explicitly configured external services plus a background AI bridge.

## What this adds

- **OpenAI + Claude in the background** through the existing provider abstraction.
- **Authorized screen -> AI**: `ai_background_task` can capture a connected device screen and send it to a configured OpenAI/Claude provider for analysis.
- **External connectors** through `http-json` or `mcp-http`.
- Connector discovery via `GET /api/connectors/:id/tools` and `connector_discover`.
- Connector calls via `connector_call`.
- Connector credentials remain server-side and are not exposed by the connector list.
- Existing permission, approval, emergency-stop and device gates remain in force.

## Canva

Canva is represented as a connector, not as a fake built-in Canva API. Configure a real Canva API/MCP endpoint and credentials in `XOFT_CONNECTORS_JSON`.

Example shape:

```json
[{"id":"canva","name":"Canva","transport":"mcp-http","endpoint":"https://YOUR-CANVA-MCP-ENDPOINT","headers":{"Authorization":"Bearer YOUR_TOKEN"},"permissions":["connectors.use"],"riskLevel":2}]
```

The endpoint and authentication method must come from the actual Canva integration you choose. XOFT deliberately does not invent or hard-code a nonexistent Canva endpoint.

## ChatGPT vs OpenAI API

XOFT can use OpenAI models in the background through `OPENAI_API_KEY`. That is different from controlling a user's consumer ChatGPT app/account UI. If you want XOFT to operate the ChatGPT website itself, that is a device/browser automation problem and requires a connected device with the appropriate permissions; it is not created merely by adding an API key.

The same distinction applies to Claude: `ANTHROPIC_API_KEY` gives XOFT model access, while operating the Claude consumer website/app requires a connected device/browser session.

## Screen understanding

`device_screen_understand` already captures a real connected-device screen and sends it to a vision-capable provider. `ai_background_task` extends this so a chosen provider can be asked a custom question about the captured screen.

The device agent must genuinely implement the `screen.capture` capability. XOFT never reports a successful capture when no device actually returned an image.

## Agent OS / computer-use contract

XOFT now exposes `device_computer_use` and `device_screen_verify` as bounded tools. The core performs planning and verification; native agents remain responsible for actual OS input. A native agent must explicitly advertise `computer_use` and implement `computer_use.act` before XOFT can control it this way.

The intended loop is:

1. Capture the authorized screen.
2. Vision model identifies the visible target and uncertainty.
3. Native agent performs a bounded action.
4. Capture again.
5. Vision verifies the expected outcome.
6. If verification fails, adaptive recovery selects an existing, equal-or-lower-risk strategy.
7. The outcome is stored for future recovery decisions.

No arbitrary shell/process execution is introduced by this layer.
