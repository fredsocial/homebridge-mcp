const { normalizeConfig } = require('./config');
const { AccessoryCacheAdapter } = require('./accessory-cache-adapter');
const { LiveHapAdapter } = require('./live-hap-adapter');
const { DeviceRegistry } = require('./registry');
const { McpServer } = require('./mcp-server');

function accessoryCacheDirectory(api) {
  if (api?.user && typeof api.user.storagePath === 'function') {
    return require('node:path').join(api.user.storagePath(), 'accessories');
  }
  return '/homebridge/accessories';
}

class HomebridgeMcpPlatform {
  constructor(log, config, api) {
    this.log = (message) => log(`[Homebridge MCP] ${message}`);
    this.config = normalizeConfig(config);
    const storagePath = api?.user && typeof api.user.storagePath === 'function' ? api.user.storagePath() : '/homebridge';
    const cacheAdapter = new AccessoryCacheAdapter(accessoryCacheDirectory(api), this.log);
    const liveAdapter = new LiveHapAdapter({ storagePath, log: this.log, cameraPin: this.config.cameraPin });
    // The live adapter uses Homebridge's local HAP discovery and is always read-only.
    // The persisted cache remains available when local HAP discovery is unavailable.
    this.adapter = config.adapter || {
      async listDevices() {
        try {
          const liveDevices = await liveAdapter.listDevices();
          if (liveDevices.length) return liveDevices;
          return cacheAdapter.listDevices();
        } catch (error) {
          this.log?.(`Live accessory discovery unavailable: ${error.message}`);
          return cacheAdapter.listDevices();
        }
      },
      perform: (...args) => liveAdapter.perform(...args),
      getCameraSnapshot: (...args) => liveAdapter.getCameraSnapshot(...args),
      log: this.log,
    };
    this.registry = new DeviceRegistry(this.adapter, this.config, this.log);
    this.server = new McpServer(this.config, this.registry, this.log);
    if (!this.config.enabled) return;
    api.on('didFinishLaunching', () => this.server.start().then(() => this.log(`Listening on ${this.config.bind}:${this.config.port}${this.config.path}`)).catch((e) => this.log(`Failed to start MCP server: ${e.message}`)));
    api.on('shutdown', () => this.server.stop());
  }
}

module.exports = (api) => { api.registerPlatform('homebridge-mcp', 'HomebridgeMCP', HomebridgeMcpPlatform); };
module.exports.HomebridgeMcpPlatform = HomebridgeMcpPlatform;
module.exports.accessoryCacheDirectory = accessoryCacheDirectory;
