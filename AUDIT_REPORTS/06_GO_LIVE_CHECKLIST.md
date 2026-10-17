# XOFT — Go-Live Checklist (the last mile, done outside this sandbox)

Everything code-level is done and tested (209/209 + 6/6). This is the exact,
ordered list of what's left, and it's all things that need real
infrastructure this sandbox structurally cannot have — proven, not assumed,
in `05_FIXES_APPLIED_0.10.2.md` and this session (a real `docker.io` install
attempt 404'd on the package mirror; a real `services.gradle.org` request
got `403 host_not_allowed`; your real Experiential key got the same `403`
when tested here).

Two extra checks were run this session with no daemon/SDK needed, so these
two are now more verified than "structurally reviewed":
- **`Dockerfile`**: linted with `hadolint` v2.12.0 (downloaded from its real
  GitHub release, run for real) — **zero warnings.**
- **`.github/workflows/ci.yml`, `release.yml`, `docker-compose.yml`**:
  parsed with a real YAML parser — **all syntactically valid**, correct job
  names present (`backend`, `android`, `universal-structure`,
  `android-release`, `backend-image`).

## 1. Push to GitHub (closes Docker build + Android build automatically)

```bash
git init && git add -A && git commit -m "XOFT — audited and hardened"
git remote add origin <your-repo-url>
git push -u origin main
```

Once pushed, `.github/workflows/ci.yml` runs on GitHub's own infrastructure
and will:
- actually `docker build` the image (this sandbox never could)
- actually run `gradle assembleDebug` against the real Android SDK/AGP
  (this sandbox's request for Gradle itself was blocked)
- run the same 209 backend tests again, on a clean machine

Check the Actions tab after pushing. If `android` or `backend-image` fails,
the log will say exactly why — that's real signal this sandbox couldn't
give you.

## 2. Set real AI provider credentials, verify a live chat call

```bash
cp .env.example .env
# set at least one: OPENAI_API_KEY, GEMINI_API_KEY, CLAUDE_API_KEY,
# XAI_API_KEY, or EXPERIENTIAL_API_KEY (the key from this session — set it
# here now, in your own local .env, which is git-ignored)
npm install && node src/index.js
curl -X POST http://localhost:3000/api/chat -H 'Content-Type: application/json' \
  -d '{"message":"say hello"}'
```
A real model response confirms the provider path end to end. If you use
`EXPERIENTIAL_API_KEY` with `EXPERIENTIAL_FREE_ONLY=true` (the default),
confirm `qwen3.8-27b` (or whatever `GET /api/ai/models` returns as free for
your key right now — free-tier models can change) is still free before
relying on it.

## 3. WhatsApp — real Business account

1. Create a Meta developer app + WhatsApp Business account.
2. Set `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
   `WHATSAPP_VERIFY_TOKEN` (any string you choose), `WHATSAPP_APP_SECRET`.
3. Deploy XOFT somewhere with a public HTTPS URL (see §5).
4. In the Meta app dashboard, set the webhook URL to
   `https://<your-domain>/webhooks/whatsapp` and the verify token to match
   `WHATSAPP_VERIFY_TOKEN`. Meta will call the GET challenge route
   (`ChannelGateway`/`WhatsAppService.verifyWebhookToken` — already tested
   with 9 passing tests) to confirm.
5. Send a real WhatsApp message to your business number; confirm it reaches
   the same `ExecutiveBrain` your web chat uses and a reply comes back.

## 4. Twilio — real phone number

1. Create a Twilio account, buy a number.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`,
   and the three webhook URL vars to your deployed domain.
3. In the Twilio console, set the number's Voice webhook to
   `https://<your-domain>/webhooks/twilio/voice`.
4. Call the number; confirm TwiML comes back and speech routes through the
   same Core.

## 5. Deploy somewhere with real HTTPS (needed for §3, §4, and PWA install)

Any of: a VPS with Caddy/Nginx + Let's Encrypt, Cloudflare Tunnel, Fly.io,
Railway — anything that terminates TLS in front of `docker compose up` (or
`node src/index.js` directly). `docs/DEPLOYMENT.md` has the exact steps.

## 6. Install the PWA on a real phone

Once §5 is live: open the HTTPS URL in Chrome (Android) or Safari (iOS),
use "Add to Home Screen" / "Install app". `README.md` §19 has exact steps
per platform.

## 7. PC Agent on a real machine

```bash
cd pc-agent && npm install && npm run pair
```
Point it at your deployed Core's URL, approve the pairing in the web UI,
then dispatch one real command (e.g. "open Notepad") from the assistant and
confirm it actually happens.

## 8. Android companion on a real device or emulator

After §1's CI produces a debug APK artifact: install it (`adb install
app-debug.apk` on an emulator, or sideload on a real phone), grant
Accessibility + notification permissions, confirm it registers with your
deployed Core and a dispatched command executes.

---

None of the above needs anything from me that isn't already in this
package. Every step is copy-paste-able from `README.md`, `.env.example`,
or this checklist. If any step produces an error, that error is real signal
worth bringing back — I can debug it from the actual output far better than
from another round of "try to implement it in a sandbox that can't reach
the relevant server."
