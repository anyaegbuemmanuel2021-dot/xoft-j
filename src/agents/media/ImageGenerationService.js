import { config } from '../../config/index.js';

const BASE_URL = 'https://api.openai.com/v1';

/**
 * ImageGenerationService — real image generation via OpenAI's Images API.
 * Model defaults to gpt-image-2 (current as of this build; override via
 * IMAGE_MODEL if OpenAI ships a newer one or you want gpt-image-1 instead).
 */
export class ImageGenerationService {
  isConfigured() {
    return Boolean(config.providers.openai.apiKey);
  }

  /**
   * @param {string} prompt
   * @param {{size?:string, n?:number}} [options] size e.g. '1024x1024', '1536x1024', '1024x1536'
   * @returns {Promise<Array<Buffer>>} PNG image bytes, one per requested image
   */
  async generate(prompt, { size = '1024x1024', n = 1 } = {}) {
    if (!this.isConfigured()) {
      throw new Error('ImageGenerationService: OPENAI_API_KEY is not set.');
    }
    const res = await fetch(`${BASE_URL}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.providers.openai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.media.imageModel,
        prompt,
        size,
        n,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`ImageGenerationService: API error ${res.status} - ${errText}`);
    }

    const data = await res.json();
    if (!data.data?.length) {
      throw new Error('ImageGenerationService: API returned no image data.');
    }
    return data.data.map((d) => Buffer.from(d.b64_json, 'base64'));
  }
}
