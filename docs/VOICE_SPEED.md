# Voice Latency and Reliability (xoft v0.0.1)

Speed is the first requirement: every step is built to start answering as early as possible.

## Speech-to-text
- Gemini is the default server STT provider; OpenAI (`gpt-4o-mini-transcribe`) is the fallback. The order is fixed in code so a stale environment variable cannot reverse it.
- A failed or empty Gemini answer hands over to OpenAI **immediately** (no waiting).
- A slow Gemini answer is **hedged**: after `STT_HEDGE_MS` (default 800 ms) OpenAI starts in parallel and the first usable transcript wins; the losing request is cancelled.
- `STT_TIMEOUT_MS` bounds each request (default 15 s). `STT_LANGUAGE` pins a language when set; leave it empty for mixed English / Nigerian Pidgin / Igbo.

## Text-to-speech
- Gemini speech (`TTS_GEMINI_MODEL`, voice `TTS_GEMINI_VOICE`) is first; OpenAI speech (`gpt-4o-mini-tts`) is the fallback; ElevenLabs is an optional third server voice; the device voice is the final fallback.
- Same hedging rule: a slow first provider is raced by the next after `TTS_HEDGE_MS` (default 1200 ms).
- The client splits replies into sentence-sized chunks, plays the first chunk as soon as it arrives and synthesises the next two while it plays. The first chunk never waits on the voice-status call.
- Gemini returns raw PCM; the server wraps it as WAV so every browser can play it.

## Debugging
1. Open `/api/voice/status` and confirm `stt.providers` and `tts.providers` list `gemini` and `openai`.
2. Confirm valid `GEMINI_API_KEY` and/or `OPENAI_API_KEY`; a variable being present does not prove the key is valid or has quota.
3. `POST /api/voice/speak` failures return `attempts` (provider, error, ms). The `X-Xoft-TTS-Provider` response header shows which voice answered.
4. Allow microphone access on the HTTPS app and test with a short, clearly spoken phrase.
5. If both server providers fail, the browser voice is used for speech output and a clear error is shown for speech input.
