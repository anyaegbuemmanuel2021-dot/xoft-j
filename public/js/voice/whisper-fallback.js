// Free multilingual local speech-to-text fallback. The model is downloaded from the public model repository
// on first use and cached by the browser. Recorded audio is processed in-browser.
let transcriberPromise;

async function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2');
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      return pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny', { dtype: 'q8' });
    })().catch((error) => {
      transcriberPromise = null;
      throw error;
    });
  }
  return transcriberPromise;
}

function hasAudibleSignal(samples) {
  if (!samples || !samples.length) return false;
  let energy = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Number(samples[i]) || 0;
    energy += value * value;
    peak = Math.max(peak, Math.abs(value));
  }
  const rms = Math.sqrt(energy / samples.length);
  // Avoid running Whisper on digital silence or near-silent captures, where it may hallucinate words.
  // This is a conservative silence gate, not a general-purpose noise classifier.
  return rms >= 0.003 && peak >= 0.01;
}

export async function transcribeAudioBlob(blob, { language = 'auto' } = {}) {
  if (!blob || !blob.size) throw new Error('No recorded audio was available.');

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const OfflineAudioContextClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AudioContextClass || !OfflineAudioContextClass) {
    throw new Error('This browser does not support local audio processing.');
  }

  const context = new AudioContextClass();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const sampleRate = 16000;
    const frameCount = Math.ceil(decoded.duration * sampleRate);
    if (!frameCount) throw new Error('The recording was empty.');

    // Whisper expects mono, 16 kHz audio. The offline context also resamples it.
    const offline = new OfflineAudioContextClass(1, frameCount, sampleRate);
    const source = offline.createBufferSource();
    const mono = context.createBuffer(1, decoded.length, decoded.sampleRate);
    const channel = decoded.getChannelData(0);
    mono.copyToChannel(channel, 0);
    source.buffer = mono;
    source.connect(offline.destination);
    source.start(0);
    const audio = await offline.startRendering();
    const samples = audio.getChannelData(0);
    if (!hasAudibleSignal(samples)) {
      throw new Error('No clear speech signal was detected; please speak closer to the microphone and try again.');
    }

    const transcriber = await getTranscriber();
    const options = { sampling_rate: sampleRate };
    if (language === 'en' || language === 'ig') options.language = language === 'ig' ? 'Igbo' : 'English';
    const result = await transcriber(samples, options);
    const text = String(result?.text || '').trim();
    if (!text) throw new Error('Whisper did not detect any speech.');
    return text;
  } finally {
    await context.close().catch(() => {});
  }
}
