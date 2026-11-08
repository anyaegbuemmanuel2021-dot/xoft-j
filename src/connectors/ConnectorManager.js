import crypto from 'node:crypto';

/**
 * ConnectorManager — controlled bridge to external app/service connectors.
 *
 * Supported transports:
 *  - http-json: POST {input} to a configured endpoint.
 *  - mcp-http: minimal MCP JSON-RPC bridge for remote MCP servers that expose
 *    initialize/tools/list/tools/call over HTTP.
 *
 * Credentials stay in server configuration and are never returned by list().
 * A connector is disabled unless explicitly configured. No connector is
 * guessed or silently substituted.
 */
export class ConnectorManager {
  constructor({ definitions = [], activityLog } = {}) {
    this.activityLog = activityLog;
    this.connectors = new Map();
    for (const definition of definitions) this.register(definition);
  }

  register(definition) {
    if (!definition?.id || !definition?.endpoint) throw new Error('ConnectorManager: id and endpoint are required');
    if (this.connectors.has(definition.id)) throw new Error(`ConnectorManager: duplicate connector '${definition.id}'`);
    const transport = definition.transport ?? 'http-json';
    if (!['http-json', 'mcp-http'].includes(transport)) throw new Error(`ConnectorManager: unsupported transport '${transport}'`);
    this.connectors.set(definition.id, {
      id: definition.id,
      name: definition.name ?? definition.id,
      endpoint: definition.endpoint,
      transport,
      enabled: definition.enabled !== false,
      headers: definition.headers ?? {},
      permissions: definition.permissions ?? ['connectors.use'],
      riskLevel: Number.isInteger(definition.riskLevel) ? definition.riskLevel : 2,
      description: definition.description ?? '',
      mcpSessionId: null,
    });
  }

  list() {
    return [...this.connectors.values()].map((c) => ({
      id: c.id, name: c.name, transport: c.transport, endpoint: c.endpoint,
      enabled: c.enabled, permissions: c.permissions, riskLevel: c.riskLevel,
      description: c.description,
    }));
  }

  get(id) {
    const c = this.connectors.get(id);
    if (!c) throw new Error(`ConnectorManager: unknown connector '${id}'`);
    if (!c.enabled) throw new Error(`ConnectorManager: connector '${id}' is disabled`);
    return c;
  }

  async _request(connector, body) {
    const headers = { 'content-type': 'application/json', ...connector.headers };
    const res = await fetch(connector.endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(`Connector '${connector.id}' HTTP ${res.status}: ${text.slice(0, 500)}`);
    return { data, headers: Object.fromEntries(res.headers.entries()) };
  }

  async call(id, { tool, input = {} } = {}) {
    const connector = this.get(id);
    if (!tool) throw new Error('ConnectorManager.call: tool is required');
    const callId = crypto.randomUUID();
    let result;

    if (connector.transport === 'http-json') {
      result = await this._request(connector, { action: 'call', tool, input, requestId: callId });
      result = result.data;
    } else {
      // MCP Streamable HTTP / JSON-RPC-compatible minimal flow.
      const init = await this._request(connector, {
        jsonrpc: '2.0', id: `${callId}:init`, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'xoft-core', version: '0.6.0' } },
      });
      const session = init.headers['mcp-session-id'];
      if (session) connector.mcpSessionId = session;
      const callHeaders = session ? { 'Mcp-Session-Id': session } : {};
      const res = await fetch(connector.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...connector.headers, ...callHeaders },
        body: JSON.stringify({ jsonrpc: '2.0', id: `${callId}:call`, method: 'tools/call', params: { name: tool, arguments: input } }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Connector '${id}' MCP HTTP ${res.status}: ${text.slice(0, 500)}`);
      try { result = JSON.parse(text); } catch { result = { raw: text }; }
      if (result.error) throw new Error(`Connector '${id}' MCP error: ${result.error.message ?? JSON.stringify(result.error)}`);
      result = result.result ?? result;
    }

    this.activityLog?.log({ type: 'connector_call', detail: { connectorId: id, tool, requestId: callId } });
    return { success: true, connectorId: id, tool, result };
  }

  async discover(id) {
    const connector = this.get(id);
    if (connector.transport === 'http-json') {
      const result = await this._request(connector, { action: 'list_tools' });
      return result.data;
    }
    const init = await this._request(connector, {
      jsonrpc: '2.0', id: crypto.randomUUID(), method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'xoft-core', version: '0.6.0' } },
    });
    const session = init.headers['mcp-session-id'];
    if (session) connector.mcpSessionId = session;
    const res = await fetch(connector.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', ...connector.headers, ...(session ? { 'Mcp-Session-Id': session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/list', params: {} }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Connector '${id}' MCP HTTP ${res.status}: ${text.slice(0, 500)}`);
    const data = JSON.parse(text);
    if (data.error) throw new Error(`Connector '${id}' MCP error: ${data.error.message ?? JSON.stringify(data.error)}`);
    return data.result ?? data;
  }
}
