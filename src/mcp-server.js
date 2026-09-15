const http = require('node:http');
const { isAuthorized } = require('./auth');
const { CloudflareAccessValidator } = require('./cloudflare-access');
const { version } = require('../package.json');

const TOOLS = [
  ['home_list_devices', 'List normalized Homebridge devices.', { type: 'object', properties: {} }],
  ['home_get_device', 'Get one device by stable ID or exact name. For cameras, return a current snapshot as an image attachment by default.', { type: 'object', properties: { device: { type: 'string' }, width: { type: 'integer', minimum: 160, maximum: 1920 }, height: { type: 'integer', minimum: 120, maximum: 1080 } }, required: ['device'] }],
  ['home_turn_on', 'Turn on a supported device.', { type: 'object', properties: { device: { type: 'string' } }, required: ['device'] }],
  ['home_turn_off', 'Turn off a supported device.', { type: 'object', properties: { device: { type: 'string' } }, required: ['device'] }],
  ['home_set_brightness', 'Set brightness from 0 to 100.', { type: 'object', properties: { device: { type: 'string' }, brightness: { type: 'number', minimum: 0, maximum: 100 } }, required: ['device', 'brightness'] }],
  ['home_set_temperature', 'Set a thermostat target temperature.', { type: 'object', properties: { device: { type: 'string' }, temperature: { type: 'number', minimum: 5, maximum: 35 } }, required: ['device', 'temperature'] }],
  ['home_get_camera_snapshot', 'Get a read-only snapshot from a Homebridge camera.', { type: 'object', properties: { device: { type: 'string' }, width: { type: 'integer', minimum: 160, maximum: 1920 }, height: { type: 'integer', minimum: 120, maximum: 1080 } }, required: ['device'] }],
];
const WRITE_TOOLS = new Set(['home_turn_on', 'home_turn_off', 'home_set_brightness', 'home_set_temperature']);
const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool[0], tool]));
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28']);
const DISCOVERABLE_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const DEFAULT_PROTOCOL_VERSION = '2025-11-25';

function json(res, status, body, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(body));
}

// Protocol revision 2026-07-28 requires resultType on every result; earlier
// clients ignore the extra field.
function result(id, value) {
  return { jsonrpc: '2.0', id, result: { resultType: 'complete', ...value } };
}

function toolResult(id, value) {
  return result(id, { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value });
}

function cameraToolResult(id, snapshot) {
  return result(id, {
    content: [
      { type: 'image', data: snapshot.data.toString('base64'), mimeType: snapshot.mimeType },
      { type: 'text', text: JSON.stringify({ device: snapshot.device, name: snapshot.name, mimeType: snapshot.mimeType }) },
    ],
    structuredContent: { device: snapshot.device, name: snapshot.name, mimeType: snapshot.mimeType },
  });
}

function error(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolError(id, message, meta = null) {
  const response = {
    jsonrpc: '2.0',
    id,
    result: {
      resultType: 'complete',
      content: [{ type: 'text', text: message }],
      isError: true,
    },
  };
  if (meta) response.result._meta = meta;
  return response;
}

function readJsonBody(request, maximumLength = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > maximumLength) request.destroy();
    });
    request.on('error', reject);
    request.on('end', () => {
      if (body.length > maximumLength) return reject(new Error('Request body is too large.'));
      resolve(body);
    });
  });
}

function listedTools(config) {
  return TOOLS
    .filter(([name]) => !config.readOnly || !WRITE_TOOLS.has(name))
    .map(([name, description, inputSchema]) => {
      const tool = {
        name,
        description,
        inputSchema,
        annotations: { readOnlyHint: !WRITE_TOOLS.has(name) },
      };
      return tool;
    });
}

class McpServer {
  constructor(config, registry, log = () => {}, options = {}) {
    this.config = config;
    this.registry = registry;
    this.log = log;
    this.server = null;
    this.cloudflareAccess = new CloudflareAccessValidator(config, this.log, options.cloudflareJwksFetcher);
  }

