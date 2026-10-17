# XOFT Communication Integrations

## Status

| Capability | Current source status | Live external service required |
|---|---|---|
| WhatsApp Cloud API outbound text | Implemented adapter/tool; requires configuration | Yes |
| WhatsApp webhook inbound text | Implemented and signature-verified; saved to a durable inbox | Yes |
| WhatsApp outbound reply + inbox history | Implemented through official Cloud API; visible in Plugins & Apps | Yes |
| Mark inbound message read | Implemented through official Cloud API | Yes |
| AI conversation analysis | Implemented using the configured XOFT model provider | Yes, plus an AI provider key |
| Publish WhatsApp Status story | Not supported by official Cloud API; XOFT can create a draft | Manual post in WhatsApp app |
| Twilio outbound call | Implemented adapter/tool; requires configuration | Yes |
| Twilio inbound voice webhook | Implemented | Yes |
| Twilio speech turn -> XOFT Core -> spoken response | Implemented through Twilio `<Gather>`/`<Say>` | Yes |

These are **channels into XOFT Core**, not separate AI brains.

## WhatsApp Cloud API

Set:

```env
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_API_VERSION=v23.0
```

Configure the provider webhook to:

```text
GET/POST /webhooks/whatsapp
```

The GET request performs the provider verification-token challenge. POST
requests require a valid `X-Hub-Signature-256` HMAC signature.

Inbound text messages are normalized into a channel session:

```text
whatsapp:<phone-number-id>:<sender-number>
```

and passed to the same `ExecutiveBrain` used by web chat. If XOFT returns a
reply, the adapter sends it through the official Cloud API.

The inbox stores recent inbound/outbound text messages in `data/whatsapp_inbox.json` (bounded history, max 5,000 messages by default). Delivery webhooks update stored message statuses when the corresponding outgoing message is known. Use `GET /api/whatsapp/status`, `GET /api/whatsapp/inbox`, `GET /api/whatsapp/conversations/:contact`, `POST /api/whatsapp/reply`, `POST /api/whatsapp/read`, and `POST /api/whatsapp/analyze` from the dashboard or an authenticated client. The Plugins & Apps screen provides inbox, reply, read, and analysis controls.

Important limits: this is the WhatsApp Business Platform / Cloud API connector, not a QR-code session for a personal WhatsApp Messenger account. It can only see messages delivered to the configured business number/webhook; it cannot scan a user's existing private chat history. The official Cloud API does not provide a supported endpoint for publishing WhatsApp Status stories, so `POST /api/whatsapp/status-draft` prepares text for manual posting only. Media, templates, interactive messages, broader delivery reconciliation, and business-account management remain additional integration work.

## Twilio voice

Set:

```env
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
TWILIO_PUBLIC_BASE_URL=https://your-host.example
TWILIO_VOICE_WEBHOOK_URL=https://your-host.example/webhooks/twilio/voice
TWILIO_VOICE_RESPONSE_URL=https://your-host.example/webhooks/twilio/voice/respond
TWILIO_STATUS_CALLBACK_URL=https://your-host.example/webhooks/twilio/status
```

The outbound `make_phone_call` tool uses the Twilio REST Calls API. The call
then enters the XOFT voice webhook. Twilio speech recognition provides
`SpeechResult`; XOFT sends that text through `ExecutiveBrain`; the response is
returned as TwiML `<Say>` output and the call remains in a speech gather loop.

Webhook requests are validated with Twilio's `X-Twilio-Signature`.

This implementation deliberately does not claim that a phone number,
telephony account, speech service, or provider credentials exist. Without
configuration the tool remains unavailable and reports the exact missing
integration instead of simulating a call.

## Security

Do not expose the webhook endpoints without the provider's signature/token
verification configured. Use HTTPS in production. Keep access tokens,
app secrets, and Twilio credentials out of source control.
