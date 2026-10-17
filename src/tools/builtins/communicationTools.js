import { Tool, RiskLevel } from '../Tool.js';

export function buildCommunicationTools({ whatsappService, twilioService } = {}) {
  const whatsappStatus = whatsappService?.isConfigured() ? 'IMPLEMENTED' : 'REQUIRES_API';
  const twilioStatus = twilioService?.isConfigured() ? 'IMPLEMENTED' : 'REQUIRES_API';
  return [
    new Tool({
      name: 'send_whatsapp_message',
      description: 'Send a text message through the official WhatsApp Cloud API.',
      inputSchema: { type: 'object', properties: { to: { type: 'string' }, message: { type: 'string' } }, required: ['to', 'message'] },
      requiredPermissions: ['whatsapp.send'],
      riskLevel: RiskLevel.EXTERNAL,
      status: whatsappStatus,
      execute: async (input) => whatsappService.sendText(input),
    }),
    new Tool({
      name: 'make_phone_call',
      description: 'Initiate a phone call through Twilio. The call enters XOFT voice webhooks for a live speech conversation when configured.',
      inputSchema: { type: 'object', properties: { to: { type: 'string' }, contact: { type: 'string' }, purpose: { type: 'string' } }, required: ['to'] },
      requiredPermissions: ['calls.initiate'],
      riskLevel: RiskLevel.EXTERNAL,
      status: twilioStatus,
      execute: async ({ to }) => twilioService.createCall({ to }),
    }),
  ];
}
