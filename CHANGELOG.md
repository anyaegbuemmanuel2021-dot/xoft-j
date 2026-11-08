# Changelog

## xoft 0.0.1
- Renamed the product to **xoft** and reset the version to 0.0.1.
- **STT:** Gemini first, OpenAI fallback. Failures hand over instantly; slow answers are hedged (`STT_HEDGE_MS`, default 800 ms) and the first usable transcript wins.
- **TTS:** Gemini speech first, OpenAI speech fallback, optional ElevenLabs last, then the browser voice. Same hedging (`TTS_HEDGE_MS`, default 1200 ms). Gemini PCM is wrapped as WAV server-side.
- First spoken chunk no longer waits on the voice-status request.
- Live voice screen: the orb now shows the XOFT AI-core artwork, animated by listening / speaking / thinking state, with a reduced-motion alternative.
- Android companion: new **XOFT Live** screen and a floating XOFT bubble that appears when you leave the app during a live conversation (needs the "display over other apps" permission). Not compiled in this environment: build it once with Android Studio / Gradle before relying on it.
- Tests: voice suites rewritten for the new order; new `test/xoftV001.test.js`.

## xoft 0.0.1 (UI and speed pass)
- No emoji or pictographic symbols anywhere (UI, CLI, docs, reports). Icon-only controls use a CSS mask; labels are plain text. Removed the two mock demo pages.
- UI text: removed static explanatory paragraphs and help notes from every page; only data and controls remain.
- New `public/css/uniform.css` (loaded last): buttons, chips, fields and containers hug their content with small padding, one radius, one font size, short 120 ms transitions.
- Speed: no artificial boot delay, images cached for a week, code and styles revalidate with ETag, first spoken chunk never waits on a status call.
- Claude default model is now `claude-sonnet-5-5`.
- Command Center: GOD MODE sets autonomy to level 5 (mission autonomy). Destructive actions, payments and sensitive files still require approval at every level.
