/**
 * ComputerUseEngine — bounded observe/plan/act/verify loop.
 * It never executes arbitrary shell commands. Every physical action is one of
 * the existing screen primitives and every action is followed by observation.
 */
export class ComputerUseEngine {
  constructor({ deviceManager, visionInterpreter, activityLog } = {}) {
    if (!deviceManager) throw new Error('ComputerUseEngine requires deviceManager');
    if (!visionInterpreter) throw new Error('ComputerUseEngine requires visionInterpreter');
    this.deviceManager = deviceManager;
    this.vision = visionInterpreter;
    this.activityLog = activityLog;
  }

  async _capture(deviceId) {
    const r = await this.deviceManager.execute({
      deviceId, capability: 'screen', action: 'capture', riskLevel: 'low',
      requestedBy: 'computer-use',
    });
    if (!r?.success || !r?.result?.base64) {
      throw new Error(r?.error || 'ComputerUseEngine: device did not return a screenshot');
    }
    return r;
  }

  async run({ deviceId, instruction, expectedOutcome = null, maxActions = 6 } = {}) {
    if (!deviceId || !instruction?.trim()) throw new Error('deviceId and instruction are required');
    const budget = Math.max(1, Math.min(12, Number(maxActions) || 6));
    const actions = [];

    let capture = await this._capture(deviceId);
    let observation = await this.vision.planScreenAction({
      base64: capture.result.base64,
      mimeType: capture.result.mimeType,
      instruction,
    });

    for (let i = 0; i < budget; i += 1) {
      const plan = observation?.parsed;
      if (!plan) throw new Error(`ComputerUseEngine: vision returned no actionable plan${observation?.parseError ? ` (${observation.parseError})` : ''}`);
      if (plan.action === 'done') break;
      if (plan.action === 'abort') throw new Error(plan.reason || 'Computer-use vision aborted the task');

      const action = this._validateAction(plan, capture);
      let result;
      if (action.type === 'click') {
        result = await this.deviceManager.execute({ deviceId, capability: 'screen', action: 'click', parameters: { x: action.x, y: action.y, button: action.button }, riskLevel: 'low', requestedBy: 'computer-use' });
      } else if (action.type === 'type') {
        result = await this.deviceManager.execute({ deviceId, capability: 'screen', action: 'type', parameters: { text: action.text }, riskLevel: 'low', requestedBy: 'computer-use' });
      } else {
        result = await this.deviceManager.execute({ deviceId, capability: 'screen', action: 'scroll', parameters: { amount: action.amount }, riskLevel: 'low', requestedBy: 'computer-use' });
      }
      if (!result?.success) throw new Error(result?.error || `Computer-use action '${action.type}' failed`);
      actions.push({ step: i + 1, ...action });

      capture = await this._capture(deviceId);
      observation = await this.vision.planScreenAction({
        base64: capture.result.base64,
        mimeType: capture.result.mimeType,
        instruction,
      });

      this.activityLog?.log({ type: 'computer_use_step', detail: { deviceId, step: i + 1, action: action.type } });
      if (observation?.parsed?.action === 'done') break;
    }

    if (expectedOutcome) {
      const verification = await this.vision.verifyScreenshot({
        base64: capture.result.base64,
        mimeType: capture.result.mimeType,
        expectedOutcome,
      });
      if (!verification?.parsed?.verified) {
        throw new Error(`ComputerUseEngine: expected outcome was not verified${verification?.parsed?.reason ? `: ${verification.parsed.reason}` : ''}`);
      }
      return { success: true, actions, verification: verification.parsed };
    }

    return { success: true, actions, finalObservation: observation.parsed ?? null };
  }

  _pngDimensions(base64) {
    try {
      const b = Buffer.from(base64, 'base64');
      if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    } catch { return null; }
  }

  _validateAction(plan, capture) {
    const dimensions = this._pngDimensions(capture.result.base64);
    const width = Number(plan.screenWidth || capture.result.width || dimensions?.width);
    const height = Number(plan.screenHeight || capture.result.height || dimensions?.height);
    if (plan.action === 'click') {
      const nx = Number(plan.x), ny = Number(plan.y);
      if (![nx, ny].every(Number.isFinite) || nx < 0 || nx > 1 || ny < 0 || ny > 1) {
        throw new Error('ComputerUseEngine: click coordinates must be normalized 0..1');
      }
      if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error('ComputerUseEngine: vision must provide screen dimensions for a click');
      return { type: 'click', x: Math.round(nx * width), y: Math.round(ny * height), button: plan.button === 'right' ? 'right' : 'left' };
    }
    if (plan.action === 'type') {
      const text = String(plan.text ?? '');
      if (!text || text.length > 4000) throw new Error('ComputerUseEngine: invalid typing payload');
      return { type: 'type', text };
    }
    if (plan.action === 'scroll') {
      const amount = Math.trunc(Number(plan.amount));
      if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 20) throw new Error('ComputerUseEngine: scroll amount must be between -20 and 20');
      return { type: 'scroll', amount };
    }
    throw new Error(`ComputerUseEngine: unsupported vision action '${plan.action}'`);
  }
}
