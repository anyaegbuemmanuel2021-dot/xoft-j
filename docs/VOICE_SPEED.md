# Voice Latency and Reliability

## Speech-to-text
- OpenAI Whisper is the default server STT provider; Gemini is the fallback when configured.
- `STT_PROVIDER_ORDER` selects the provider order. `STT_HEDGE_MS` starts the next provider after a short delay when configured, reducing latency when the preferred provider is slow.
- `STT_TIMEOUT_MS` bounds server-side requests. `STT_LANGUAGE` controls the requested transcription language when supported.
- A failed server request falls back to browser-local Whisper where supported. The first local use downloads a model; later use can benefit from browser caching.

## Text-to-speech
- `ELEVENLABS_OUTPUT_FORMAT` chooses the ElevenLabs output format.
- `TTS_TIMEOUT_MS` limits how long the server waits for the speech provider.
- Browser speech is a fallback when server TTS is not available or fails.

## Debugging
1. Open `/api/voice/status` and confirm STT is configured.
2. Confirm Render has a valid `OPENAI_API_KEY` and/or `GEMINI_API_KEY`; environment variable names alone do not prove that a key is valid or has quota.
3. Allow microphone access on the HTTPS app and test with a short, clearly spoken phrase.
4. If server STT fails, inspect the API response and Render logs. Common causes are missing/invalid keys, exhausted quota, unsupported audio MIME type, request-size limits, or network/provider timeouts.
5. If local Whisper fails on first use, confirm the device can download the model from the configured CDN and has sufficient memory.