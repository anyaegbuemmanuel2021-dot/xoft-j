# XOFT AI CORE — Railway deployment checklist

This repository is configured to build from the root `Dockerfile`. The
`railway.json` file sets the start command, health check, and restart policy.
Railway's GitHub connection and auto-deploy switch still have to be enabled in
the Railway dashboard; repository code cannot enable that account-level setting.

## 1. Connect the correct source

In Railway, open the XOFT backend service and confirm:

- Source repository: `anyaegbuemmanuel2021-dot/xoft-j`
- Trigger branch: `main`
- Auto-deploy: **Enabled**
- Build uses the repository root `Dockerfile`

The GitHub account connected to Railway must have contributor access to this
repository. If Railway offers **Wait for CI**, enable it after the repository's
GitHub Actions checks have run successfully. That prevents Railway from
deploying a commit when its CI workflow fails.

## 2. Configure production variables

Set these in Railway's service Variables. Do not commit real secrets to GitHub.

Required for a protected production deployment:

- `NODE_ENV=production`
- `AUTH_API_KEYS` — use a long, random secret; keep it private.
- At least one AI provider key, such as `GEMINI_API_KEY`,
  `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`.

Only add optional integration variables when you have configured the relevant
service (Google, web search, ElevenLabs, WhatsApp, Twilio, and others). A model
API key and its account quota/billing must both be valid for live inference.

## 3. Attach persistent storage

XOFT's default storage is SQLite at `/app/data/xoft.sqlite`. Attach a Railway
Volume to the backend service with mount path:

```text
/app/data
```

Without a persistent volume, SQLite data may be lost when a container is
replaced. This repository is designed for a single backend instance with
SQLite; do not scale it horizontally until state and command coordination use
shared infrastructure.

## 4. Deploy and verify

After pushing a commit to `main`:

1. Open Railway → XOFT service → Deployments and confirm a deployment was
   created from the new commit.
2. Wait for the build and health check to pass.
3. Test `GET /healthz` — it should return HTTP 200 and
   `{"ok":true,"service":"xoft-core"}`.
4. Test `GET /readyz` — it should return HTTP 200 and report the configured
   storage mode and enabled connectors.
5. Open the public XOFT dashboard, hard-refresh it, and test Chat, Command
   Center, Speak Out, and at least one configured AI provider.

A healthy `/healthz` confirms the server process is responding; it does not
prove an external AI provider's credentials, quota, or model access are valid.

## 5. Troubleshooting automatic deployments

If a commit appears on GitHub but no deployment is created, check the service's
source repository and trigger branch, ensure Auto-deploy is enabled, confirm
the Railway GitHub App can access this repository, and inspect the Deployments
page for a skipped or failed build. Use **Deploy Latest Commit** only after
checking those settings.

## Scope and limitations

This configuration prepares the Node backend for Railway. It does not create
or configure Railway's project, domain, environment variables, volume, or
GitHub App permissions on your behalf. Those are account/project settings and
must be verified in the Railway dashboard.

## 6. Voice smoke test (after deployment)

The dashboard voice feature is free-first:

- **Speech output:** browser text-to-speech is attempted first. The server-side ElevenLabs endpoint is a fallback and requires `ELEVENLABS_API_KEY` plus a working account/voice configuration.
- **Speech input:** browser speech recognition is attempted first. If it is unsupported or fails with a recoverable error, XOFT starts a microphone recording and uses the public `onnx-community/whisper-tiny.en` model through Transformers.js in the browser. It does **not** require an OpenAI or Hugging Face API key.
- **First Whisper use:** allow the browser to download the model runtime and model weights from jsDelivr/Hugging Face. This requires internet access and can take time. Subsequent use may reuse the browser cache. The configured model is English-only and needs a compatible browser with microphone permission and enough memory.
- **Privacy:** the local Whisper fallback processes the recording in the browser; it does not upload the audio to the XOFT server or a paid transcription API. Browser-native speech recognition may use a browser/vendor service according to that browser's implementation.

Run these checks on the deployed HTTPS domain using Chrome or another supported browser:

1. Open Chat and click **Voice Input**; say a short English sentence and check that recognized text appears in the input box.
2. If browser recognition is unavailable, record again and allow the initial Whisper model download to finish. Confirm the transcript appears and review it before pressing Send.
3. Send a harmless chat message, then use **Speak Out** to confirm the browser reads the response aloud.
4. If browser speech output is unavailable, set `ELEVENLABS_API_KEY` (and the intended `ELEVENLABS_VOICE_ID`) in Railway and repeat the test.
5. If Whisper fails, inspect browser DevTools Console/Network for CSP, CDN, model-download, audio-decoding, or memory errors. A green server `/healthz` response alone does not verify microphone/model operation.

GitHub Actions now runs JavaScript syntax checks, `npm test`, and a Docker image build for pushes and pull requests to `main`. Wait for that workflow to finish successfully before treating the latest commit as CI-verified.
