import { config } from '../../config/index.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * VideoGenerationService — real video generation via Google's Veo model
 * through the Gemini API. This is a long-running operation: submit a
 * prompt, get an operation name back, poll it until done, then download
 * the result. Confirmed against Google's own current documentation for
 * this exact request/response shape (models/{model}:predictLongRunning,
 * poll {operationName}, download response.generateVideoResponse.
 * generatedSamples[0].video.uri).
 */
export class VideoGenerationService {
  isConfigured() {
    return Boolean(config.providers.gemini.apiKey);
  }

  /**
   * @param {string} prompt
   * @returns {Promise<string>} operation name, e.g. "operations/abc123", to pass to checkStatus()
   */
  async startGeneration(prompt) {
    if (!this.isConfigured()) {
      throw new Error('VideoGenerationService: GEMINI_API_KEY is not set.');
    }
    const res = await fetch(`${BASE_URL}/models/${config.media.videoModel}:predictLongRunning`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.providers.gemini.apiKey,
      },
      body: JSON.stringify({ instances: [{ prompt }] }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`VideoGenerationService: failed to start generation ${res.status} - ${errText}`);
    }

    const data = await res.json();
    if (!data.name) {
      throw new Error(`VideoGenerationService: no operation name in response - ${JSON.stringify(data)}`);
    }
    return data.name;
  }

  /**
   * @param {string} operationName
   * @returns {Promise<{done:boolean, videoUri?:string, error?:string}>}
   */
  async checkStatus(operationName) {
    if (!this.isConfigured()) {
      throw new Error('VideoGenerationService: GEMINI_API_KEY is not set.');
    }
    const res = await fetch(`${BASE_URL}/${operationName}`, {
      headers: { 'x-goog-api-key': config.providers.gemini.apiKey },
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`VideoGenerationService: status check failed ${res.status} - ${errText}`);
    }
    const data = await res.json();
    if (!data.done) return { done: false };
    if (data.error) return { done: true, error: data.error.message ?? JSON.stringify(data.error) };

    const videoUri = data.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
    if (!videoUri) {
      return { done: true, error: `No video URI in completed response: ${JSON.stringify(data.response)}` };
    }
    return { done: true, videoUri };
  }

  /** @param {string} videoUri @returns {Promise<Buffer>} MP4 bytes */
  async download(videoUri) {
    const res = await fetch(videoUri, {
      headers: { 'x-goog-api-key': config.providers.gemini.apiKey },
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new Error(`VideoGenerationService: download failed ${res.status}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Convenience: submit + poll until done or timeout, then download if
   * ready. Bounded — this will NOT poll forever. If it times out, the
   * operation is still running server-side; the caller gets the
   * operationName back to check again later rather than the request
   * hanging indefinitely.
   * @param {string} prompt
   * @param {{maxWaitMs?:number, pollIntervalMs?:number}} [options]
   */
  async generateAndWait(prompt, { maxWaitMs = 180_000, pollIntervalMs = 10_000 } = {}) {
    const operationName = await this.startGeneration(prompt);
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      const status = await this.checkStatus(operationName);
      if (status.done) {
        if (status.error) throw new Error(`VideoGenerationService: generation failed - ${status.error}`);
        const videoBuffer = await this.download(status.videoUri);
        return { done: true, operationName, videoBuffer };
      }
    }
    return { done: false, operationName }; // still running — caller can poll operationName later
  }
}
