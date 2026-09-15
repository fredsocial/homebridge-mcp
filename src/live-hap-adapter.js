const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const CHARACTERISTICS = Object.freeze({
  '25': 'on', '8': 'brightness', '11': 'temperature_current', '35': 'temperature_target',
  F: 'heating_cooling_state', '33': 'heating_cooling_target', '29': 'fan_speed',
  '6A': 'contact_state', '22': 'motion_detected', '71': 'occupancy_detected',
  '68': 'battery_level', '75': 'active', '77': 'fault', '79': 'low_battery',
  '10': 'humidity_current', '6B': 'ambient_light_level', '26': 'outlet_in_use',
});
const SERVICE_TYPES = Object.freeze({
  '43': 'light', '49': 'switch', '47': 'switch', '40': 'fan', '4A': 'thermostat',
  '45': 'lock', '41': 'garage_door', '7E': 'security_system', '110': 'camera',
});

function hapType(value) {
  const match = String(value || '').toUpperCase().match(/^0+([0-9A-F]{2,3})-/);
  return match ? Number.parseInt(match[1], 16).toString(16).toUpperCase() : String(value || '').toUpperCase();
}

function configuredBridgePorts(config) {
  const ports = new Set();
  if (Number.isInteger(config?.bridge?.port)) ports.add(config.bridge.port);
  for (const block of [...(config?.platforms || []), ...(config?.accessories || [])]) {
    if (Number.isInteger(block?._bridge?.port)) ports.add(block._bridge.port);
  }
  return [...ports].filter((port) => port > 0 && port <= 65535);
}

function bridgePinForPort(config, port) {
  const blocks = [
    { bridge: config?.bridge },
    ...(config?.platforms || []).map((block) => ({ bridge: block?._bridge })),
    ...(config?.accessories || []).map((block) => ({ bridge: block?._bridge })),
  ];
  const exact = blocks.find(({ bridge }) => bridge?.port === port && typeof bridge.pin === 'string' && bridge.pin.trim());
  if (exact) return exact.bridge.pin.trim();
  const fallback = blocks.find(({ bridge }) => typeof bridge?.pin === 'string' && bridge.pin.trim());
  return fallback?.bridge.pin.trim() || null;
}

function hapHeaders(pin, contentType = null, contentLength = null) {
  const headers = {};
  if (pin) headers.authorization = pin;
  if (contentType) headers['content-type'] = contentType;
  if (contentLength !== null) headers['content-length'] = contentLength;
  return headers;
}

function requestAccessories(port, pin = null, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/accessories', timeout, headers: hapHeaders(pin) }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`HAP endpoint on port ${port} returned HTTP ${response.statusCode}.`));
        try { resolve(JSON.parse(body).accessories || []); } catch { reject(new Error(`HAP endpoint on port ${port} returned invalid JSON.`)); }
      });
    });
    request.on('timeout', () => request.destroy(new Error(`HAP endpoint on port ${port} timed out.`)));
    request.on('error', reject);
  });
}

async function discoverListeningPorts() {
  const ports = new Set();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      const lines = await fs.readFile(file, 'utf8');
      for (const line of lines.split('\n').slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields[3] !== '0A') continue;
        const port = Number.parseInt(fields[1]?.split(':')[1], 16);
        if (Number.isInteger(port) && port > 1024 && port <= 65535) ports.add(port);
      }
    } catch {
      // Non-Linux Homebridge hosts may not expose procfs; configured bridges still work.
    }
  }
  return [...ports];
}

function hasCameraService(accessories) {
  return accessories.some((accessory) => (accessory.services || []).some((service) => hapType(service.type) === '110'));
}

