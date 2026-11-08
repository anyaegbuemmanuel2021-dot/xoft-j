import test from 'node:test';
import assert from 'node:assert/strict';
import { ComputerUseEngine } from '../src/devices/ComputerUseEngine.js';

const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('ComputerUseEngine performs bounded observe-act-verify', async () => {
  const calls = [];
  const deviceManager = {
    async execute(req) {
      calls.push(req);
      if (req.action === 'capture') return { success: true, result: { base64: png1x1, mimeType: 'image/png' } };
      return { success: true, result: { verification: { verified: true } } };
    },
  };
  let n = 0;
  const vision = {
    async planScreenAction() {
      n += 1;
      return n === 1
        ? { parsed: { action: 'click', x: 0.5, y: 0.5, screenWidth: 100, screenHeight: 80 } }
        : { parsed: { action: 'done' } };
    },
    async verifyScreenshot() { return { parsed: { verified: true, reason: 'visible' } }; },
  };
  const engine = new ComputerUseEngine({ deviceManager, visionInterpreter: vision });
  const result = await engine.run({ deviceId: 'pc', instruction: 'click the button', expectedOutcome: 'button is selected', maxActions: 2 });
  assert.equal(result.success, true);
  assert.equal(result.actions.length, 1);
  assert.equal(calls.filter(c => c.action === 'click')[0].parameters.x, 50);
  assert.equal(calls.filter(c => c.action === 'click')[0].parameters.y, 40);
  assert.equal(calls.filter(c => c.action === 'capture').length, 2);
});

test('ComputerUseEngine refuses unbounded/invalid coordinates', async () => {
  const deviceManager = { async execute(req) { if (req.action === 'capture') return { success: true, result: { base64: png1x1, mimeType: 'image/png' } }; return { success: true }; } };
  const vision = { async planScreenAction() { return { parsed: { action: 'click', x: 2, y: .5 } }; } };
  const engine = new ComputerUseEngine({ deviceManager, visionInterpreter: vision });
  await assert.rejects(() => engine.run({ deviceId: 'pc', instruction: 'do it', maxActions: 12 }), /normalized 0\.\.1/);
});
