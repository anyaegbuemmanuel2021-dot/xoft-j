import { Tool, RiskLevel } from '../Tool.js';
import { GmailService } from '../../agents/email/GmailService.js';

const gmail = new GmailService();

export function buildEmailTools() {
  const configured = gmail.isConfigured();
  const status = configured ? 'IMPLEMENTED' : 'REQUIRES_API';

  return [
    new Tool({
      name: 'search_emails',
      description: 'Search Gmail using Gmail search syntax (e.g. "from:x is:unread", "subject:invoice").',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number' } }, required: ['query'] },
      riskLevel: RiskLevel.SAFE,
      status,
      execute: async ({ query, maxResults }) => {
        const results = await gmail.search(query, maxResults ?? 10);
        return { count: results.length, results };
      },
    }),

    new Tool({
      name: 'read_email',
      description: 'Fetch the full subject/from/date/body of one email by message id (from search_emails results).',
      inputSchema: { type: 'object', properties: { messageId: { type: 'string' } }, required: ['messageId'] },
      riskLevel: RiskLevel.SAFE,
      status,
      execute: async ({ messageId }) => gmail.getMessage(messageId),
    }),

    new Tool({
      name: 'send_email',
      description: "Send an email on the user's behalf.",
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
        required: ['to', 'subject', 'body'],
      },
      requiredPermissions: ['email.send'],
      riskLevel: RiskLevel.EXTERNAL,
      status,
      execute: async ({ to, subject, body }) => {
        const result = await gmail.send({ to, subject, body });
        return { sent: true, ...result };
      },
    }),
  ];
}
