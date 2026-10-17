import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Tool, RiskLevel } from '../Tool.js';
import { ImageGenerationService } from '../../agents/media/ImageGenerationService.js';
import { VideoGenerationService } from '../../agents/media/VideoGenerationService.js';

const GENERATED_DIR = path.join(process.cwd(), 'public', 'generated');
fs.mkdirSync(GENERATED_DIR, { recursive: true });

const imageService = new ImageGenerationService();
const videoService = new VideoGenerationService();

export function buildMediaTools() {
  const imageStatus = imageService.isConfigured() ? 'IMPLEMENTED' : 'REQUIRES_API';
  const videoStatus = videoService.isConfigured() ? 'IMPLEMENTED' : 'REQUIRES_API';

  return [
    new Tool({
      name: 'generate_image',
      description: 'Generate an image from a text description. Returns a URL to the saved image.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          size: { type: 'string', description: "e.g. '1024x1024', '1536x1024', '1024x1536'" },
        },
        required: ['prompt'],
      },
      // Content generation, not destructive, but has real cost per call — LOW rather than SAFE.
      riskLevel: RiskLevel.LOW,
      status: imageStatus,
      execute: async ({ prompt, size }) => {
        const [imageBuffer] = await imageService.generate(prompt, { size: size ?? '1024x1024' });
        const filename = `${crypto.randomUUID()}.png`;
        fs.writeFileSync(path.join(GENERATED_DIR, filename), imageBuffer);
        return { url: `/generated/${filename}`, prompt };
      },
    }),

    new Tool({
      name: 'generate_video',
      description:
        'Generate a short video clip from a text description. This takes time (often 1-3+ minutes) — if it ' +
        "doesn't finish within the wait window, returns an operationName to check later via check_video_generation " +
        'instead of blocking indefinitely.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          maxWaitSeconds: { type: 'number', description: 'how long to wait before returning pending instead of the finished video (default 180)' },
        },
        required: ['prompt'],
      },
      // Real cost, real generation time, real potential for misuse (deepfake-adjacent content) — EXTERNAL,
      // requires approval by default rather than running unattended.
      riskLevel: RiskLevel.EXTERNAL,
      status: videoStatus,
      execute: async ({ prompt, maxWaitSeconds }) => {
        const result = await videoService.generateAndWait(prompt, { maxWaitMs: (maxWaitSeconds ?? 180) * 1000 });
        if (!result.done) {
          return { pending: true, operationName: result.operationName, note: 'Still generating — check with check_video_generation.' };
        }
        const filename = `${crypto.randomUUID()}.mp4`;
        fs.writeFileSync(path.join(GENERATED_DIR, filename), result.videoBuffer);
        return { url: `/generated/${filename}`, prompt };
      },
    }),

    new Tool({
      name: 'check_video_generation',
      description: 'Check on a video generation that was still running (returned "pending") — pass the operationName it gave you.',
      inputSchema: { type: 'object', properties: { operationName: { type: 'string' } }, required: ['operationName'] },
      riskLevel: RiskLevel.SAFE, // read-only status check, not a new generation
      status: videoStatus,
      execute: async ({ operationName }) => {
        const status = await videoService.checkStatus(operationName);
        if (!status.done) return { pending: true, operationName };
        if (status.error) return { pending: false, error: status.error };
        const videoBuffer = await videoService.download(status.videoUri);
        const filename = `${crypto.randomUUID()}.mp4`;
        fs.writeFileSync(path.join(GENERATED_DIR, filename), videoBuffer);
        return { url: `/generated/${filename}` };
      },
    }),
  ];
}
