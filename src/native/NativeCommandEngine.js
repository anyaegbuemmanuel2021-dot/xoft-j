/**
 * NativeCommandEngine — deterministic command handling for common operations.
 * Only explicit, unambiguous command grammar is executed. Unknown text is
 * delegated; arbitrary code is never evaluated by this engine.
 */
export class NativeCommandEngine {
  constructor({ toolRegistry, activityLog = null } = {}) {
    this.toolRegistry = toolRegistry;
    this.activityLog = activityLog;
  }

  parse(message) {
    const text = String(message ?? '').trim();
    if (!text) return null;
    if (/^(?:what(?:'s| is) the )?time(?: is it)?\??$/i.test(text)
      || /^what time is it\??$/i.test(text)
      || /^tell me the time\.?$/i.test(text)
      || /^what(?:'s| is) today(?:'s)? date\??$/i.test(text)
      || /^what is the date\??$/i.test(text)) {
      return { tool: 'get_current_time', input: {} };
    }
    const calculation = text.match(/^(?:calculate|compute|solve|what is|what's)\s+(.+?)\??$/i);
    if (calculation) {
      const expression = calculation[1].trim().replace(/,/g, '');
      if (/^[\d\s()+\-*\/.]+$/.test(expression) && /\d/.test(expression)) {
        return { tool: 'calculate', input: { expression } };
      }
    }
    return null;
  }

  async handle(message, context = {}) {
    const command = this.parse(message);
    if (!command) return null;
    if (!this.toolRegistry?.has(command.tool)) {
      return { action: 'native_command', reply: 'That built-in command is not available right now.', meta: { command: command.tool, success: false } };
    }
    try {
      const result = await this.toolRegistry.execute(command.tool, command.input, context);
      const reply = command.tool === 'calculate'
        ? String(result.result)
        : 'It is ' + result.formatted + ' (' + result.timezone + ').';
      this.activityLog?.log({ type: 'native_command_executed', detail: { command: command.tool, success: true } });
      return { action: 'native_command', reply, meta: { command: command.tool, result, success: true } };
    } catch (error) {
      this.activityLog?.log({ type: 'native_command_failed', detail: { command: command.tool, error: error.message } });
      return { action: 'native_command', reply: "I couldn't complete that built-in command: " + error.message, meta: { command: command.tool, success: false } };
    }
  }
}
