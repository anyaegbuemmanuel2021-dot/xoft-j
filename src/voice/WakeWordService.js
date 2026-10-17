/**
 * WakeWordService — the parts of "wake word / voice activity detection /
 * barge-in" that a backend server genuinely CAN do, same honesty line
 * VoiceService already draws for TTS/STT: continuous microphone listening
 * only exists in a client with mic access, so it is NOT here. What IS here:
 *
 *   - detectVoiceActivity(pcm): real energy-based VAD over a submitted PCM
 *     buffer (16-bit signed little-endian mono), returning which frames
 *     contain speech-level energy. A client streams short audio chunks to
 *     this and only forwards chunks flagged as speech to STT — cutting
 *     wasted Whisper calls on silence, and enabling barge-in (the client
 *     can flag "user started talking while XOFT's TTS was playing" the
 *     moment a chunk trips this, without waiting for a full STT round trip).
 *   - matchWakePhrase(transcript): real substring/fuzzy match of a
 *     transcribed phrase against configured wake phrases. This is
 *     transcript-based (after STT), not audio-based keyword spotting —
 *     an honestly weaker, but real and immediately usable, alternative to
 *     an on-device wake-word model. A client can run a short rolling STT
 *     window and call this on each result.
 *
 * Neither of these requires the client to run continuously-listening
 * native code beyond what VoiceService already needs for STT — they are
 * genuinely usable from any client that can capture short audio chunks.
 */
const DEFAULT_WAKE_PHRASES = ['hey xoft', 'ok xoft', 'xoft'];

function levenshtein(a, b) {
  const m = a.length; const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

export class WakeWordService {
  constructor({ wakePhrases = DEFAULT_WAKE_PHRASES, sampleRate = 16000 } = {}) {
    this.wakePhrases = wakePhrases.map((p) => p.toLowerCase());
    this.sampleRate = sampleRate;
  }

  /**
   * @param {Buffer} pcmBuffer 16-bit signed little-endian mono PCM
   * @param {{frameMs?:number, energyThreshold?:number}} [opts] energyThreshold is on normalized RMS (0..1)
   * @returns {{frames:Array<{startMs:number,endMs:number,rms:number,speech:boolean}>, anySpeech:boolean}}
   */
  detectVoiceActivity(pcmBuffer, { frameMs = 30, energyThreshold = 0.02 } = {}) {
    if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length < 2) return { frames: [], anySpeech: false };
    const samplesPerFrame = Math.max(1, Math.round((this.sampleRate * frameMs) / 1000));
    const bytesPerFrame = samplesPerFrame * 2;
    const frames = [];
    let anySpeech = false;
    for (let offset = 0; offset + 1 < pcmBuffer.length; offset += bytesPerFrame) {
      const end = Math.min(offset + bytesPerFrame, pcmBuffer.length - (pcmBuffer.length % 2 === 1 ? 1 : 0));
      let sumSquares = 0; let count = 0;
      for (let i = offset; i + 1 < end; i += 2) {
        const sample = pcmBuffer.readInt16LE(i) / 32768;
        sumSquares += sample * sample;
        count += 1;
      }
      if (count === 0) break;
      const rms = Math.sqrt(sumSquares / count);
      const speech = rms >= energyThreshold;
      if (speech) anySpeech = true;
      const startMs = (offset / 2 / this.sampleRate) * 1000;
      frames.push({ startMs: Math.round(startMs), endMs: Math.round(startMs + frameMs), rms: Number(rms.toFixed(4)), speech });
    }
    return { frames, anySpeech };
  }

  /**
   * @param {string} transcript
   * @param {{maxEditDistance?:number}} [opts]
   * @returns {{matched:boolean, phrase:string|null, editDistance:number|null}}
   */
  matchWakePhrase(transcript, { maxEditDistance = 1 } = {}) {
    const text = String(transcript ?? '').toLowerCase().trim();
    if (!text) return { matched: false, phrase: null, editDistance: null };
    for (const phrase of this.wakePhrases) {
      if (text.includes(phrase)) return { matched: true, phrase, editDistance: 0 };
    }
    // Fuzzy fallback for short utterances only (avoids expensive/misleading distance checks on long transcripts).
    if (text.split(/\s+/).length <= 4) {
      for (const phrase of this.wakePhrases) {
        const dist = levenshtein(text, phrase);
        if (dist <= maxEditDistance) return { matched: true, phrase, editDistance: dist };
      }
    }
    return { matched: false, phrase: null, editDistance: null };
  }
}
