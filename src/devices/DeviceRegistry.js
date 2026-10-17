import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventType } from '../events/EventBus.js';

/**
 * DeviceRegistry — spec section 57. Server-side identity/trust record for
 * each client (web session, or a future native companion app) that talks to
 * this backend. This is the data model and CRUD only — pairing a real phone
 * requires the companion app described in docs/MOBILE_COMPANION_CONTRACT.md
 * to actually call register()/heartbeat() against this API.
 */
export class DeviceRegistry {
  constructor({ activityLog, eventBus, dataDir = './data', store = null }) {
    this.activityLog = activityLog;
    this.eventBus = eventBus;
    this.store = store;
    this.filePath = path.join(dataDir, 'devices.json');
    if (!this.store) {
      fs.mkdirSync(dataDir, { recursive: true });
      if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, JSON.stringify({ devices: [] }, null, 2));
    }
  }

  _load() {
    if (this.store) return { devices: this.store.loadDevices() };
    return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
  }

  _save(data) {
    if (this.store) { for (const device of data.devices) this.store.saveDevice(device); return; }
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  register(name, platform = 'web') {
    const data = this._load();
    const device = {
      id: crypto.randomUUID(),
      name,
      platform, // 'web' | 'android' | 'ios' | 'desktop' | 'server'
      trust: 'unverified', // discovery != trust — see DeviceManager.trustDevice()
      status: 'connected',
      // What the connected agent has told us it can do — empty until the
      // agent reports capabilities via POST /api/devices/:id/capabilities.
      capabilities: [],
      state: {
        battery: null,
        charging: null,
        network: null,
        activeApplication: null,
        locked: null,
        cpu: null,
        memory: null,
      },
      registeredAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    data.devices.push(device);
    this._save(data);
    this.activityLog.log({ type: 'device_registered', detail: { deviceId: device.id, name, platform } });
    this.eventBus?.emitEvent(EventType.DEVICE_CONNECTED, { deviceId: device.id, name, platform });
    return device;
  }

  get(deviceId) {
    const device = this._load().devices.find((d) => d.id === deviceId);
    if (!device) throw new Error(`DeviceRegistry: no device '${deviceId}'`);
    return device;
  }

  /** Explicit human trust decision — never inferred, never automatic on discovery. */
  setTrust(deviceId, trust) {
    if (!['unverified', 'trusted'].includes(trust)) {
      throw new Error(`DeviceRegistry: invalid trust value '${trust}'`);
    }
    const data = this._load();
    const device = data.devices.find((d) => d.id === deviceId);
    if (!device) throw new Error(`DeviceRegistry: no device '${deviceId}'`);
    device.trust = trust;
    this._save(data);
    this.activityLog.log({ type: 'device_trust_updated', detail: { deviceId, trust } });
    return device;
  }

  setCapabilities(deviceId, capabilities) {
    const data = this._load();
    const device = data.devices.find((d) => d.id === deviceId);
    if (!device) throw new Error(`DeviceRegistry: no device '${deviceId}'`);
    device.capabilities = [...new Set(capabilities)];
    this._save(data);
    this.activityLog.log({ type: 'device_capabilities_updated', detail: { deviceId, capabilities: device.capabilities } });
    return device;
  }

  /** Merges reported state fields (battery, network, activeApplication, ...) — partial updates allowed. */
  updateState(deviceId, partialState) {
    const data = this._load();
    const device = data.devices.find((d) => d.id === deviceId);
    if (!device) throw new Error(`DeviceRegistry: no device '${deviceId}'`);
    device.state = { ...device.state, ...partialState };
    device.lastActiveAt = new Date().toISOString();
    this._save(data);
    return device;
  }

  /**
   * Finds an existing device by name, or registers a new one. Used for the
   * server's own "local" identity (TaskPlanner/RulesEngine/MonitorManager
   * execution context) so its id is stable across restarts instead of
   * minting a fresh device — and therefore a fresh, ungranted permission
   * set — every time the process starts.
   */
  getOrCreate(name, platform = 'server') {
    const existing = this._load().devices.find((d) => d.name === name);
    if (existing) return existing;
    return this.register(name, platform);
  }

  heartbeat(deviceId) {
    const data = this._load();
    const device = data.devices.find((d) => d.id === deviceId);
    if (!device) throw new Error(`DeviceRegistry: no device '${deviceId}'`);
    device.lastActiveAt = new Date().toISOString();
    device.status = 'connected';
    this._save(data);
    return device;
  }

  revoke(deviceId) {
    const data = this._load();
    const device = data.devices.find((d) => d.id === deviceId);
    if (!device) throw new Error(`DeviceRegistry: no device '${deviceId}'`);
    device.status = 'revoked';
    this._save(data);
    this.activityLog.log({ type: 'device_revoked', detail: { deviceId } });
    this.eventBus?.emitEvent(EventType.DEVICE_REVOKED, { deviceId });
    return device;
  }

  list() {
    return this._load().devices;
  }
}