  async handle(message) {
    const { id = null, method, params = {} } = message || {};
    if (method === 'server/discover') {
      return result(id, {
        resultType: 'complete',
        supportedVersions: DISCOVERABLE_PROTOCOL_VERSIONS,
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'homebridge-mcp', version } },
        instructions: 'Use home_list_devices to discover Homebridge devices before requesting a device action.',
        ttlMs: 3600000,
        cacheScope: 'public',
      });
    }
    if (method === 'initialize') {
      const requestedProtocolVersion = params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedProtocolVersion) ? requestedProtocolVersion : DEFAULT_PROTOCOL_VERSION;
      return result(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'homebridge-mcp', version } });
    }
    if (method === 'notifications/initialized') return null;
    // Revision 2026-07-28 makes tools/list cacheable. A zero TTL keeps clients from
    // serving a stale tool surface after a restart; private because it is served
    // only behind authorization.
    if (method === 'tools/list') return result(id, { tools: listedTools(this.config), ttlMs: 0, cacheScope: 'private' });
    if (method !== 'tools/call') return error(id, -32601, `Unsupported MCP method: ${method}`);

    const name = params.name;
    const args = params.arguments || {};
    if (!TOOL_BY_NAME.has(name)) return error(id, -32602, `Unknown tool: ${name}`);
    try {
      if (name === 'home_list_devices') return toolResult(id, await this.registry.list());
      if (name === 'home_get_device') {
        const device = await this.registry.find(args.device);
        // Keep camera snapshots reachable through the already-published tool
        // schema so clients with a cached tools/list can still use the device.
        if (device.type === 'camera' && typeof this.registry.cameraSnapshot === 'function') {
          return cameraToolResult(id, await this.registry.cameraSnapshot(args.device, {
            width: args.width,
            height: args.height,
          }));
        }
        return toolResult(id, device);
      }
      if (name === 'home_get_camera_snapshot') return cameraToolResult(id, await this.registry.cameraSnapshot(args.device, { width: args.width, height: args.height }));
      const actions = {
        home_turn_on: ['turn_on'],
        home_turn_off: ['turn_off'],
        home_set_brightness: ['set_brightness', args.brightness],
        home_set_temperature: ['set_temperature', args.temperature],
      };
      return toolResult(id, await this.registry.call(args.device, actions[name][0], actions[name][1]));
    } catch (errorValue) {
      return toolError(id, errorValue.message);
    }
  }

  async authorize(request) {
    if (isAuthorized(request, this.config.token)) return { source: 'token' };
    const cloudflareAccess = await this.cloudflareAccess.validate(request);
    if (cloudflareAccess) return cloudflareAccess;
    return null;
  }

  unauthorized(response) {
    json(response, 401, { error: 'Unauthorized' }, { 'www-authenticate': 'Bearer' });
  }

  async route(request, response) {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== this.config.path) return json(response, 404, { error: 'Not found' });
    const authorization = await this.authorize(request);
    if (!authorization) return this.unauthorized(response);
    if (request.method !== 'POST') return json(response, 405, { error: 'POST required' }, { allow: 'POST' });
    try {
      const message = JSON.parse(await readJsonBody(request));
      const responseMessage = await this.handle(message, authorization);
      this.log(`MCP request completed: ${typeof message.method === 'string' ? message.method : 'unknown method'}.`);
      if (responseMessage) json(response, 200, responseMessage);
      else response.writeHead(202).end();
    } catch {
      this.log('MCP request rejected: invalid JSON-RPC request.');
      json(response, 400, { error: 'Invalid JSON-RPC request' });
    }
  }

  start() {
    if (this.server) return Promise.resolve();
    if (this.config.cloudflareAccess.enabled && this.config.cloudflareAccess.error) return Promise.reject(new Error(`Cloudflare Access configuration error: ${this.config.cloudflareAccess.error}`));
    this.server = http.createServer((request, response) => {
      this.route(request, response).catch(() => {
        if (!response.headersSent) json(response, 500, { error: 'Internal server error' });
        else response.end();
      });
    });
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.bind, resolve);
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }
}

module.exports = { DEFAULT_PROTOCOL_VERSION, DISCOVERABLE_PROTOCOL_VERSIONS, McpServer, SUPPORTED_PROTOCOL_VERSIONS, TOOLS, WRITE_TOOLS, listedTools };