function requestCharacteristicValues(port, ids, pin = null) {
  if (!ids.length) return Promise.resolve(new Map());
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: `/characteristics?id=${ids.join(',')}`, timeout: 5000, headers: hapHeaders(pin) }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200 && response.statusCode !== 207) return reject(new Error(`HAP values on port ${port} returned HTTP ${response.statusCode}.`));
        try {
          const values = new Map();
          for (const characteristic of JSON.parse(body).characteristics || []) {
            if ((characteristic.status === undefined || characteristic.status === 0) && Object.hasOwn(characteristic, 'value')) values.set(`${characteristic.aid}.${characteristic.iid}`, characteristic.value);
          }
          resolve(values);
        } catch { reject(new Error(`HAP values on port ${port} returned invalid JSON.`)); }
      });
    });
    request.on('timeout', () => request.destroy(new Error(`HAP values on port ${port} timed out.`)));
    request.on('error', reject);
  });
}

function writeCharacteristicValues(port, characteristics, pin = null) {
  if (!characteristics.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ characteristics });
    const request = http.request({
      host: '127.0.0.1', port, path: '/characteristics', method: 'PUT', timeout: 5000,
      headers: hapHeaders(pin, 'application/hap+json', Buffer.byteLength(body)),
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 204 && response.statusCode !== 207) return reject(new Error(`HAP write on port ${port} returned HTTP ${response.statusCode}.`));
        if (!responseBody) return resolve();
        try {
          const failed = (JSON.parse(responseBody).characteristics || []).find((item) => item.status !== undefined && item.status !== 0);
          if (failed) return reject(new Error(`HAP write was rejected for characteristic ${failed.aid}.${failed.iid} (status ${failed.status}).`));
          resolve();
        } catch { reject(new Error(`HAP write on port ${port} returned invalid JSON.`)); }
      });
    });
    request.on('timeout', () => request.destroy(new Error(`HAP write on port ${port} timed out.`)));
    request.on('error', reject);
    request.end(body);
  });
}

function requestCameraSnapshot(port, aid, pin = null, { width = 1280, height = 720 } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ aid, 'resource-type': 'image', 'image-width': width, 'image-height': height });
    const request = http.request({
      host: '127.0.0.1', port, path: '/resource', method: 'POST', timeout: 15000,
      headers: hapHeaders(pin, 'application/hap+json', Buffer.byteLength(body)),
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 10 * 1024 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`HAP camera snapshot on port ${port} returned HTTP ${response.statusCode}.`));
        if (size > 10 * 1024 * 1024) return reject(new Error('HAP camera snapshot exceeded the 10 MB safety limit.'));
        const contentType = String(response.headers['content-type'] || 'image/jpeg').split(';', 1)[0].trim();
        if (!contentType.startsWith('image/')) return reject(new Error('HAP camera snapshot returned a non-image response.'));
        resolve({ data: Buffer.concat(chunks), mimeType: contentType });
      });
    });
    request.on('timeout', () => request.destroy(new Error(`HAP camera snapshot on port ${port} timed out.`)));
    request.on('error', reject);
    request.end(body);
  });
}

function readableCharacteristicIds(accessories) {
  const ids = [];
  for (const accessory of accessories) for (const service of accessory.services || []) for (const characteristic of service.characteristics || []) {
    if ((CHARACTERISTICS[hapType(characteristic.type)] || hapType(characteristic.type) === '23') && (characteristic.perms || []).includes('pr')) ids.push(`${accessory.aid}.${characteristic.iid}`);
  }
  return ids;
}

async function refreshCharacteristicValues(port, accessories, requestValues) {
  const values = new Map();
  const ids = readableCharacteristicIds(accessories);
  for (let index = 0; index < ids.length; index += 25) {
    for (const [id, value] of await requestValues(port, ids.slice(index, index + 25))) values.set(id, value);
  }
  return values;
}

