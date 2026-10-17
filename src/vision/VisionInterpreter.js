/**
 * VisionInterpreter — turns a raw screenshot (base64 PNG from
 * device_screen_capture) into a structured description of what's on screen,
 * so the ExecutiveBrain can reason about UI state instead of only seeing
 * "capture succeeded, here are some bytes."
 *
 * Honesty constraints this module follows (spec sections 8/24/54):
 *  - Never invents exact pixel coordinates the model didn't actually
 *    ground — screen click/type tools still require the caller (or a
 *    future semantic-targeting layer) to supply real coordinates.
 *  - If the model's response isn't valid JSON, that failure is returned
 *    as `parseError`, never silently swallowed into a fake empty result.
 *  - If no vision-capable provider is configured, this throws a specific,
 *    actionable error instead of returning a fabricated interpretation.
 */
export class VisionInterpreter {
  constructor({ providerRouter, activityLog } = {}) {
    if (!providerRouter) throw new Error('VisionInterpreter requires a providerRouter');
    this.providerRouter = providerRouter;
    this.activityLog = activityLog;
  }

  _buildMessages(provider, instruction, base64, mimeType) {
    if (provider.name === 'claude') {
      return [
        {
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          ],
        },
      ];
    }
    // Optional OpenAI-compatible gateways (FreeLLMAPI / LiteLLM) speak the OpenAI image_url shape; ProviderRouter.selectVision() only
    // returns one when the operator asserted its model accepts images.
    if (provider.name === 'openai' || provider.kind === 'gateway') {
      return [
        {
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          ],
        },
      ];
    }
    // Should be unreachable — ProviderRouter.selectVision() only ever
    // returns claude or openai — but fail loudly rather than guess a format.
    throw new Error(`VisionInterpreter: provider '${provider.name}' has no known image message format.`);
  }

  /**
   * @param {object} params
   * @param {string} params.base64 - raw base64 image data (no data: prefix)
   * @param {string} [params.mimeType]
   * @param {string} [params.question] - optional specific question to answer about the screen
   * @returns {Promise<{provider:string, parsed:object|null, parseError:string|null, raw:string, confidence:string}>}
   */
  async interpretScreenshot({ base64, mimeType = 'image/png', question } = {}) {
    if (!base64) throw new Error('VisionInterpreter: base64 screenshot data is required');

    const provider = this.providerRouter.selectVision();

    const instruction = [
      "You are looking at a screenshot of a user's own computer screen, captured by an authorized personal automation assistant that the user explicitly permitted to see it.",
      'Respond with ONLY valid JSON — no markdown code fences, no commentary before or after — matching exactly this shape:',
      '{"application": string|null, "window": string|null, "elements": [{"type": string, "label": string, "state": string|null, "approxRegion": string|null}], "summary": string}',
      '"elements" should list interactive or notable UI elements (buttons, text fields, links, menus, checkboxes) that you can actually see.',
      '"approxRegion" must be a rough qualitative location such as "top-left", "center", "bottom toolbar" — do NOT invent exact pixel coordinates; you cannot measure them reliably from a screenshot alone.',
      'If you are not confident about something, say so in "summary" rather than guessing silently.',
      question ? `Also specifically answer this question in "summary": ${question}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const messages = this._buildMessages(provider, instruction, base64, mimeType);
    const result = await provider.complete({ messages, maxTokens: 1024 });

    let parsed = null;
    let parseError = null;
    try {
      const cleaned = result.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
      parsed = JSON.parse(cleaned);
    } catch (err) {
      parseError = err.message;
    }

    const outcome = {
      provider: provider.name,
      raw: result.text,
      parsed,
      parseError,
      confidence: parsed ? 'model_reported' : 'unparsed_response',
    };

    this.activityLog?.log({
      type: 'vision_interpretation',
      detail: { provider: provider.name, parsed: Boolean(parsed), parseError },
    });

    return outcome;
  }
  async _jsonVision({ base64, mimeType = 'image/png', instruction, maxTokens = 800 } = {}) {
    if (!base64) throw new Error('VisionInterpreter: base64 screenshot data is required');
    const provider = this.providerRouter.selectVision();
    const messages = this._buildMessages(provider, instruction, base64, mimeType);
    const result = await provider.complete({ messages, maxTokens });
    let parsed = null, parseError = null;
    try {
      const cleaned = result.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
      parsed = JSON.parse(cleaned);
    } catch (err) { parseError = err.message; }
    return { provider: provider.name, parsed, parseError, raw: result.text };
  }

  async planScreenAction({ base64, mimeType = 'image/png', instruction } = {}) {
    return this._jsonVision({ base64, mimeType, maxTokens: 900, instruction: [
      'You are the visual controller for an authorized personal computer-use agent.',
      'Return ONLY JSON. Never guess invisible UI state.',
      'Choose exactly one action: click, type, scroll, done, abort.',
      'For click, x and y MUST be normalized screen coordinates from 0 to 1, and include screenWidth and screenHeight when visible or inferable from the image dimensions.',
      'For type, return the exact text that should be entered.',
      'For scroll, amount is an integer from -20 to 20.',
      'Use done only when the requested instruction is visibly complete. Use abort when it cannot be completed safely.',
      'Schema: {"action":"click|type|scroll|done|abort","x":0.0,"y":0.0,"screenWidth":1920,"screenHeight":1080,"button":"left","text":"","amount":1,"reason":""}',
      `User instruction: ${instruction}`,
    ].join('\n') });
  }

  async verifyScreenshot({ base64, mimeType = 'image/png', expectedOutcome } = {}) {
    return this._jsonVision({ base64, mimeType, maxTokens: 500, instruction: [
      'You are verifying the final state of an authorized computer-use action.',
      'Return ONLY JSON with {"verified":boolean,"reason":string}.',
      'verified=true only when the expected outcome is visibly supported by the screenshot. Do not infer hidden state.',
      `Expected outcome: ${expectedOutcome}`,
    ].join('\n') });
  }

}
