# XOFT-J Update Guide

## Deploy flow
1. Make changes on the `main` branch of `anyaegbuemmanuel2021-dot/xoft-j`.
2. Run syntax checks and the relevant Node test suite before pushing.
3. Render is configured to auto-deploy commits from `main`; verify the newest deployment reaches `live` before treating a change as deployed.
4. Open the live app and confirm the health/status endpoints and the user-facing feature changed by the commit.

## Voice/STT configuration
Set `STT_PROVIDER_ORDER=openai,gemini`, `STT_HEDGE_MS=1000`, `STT_TIMEOUT_MS=15000`, and `STT_LANGUAGE=en` as appropriate. Server transcription requires at least one valid provider key: `OPENAI_API_KEY` for Whisper and/or `GEMINI_API_KEY` for Gemini audio transcription. Never commit provider keys to `.env.example` or source control.

The browser client attempts server transcription first, then a free on-device Whisper fallback. The local model needs a supported browser, audio processing APIs, network access for its first model download, and enough device memory. The microphone requires HTTPS and user permission.

## After deployment
- Verify `GET /api/voice/status` reports the configured STT providers.
- Test `POST /api/voice/transcribe` with a short recording from the actual target phone/browser.
- Test both push-to-talk and continuous listening.
- Check Render logs for authentication, quota, request-size, or provider errors.
- On mobile, refresh/reopen the PWA so the new service worker and assets activate.