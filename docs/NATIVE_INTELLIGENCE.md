# XOFT Native Intelligence and Voice

## Design rule

XOFT should use deterministic programming for known operations and reserve AI models for genuinely open-ended language work. An AI provider must never be required for a command that can be handled safely with a fixed parser, a variable, a condition, a state machine, or a registered tool.

## Deterministic execution

- `NativeCommandEngine` runs explicit, allow-listed commands before any model classification.
- The current built-ins include date/time and arithmetic. More commands should be added as narrow parsers that dispatch through `ToolRegistry.execute()`.
- Executive intent classification uses fixed phrase/verb rules. Unknown requests are delegated rather than guessed.
- Memory write/delete intents require explicit verbs. Ambiguous requests are treated as conversation, and broad destructive requests such as “forget everything” are not executed.
- Existing permissions, approvals, audit logging, and kill-switch checks remain in the tool execution path.

## Voice architecture

### Android companion

- STT prefers Android's on-device `SpeechRecognizer` when the OS reports that an on-device recognizer is available and microphone permission is granted.
- The recognizer is created with `createOnDeviceSpeechRecognizer` and offline preference. Language-pack availability is device-dependent; English and Igbo availability must be checked on the actual handset.
- Native recognition is continuous at the app level: each completed utterance is delivered to the existing `VoicePipeline`, then the recognizer restarts with bounded error retries.
- TTS uses Android's native `TextToSpeech` engine first. It needs no XOFT API key. The device must have a compatible installed voice; the app prefers Nigerian English and falls back to US English if that voice is unavailable.
- The companion does not invoke browser `SpeechRecognition` or `speechSynthesis`.

### Web-only fallback

- A normal browser session has no direct access to Android's native speech services. It records microphone audio locally and sends the captured segment to XOFT server STT (Gemini with OpenAI fallback).
- Server TTS is optional when no native Android bridge is present.
- The browser is used for microphone capture and audio playback only; browser-vendor speech recognition and browser speech synthesis are not used.

## Important technical limit

Speech-to-text cannot be implemented with ordinary if/else statements alone. It must use an acoustic speech recognizer (an OS speech service or a speech model) to map sound waves to words. The application logic around that recognizer—wake phrase matching, command routing, confirmation, permissions, retries, state, and automation—can and should be deterministic.

Likewise, text-to-speech needs a speech synthesis engine. Android's native TTS is an OS service with installed voice data, not a cloud AI chat model.

## Reliability rules

1. Preserve the captured audio or transcript until the user command is accepted or explicitly discarded.
2. Never replay a stale voice command after reconnecting.
3. Do not automatically confirm risky commands.
4. Retry native recognizer errors with a bounded backoff; stop after repeated failures and show an actionable message.
5. Keep cloud STT as an explicit fallback, not a hidden dependency for the Android companion.
6. If no speech engine is available, report that clearly instead of silently switching to an unreliable browser API.
