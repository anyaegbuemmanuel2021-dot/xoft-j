import { Tool, RiskLevel } from '../Tool.js';

export function buildConnectorTools({ connectorManager, permissionSystem, localDeviceId = 'local-server' } = {}) {
  if (!connectorManager) return [];
  return [
    new Tool({
      name: 'connector_list',
      description: 'List explicitly configured external connectors such as Canva or other MCP/HTTP services. Credentials are never exposed.',
      inputSchema: { type: 'object', properties: {} },
      riskLevel: RiskLevel.SAFE,
      status: 'IMPLEMENTED',
      execute: async () => ({ connectors: connectorManager.list() }),
    }),
    new Tool({
      name: 'connector_discover',
      description: 'Discover the tools exposed by one explicitly configured external connector.',
      inputSchema: { type: 'object', properties: { connectorId: { type: 'string' } }, required: ['connectorId'] },
      requiredPermissions: ['connectors.use'],
      riskLevel: RiskLevel.SAFE,
      status: 'IMPLEMENTED',
      execute: async ({ connectorId }) => connectorManager.discover(connectorId),
    }),
    new Tool({
      name: 'connector_call',
      description: 'Call a tool exposed by an explicitly configured external connector. Use connector_discover first when the tool name is unknown. External side effects require the connector risk/approval policy.',
      inputSchema: {
        type: 'object',
        properties: {
          connectorId: { type: 'string' },
          tool: { type: 'string' },
          input: { type: 'object' },
        },
        required: ['connectorId', 'tool'],
      },
      requiredPermissions: ['connectors.use'],
      riskLevel: RiskLevel.EXTERNAL,
      status: 'IMPLEMENTED',
      execute: async ({ connectorId, tool, input = {} }) => connectorManager.call(connectorId, { tool, input }),
    }),
    new Tool({
      name: 'ai_background_task',
      description: 'Use a configured AI provider in the background. Can optionally capture an authorized device screen first and send that image to OpenAI or Claude for analysis. This is provider access, not access to a consumer ChatGPT/Claude account UI.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['auto', 'openai', 'claude'] },
          prompt: { type: 'string', maxLength: 12000 },
          deviceId: { type: 'string', description: 'Optional device to capture before asking the model.' },
        },
        required: ['prompt'],
      },
      requiredPermissions: ['ai.background'],
      riskLevel: RiskLevel.SAFE,
      status: 'IMPLEMENTED',
      execute: async ({ provider = 'auto', prompt, deviceId }, ctx) => {
        if (!ctx.providerRouter) throw new Error('ai_background_task: providerRouter is unavailable');
        let selected = provider === 'auto' ? ctx.providerRouter.selectVision() : ctx.providerRouter.getProvider(provider);
        let messages = [{ role: 'user', content: prompt }];
        if (deviceId) {
          if (!ctx.deviceManager) throw new Error('ai_background_task: deviceManager is unavailable');
          const capture = await ctx.deviceManager.execute({ deviceId, capability: 'screen', action: 'capture', riskLevel: 1 });
          if (!capture?.success || !capture?.result?.base64) throw new Error('ai_background_task: device screen capture failed or returned no image');
          const mimeType = capture.result.mimeType ?? 'image/png';
          const image = provider === 'claude' || selected.name === 'claude'
            ? { type: 'image', source: { type: 'base64', media_type: mimeType, data: capture.result.base64 } }
            : { type: 'image_url', image_url: { url: `data:${mimeType};base64,${capture.result.base64}` } };
          messages = [{ role: 'user', content: [{ type: 'text', text: prompt }, image] }];
        }
        const result = await selected.complete({ messages, maxTokens: 2048 });
        return { provider: selected.name, text: result.text, usage: result.usage };
      },
    }),
  ];
}
