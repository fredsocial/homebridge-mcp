const TYPE_PERMISSION = {
  light: 'lights', switch: 'switches', outlet: 'switches', fan: 'fans',
  thermostat: 'thermostats', sensor: 'sensors', scene: 'scenes',
  lock: 'locks', garage_door: 'garageDoors', security_system: 'securitySystems',
};

function assertWriteAllowed(config, device, action) {
  if (config.readOnly) throw new Error('Write operations are disabled because read-only mode is enabled.');
  if (!config.writableDeviceIds.includes(device.id)) throw new Error(`Device '${device.id}' is read-only. Add its stable ID to writableDeviceIds to allow this action.`);
  const permission = TYPE_PERMISSION[device.type];
  if (!permission || config.permissions[permission] !== true) {
    throw new Error(`Action '${action}' is blocked by policy for device type '${device.type}'.`);
  }
}

module.exports = { assertWriteAllowed };
