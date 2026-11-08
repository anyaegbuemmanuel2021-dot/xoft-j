# XOFT Native Intelligence and Voice

## Design rule
Use deterministic programming for known operations and reserve AI models for genuinely open-ended language work. A model must never be required for a command that can be handled safely with a parser, variable, condition, state machine, or registered tool.

## Deterministic execution
- `NativeCommandEngine` runs explicit allow-listed date/time and arithmetic commands before model routing.
- Executive intent classification uses fixed phrase/verb rules. Unknown requests are delegated safely.
- Memory remember/forget/recall intents use explicit deterministic grammar. Ambiguous language and broad destructive requests fail safe.
- Existing tool permissions, approvals, audit logging, and kill-switch checks remain in the execution path.

## Android voice
- STT prefers Android's on-device `SpeechRecognizer` when available and microphone permission is granted.
- Native recognition is continuous at the app level: each utterance is delivered to the existing `VoicePipeline`, then the recognizer restarts. Silence/no-match is normal; real failures use bounded retries.
- TTS prefers Android's native `TextToSpeech` engine. It requires installed voice data; Nigerian English is preferred with US English fallback.
- The primary chat/live-conversation screen and voice companion use the native bridge when available.
- XOFT pauses recognition while speaking and resumes after the reply.

## Web fallback
A normal browser cannot call Android OS speech services. Web-only sessions capture microphone audio and send it to XOFT server STT. Speech output uses the server-generated TTS endpoint. Browser `SpeechRecognition` and `speechSynthesis` are not used.

## Technical limit
STT cannot be implemented with if/else statements alone. It needs an acoustic recognizer (OS speech service or speech model) to map sound waves to words. TTS likewise needs a synthesis engine. The command routing, wake phrase matching, confirmation, memory, retries, state, and automation around those engines can and should be deterministic.

## Reliability rules
1. Preserve captured audio until the transcript is accepted or explicitly discarded.
2. Do not replay stale voice commands after reconnecting.
3. Never auto-confirm risky actions.
4. Retry real recognizer failures with bounded backoff; silence is not a failure.
5. Keep server STT/TTS as explicit web fallback, not a hidden browser dependency.
6. Report unavailable language packs or OS voices clearly.
