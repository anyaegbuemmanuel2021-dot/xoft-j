// Optional free local STT fallback. Model files are cached by the browser after first download.
// Audio is processed in the browser; no audio is sent to a paid transcription API.
let transcriberPromise;

async function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2');
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      return pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny.en', { dtype: 'q8' });
    })().catch((error) => {
      transcriberPromise = null;
      throw error;
    });
  }
  return transcriberPromise;
}

export async function transcribeAudioBlob(blob) {
  if (!blob || !blob.size) throw new Error('No recorded audio was available.');
  const { pipeline: _pipeline } = await getTranscriber().then(transcriber => ({ pipeline: transcriber }));
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || !window.OfflineAudioContext) throw new Error('This browser does not support local audio processing.');
  const context = new AudioContextClass();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const rate = 16000;
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
    const source = offline.createBufferSource();
    const mono = context.createBuffer(1, decoded.length, decoded.sampleRate);
    mono.copyToChannel(decoded.getChannelData(0), 0);
    source.buffer = mono;
    source.connect(offline.destination);
    source.start(0);
    const audio = await offline.startRendering();
    const result = await _pipeline(audio.getChannelData(0), { sampling_rate: rate });
    return String(result?.text || '').trim();
  } finally {
    await context.close().catch(() => {});
  }
}
