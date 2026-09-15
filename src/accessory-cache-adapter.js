const fs = require('node:fs/promises');
const path = require('node:path');

const CHARACTERISTICS = Object.freeze({
  On: 'on',
  Brightness: 'brightness',
  CurrentTemperature: 'temperature_current',
  TargetTemperature: 'temperature_target',
  CurrentHeatingCoolingState: 'heating_cooling_state',
  TargetHeatingCoolingState: 'heating_cooling_target',
  RotationSpeed: 'fan_speed',
  ContactSensorState: 'contact_state',
  MotionDetected: 'motion_detected',
  OccupancyDetected: 'occupancy_detected',
  BatteryLevel: 'battery_level',
  StatusActive: 'active',
  StatusFault: 'fault',
  StatusLowBattery: 'low_battery',
  CurrentRelativeHumidity: 'humidity_current',
  CurrentAmbientLightLevel: 'ambient_light_level',
  OutletInUse: 'outlet_in_use',
});

function serviceType(name = '') {
  if (name === 'Lightbulb') return 'light';
  if (name === 'Switch' || name === 'Outlet') return 'switch';
  if (name === 'Fan' || name === 'Fanv2') return 'fan';
  if (name === 'Thermostat') return 'thermostat';
  if (name === 'LockMechanism') return 'lock';
  if (name === 'GarageDoorOpener') return 'garage_door';
  if (name === 'SecuritySystem') return 'security_system';
  return 'sensor';
}

function preferredType(current, candidate) {
  const priority = { thermostat: 6, light: 5, fan: 4, switch: 3, lock: 2, garage_door: 2, security_system: 2, sensor: 1 };
  return (priority[candidate] || 0) > (priority[current] || 0) ? candidate : current;
}

function normalizeAccessory(accessory) {
  const state = {};
  const capabilities = new Set();
  let type = 'sensor';
  let health = null;
  for (const service of accessory.services || []) {
    if (service.hiddenService || service.constructorName === 'AccessoryInformation') continue;
    type = preferredType(type, serviceType(service.constructorName));
    for (const characteristic of service.characteristics || []) {
      const capability = CHARACTERISTICS[characteristic.constructorName];
      if (!capability) continue;
      capabilities.add(capability);
      state[capability] = characteristic.value;
      if (capability === 'active') health = Boolean(characteristic.value);
      if (capability === 'fault' && characteristic.value === true) health = false;
    }
  }
  if (!capabilities.size) return null;
  return {
    id: `homebridge-${accessory.UUID}`,
    name: accessory.displayName || 'Unnamed device', type,
    reachable: health, state, capabilities: [...capabilities],
  };
}

class AccessoryCacheAdapter {
  constructor(cacheDirectory, log = () => {}) {
    this.cacheDirectory = cacheDirectory;
    this.log = log;
  }

  async listDevices() {
    let entries;
    try {
      entries = await fs.readdir(this.cacheDirectory, { withFileTypes: true });
    } catch (error) {
      this.log(`Accessory cache unavailable: ${error.code || error.message}`);
      return [];
    }
    const files = entries
      .filter((entry) => entry.isFile() && /^cachedAccessories\.[A-F0-9]+$/.test(entry.name))
      .map((entry) => entry.name);
    const devices = new Map();
    for (const file of files) {
      try {
        const cachedAccessories = JSON.parse(await fs.readFile(path.join(this.cacheDirectory, file), 'utf8'));
        if (!Array.isArray(cachedAccessories)) continue;
        for (const accessory of cachedAccessories) {
          const device = normalizeAccessory(accessory);
          if (device) devices.set(device.id, device);
        }
      } catch (error) {
        this.log(`Skipped unreadable accessory cache file ${file}: ${error.message}`);
      }
    }
    return [...devices.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async perform() {
    throw new Error('The Homebridge accessory-cache discovery backend is read-only.');
  }
}

module.exports = { AccessoryCacheAdapter, normalizeAccessory, preferredType, serviceType };
