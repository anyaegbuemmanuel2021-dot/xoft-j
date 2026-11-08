/**
 * ChannelGateway keeps channel adapters thin. Every inbound channel is
 * normalized to one request shape and dispatched to the same ExecutiveBrain.
 * The Core never needs to know whether a request came from web, WhatsApp,
 * telephony, or a future channel.
 */
export class ChannelGateway {
  constructor({ executiveBrain, activityLog, address } = {}) {
    this.address = address ?? null;
    if (!executiveBrain) throw new Error('ChannelGateway requires executiveBrain');
    this.executiveBrain = executiveBrain;
    this.activityLog = activityLog;
  }

  normalize({ channel, userId, sessionId, message, attachments = [], metadata = {} }) {
    if (!channel || !message) throw new Error('ChannelGateway: channel and message are required');
    return { channel, userId: userId ?? null, sessionId: sessionId ?? `${channel}:${userId ?? 'anonymous'}`, message: String(message), attachments, metadata };
  }

  async handle(request) {
    const normalized = this.normalize(request);
    this.address?.observe(normalized.userId, normalized.message);
    this.address?.bindSession(normalized.sessionId, normalized.userId);
    const result = await this.executiveBrain.handle(normalized.sessionId, normalized.message);
    this.activityLog?.log({ type: 'channel_request', detail: { channel: normalized.channel, userId: normalized.userId, sessionId: normalized.sessionId, action: result?.action ?? null } });
    return { ...result, channel: normalized.channel, sessionId: normalized.sessionId };
  }
}