function normalizeAccessory(accessory, port, values = new Map(), cachedNames = new Map()) {
  const state = {};
  const capabilities = new Set();
  const controls = {};
  let name = null;
  let type = 'sensor';
  let health = null;
  let camera = null;
  for (const service of accessory.services || []) {
    const serviceType = SERVICE_TYPES[hapType(service.type)] || 'sensor';
    const priority = { camera: 7, thermostat: 6, light: 5, fan: 4, switch: 3, lock: 2, garage_door: 2, security_system: 2, sensor: 1 };
    if ((priority[serviceType] || 0) > (priority[type] || 0)) type = serviceType;
    if (serviceType === 'camera') {
      camera = { aid: accessory.aid };
      capabilities.add('snapshot');
    }
    for (const characteristic of service.characteristics || []) {
      const type = hapType(characteristic.type);
      const id = `${accessory.aid}.${characteristic.iid}`;
      if (type === '23' && typeof values.get(id) === 'string' && !name) name = values.get(id);
      const capability = CHARACTERISTICS[type];
      if (!capability) continue;
      capabilities.add(capability);
      if ((characteristic.perms || []).includes('pw') && ['on', 'brightness', 'temperature_target'].includes(capability)) controls[capability] = { aid: accessory.aid, iid: characteristic.iid };
      if (values.has(id)) state[capability] = values.get(id);
      if (capability === 'active' && values.has(id)) health = Boolean(values.get(id));
      if (capability === 'fault' && values.get(id) === true) health = false;
    }
  }
  if (!capabilities.size) return [];
  return [{
    id: `homebridge-live-${port}-${accessory.aid}`,
    name: name || cachedNames.get(`${port}:${accessory.aid}`) || 'Unnamed device', type,
    reachable: health, state, capabilities: [...capabilities], controls, camera,
  }];
}

class LiveHapAdapter {
  constructor({ storagePath, log = () => {}, cameraPin = '', request = requestAccessories, requestValues = requestCharacteristicValues, writeValues = writeCharacteristicValues, snapshot = requestCameraSnapshot, discoverPorts = discoverListeningPorts, readConfig = null } = {}) {
    this.storagePath = storagePath;
    this.log = log;
    this.cameraPin = cameraPin;
    this.request = request;
    this.requestValues = requestValues;
    this.writeValues = writeValues;
    this.snapshot = snapshot;
    this.discoverPorts = discoverPorts;
    this.readConfig = readConfig || (() => fs.readFile(path.join(this.storagePath, 'config.json'), 'utf8').then(JSON.parse));
    this.controls = new Map();
    this.cameras = new Map();
    this.pins = new Map();
  }

