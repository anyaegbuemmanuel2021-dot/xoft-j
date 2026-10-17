// Node 18+ has global fetch — no dependency needed.
class CoreClient {
  constructor(coreUrl, apiKey = null, deviceToken = null) {
    this.coreUrl = coreUrl;
    this.apiKey = apiKey;
    // A device token is scoped to this one device (xoft-core enforces that
    // server-side); the shared apiKey is the admin secret and can touch
    // everything. Prefer the narrower credential whenever both are set.
    this.deviceToken = deviceToken;
  }

  async _json(method, urlPath, body) {
    const headers = body ? { 'Content-Type': 'application/json' } : {};
    const credential = this.deviceToken ?? this.apiKey;
    if (credential) headers['X-API-Key'] = credential;
    const res = await fetch(`${this.coreUrl}${urlPath}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`xoft-core returned non-JSON (status ${res.status}) from ${urlPath}: ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      throw new Error(`xoft-core ${method} ${urlPath} -> ${res.status}: ${data.error ?? text}`);
    }
    return data;
  }

  getEmergencyStop() {
    return this._json('GET', '/api/emergency-stop');
  }

  registerDevice(name, platform = 'desktop') {
    return this._json('POST', '/api/devices', { name, platform });
  }

  getDevice(deviceId) {
    return this._json('GET', `/api/devices/${deviceId}`);
  }

  heartbeat(deviceId) {
    return this._json('POST', `/api/devices/${deviceId}/heartbeat`);
  }

  reportCapabilities(deviceId, capabilities) {
    return this._json('POST', `/api/devices/${deviceId}/capabilities`, { capabilities });
  }

  reportState(deviceId, state) {
    return this._json('POST', `/api/devices/${deviceId}/state`, { state });
  }

  pullPendingCommands(deviceId) {
    return this._json('GET', `/api/devices/${deviceId}/commands/pending`);
  }

  submitResult(deviceId, commandId, result) {
    return this._json('POST', `/api/devices/${deviceId}/commands/${commandId}/result`, result);
  }
}

module.exports = { CoreClient };
