const { assertWriteAllowed } = require('./policy');

function slug(value) {
  return String(value).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function normalizeDevice(device) {
  const name = device.name || 'Unnamed device';
  return {
    id: device.id || slug(`${device.room || 'home'}-${name}`), name,
    room: device.room || null, type: device.type || 'unknown',
    reachable: typeof device.reachable === 'boolean' ? device.reachable : null, state: { ...(device.state || {}) },
    capabilities: [...new Set(device.capabilities || Object.keys(device.state || {}))],
  };
}

class DeviceRegistry {
  constructor(adapter, config, log = () => {}) { this.adapter = adapter; this.config = config; this.log = log; }
  async list() { return (await this.adapter.listDevices()).map(normalizeDevice); }
  async find(idOrName) {
    const devices = await this.list();
    const matches = devices.filter((d) => d.id === idOrName || d.name.toLowerCase() === String(idOrName).toLowerCase());
    if (!matches.length) throw new Error(`Device not found: ${idOrName}`);
    if (matches.length > 1) throw new Error(`Ambiguous device name '${idOrName}': ${matches.map((d) => `${d.id} (${d.room || 'unknown room'})`).join(', ')}`);
    return matches[0];
  }
  async call(idOrName, action, value) {
    const device = await this.find(idOrName);
    assertWriteAllowed(this.config, device, action);
    const result = await this.adapter.perform(device.id, action, value);
    if (this.config.auditLogging) this.log(`${action}: ${device.name} — success`);
    return result || { ok: true, device: device.id, action };
  }
  async cameraSnapshot(idOrName, options = {}) {
    const device = await this.find(idOrName);
    if (device.type !== 'camera' || typeof this.adapter.getCameraSnapshot !== 'function') {
      throw new Error(`Device '${device.name}' is not a camera with snapshot support.`);
    }
    const snapshot = await this.adapter.getCameraSnapshot(device.id, options);
    return { ...snapshot, device: device.id, name: device.name };
  }
}

module.exports = { DeviceRegistry, normalizeDevice, slug };