  async loadCachedNames(config) {
    const namesByUuid = new Map();
    const accessoryDirectory = path.join(this.storagePath, 'accessories');
    try {
      const entries = await fs.readdir(accessoryDirectory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !/^cachedAccessories\.[A-F0-9]+$/.test(entry.name)) continue;
        const accessories = JSON.parse(await fs.readFile(path.join(accessoryDirectory, entry.name), 'utf8'));
        for (const accessory of accessories) if (accessory.UUID && accessory.displayName) namesByUuid.set(accessory.UUID, accessory.displayName);
      }
    } catch (error) {
      this.log(`Cached accessory names unavailable: ${error.code || error.message}`);
      return new Map();
    }
    const namesByPortAndAid = new Map();
    for (const block of [...(config.platforms || []), ...(config.accessories || [])]) {
      const port = block?._bridge?.port;
      const username = block?._bridge?.username;
      if (!Number.isInteger(port) || !username) continue;
      try {
        const identifierPath = path.join(this.storagePath, 'persist', `IdentifierCache.${String(username).replace(/:/g, '')}.json`);
        const identifiers = JSON.parse(await fs.readFile(identifierPath, 'utf8')).cache || {};
        for (const [uuid, name] of namesByUuid) {
          if (Number.isInteger(identifiers[uuid])) namesByPortAndAid.set(`${port}:${identifiers[uuid]}`, name);
        }
      } catch (error) {
        this.log(`Cached identifier map unavailable for live bridge port ${port}: ${error.code || error.message}`);
      }
    }
    return namesByPortAndAid;
  }

  async listDevices() {
    const config = await this.readConfig();
    const configuredPorts = configuredBridgePorts(config);
    if (!configuredPorts.length) throw new Error('No Homebridge bridge ports are configured for live discovery.');
    const configuredPortSet = new Set(configuredPorts);
    const candidatePorts = (await this.discoverPorts()).filter((port) => !configuredPortSet.has(port));
    for (const port of configuredPorts) this.pins.set(port, bridgePinForPort(config, port));
    const cachedNames = await this.loadCachedNames(config);
    const results = await Promise.allSettled(configuredPorts.map(async (port) => {
      const accessories = await this.request(port, this.pins.get(port));
      try {
        return {
          accessories,
          values: await refreshCharacteristicValues(
            port,
            accessories,
            (currentPort, ids) => this.requestValues(currentPort, ids, this.pins.get(currentPort)),
          ),
        };
      } catch (error) {
        this.log(`Live HAP value refresh on port ${port} unavailable: ${error.message}`);
        return { accessories, values: new Map() };
      }
    }));
    const externalResults = await Promise.all(candidatePorts.map(async (port) => {
      try {
        const accessories = await this.request(port, null, 250);
        return hasCameraService(accessories) ? { port, accessories } : null;
      } catch {
        return null;
      }
    }));
    const cameraPorts = externalResults.filter(Boolean);
    for (const { port } of cameraPorts) this.pins.set(port, this.cameraPin || null);
    const cameraResults = await Promise.all(cameraPorts.map(async ({ port, accessories }) => {
      try {
        return { port, accessories, values: await refreshCharacteristicValues(port, accessories, (currentPort, ids) => this.requestValues(currentPort, ids, this.pins.get(currentPort))) };
      } catch (error) {
        this.log(`Live HAP camera value refresh on port ${port} unavailable: ${error.message}`);
        return { port, accessories, values: new Map() };
      }
    }));
    const devices = new Map();
    const allResults = [
      ...results.map((result, index) => ({ result, port: configuredPorts[index] })),
      ...cameraResults.map((result) => ({ result: { status: 'fulfilled', value: result }, port: result.port })),
    ];
    allResults.forEach(({ result, port }) => {
      if (result.status === 'rejected') {
        this.log(`Live HAP endpoint on port ${port} unavailable: ${result.reason.message}`);
        return;
      }
      for (const accessory of result.value.accessories) {
        for (const device of normalizeAccessory(accessory, port, result.value.values, cachedNames)) {
          this.controls.set(device.id, device.controls);
          if (device.camera) this.cameras.set(device.id, { ...device.camera, port });
          const { controls, camera, ...publicDevice } = device;
          devices.set(publicDevice.id, publicDevice);
        }
      }
    });
    return [...devices.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async perform(deviceId, action, value) {
    const controls = this.controls.get(deviceId);
    if (!controls) throw new Error(`Live controls are unavailable for device '${deviceId}'. Refresh devices and try again.`);
    const capabilityByAction = { turn_on: 'on', turn_off: 'on', set_brightness: 'brightness', set_temperature: 'temperature_target' };
    const capability = capabilityByAction[action];
    const control = controls[capability];
    if (!control) throw new Error(`Action '${action}' is not supported by device '${deviceId}'.`);
    const port = Number(deviceId.split('-')[2]);
    if (!Number.isInteger(port)) throw new Error(`Device '${deviceId}' has an invalid live bridge port.`);
    const nextValue = action === 'turn_on' ? true : action === 'turn_off' ? false : value;
    if (!Number.isFinite(nextValue) && typeof nextValue !== 'boolean') throw new Error(`Action '${action}' requires a valid value.`);
    await this.writeValues(port, [{ ...control, value: nextValue }], this.pins.get(port));
    return { ok: true, device: deviceId, action };
  }

  async getCameraSnapshot(deviceId, options = {}) {
    const camera = this.cameras.get(deviceId);
    if (!camera) throw new Error(`Camera snapshots are unavailable for device '${deviceId}'. Refresh devices and try again.`);
    return this.snapshot(camera.port, camera.aid, this.pins.get(camera.port), options);
  }
}

module.exports = { bridgePinForPort, configuredBridgePorts, discoverListeningPorts, hapHeaders, hasCameraService, LiveHapAdapter, normalizeAccessory, requestAccessories, requestCameraSnapshot, requestCharacteristicValues, writeCharacteristicValues };
