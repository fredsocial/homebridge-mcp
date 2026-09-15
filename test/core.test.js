const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AccessoryCacheAdapter } = require('../src/accessory-cache-adapter');
const { LiveHapAdapter, bridgePinForPort, hapHeaders, normalizeAccessory } = require('../src/live-hap-adapter');
const { normalizeConfig } = require('../src/config');
const { normalizeDevice } = require('../src/registry');
const { McpServer } = require('../src/mcp-server');

test('normalizes secure defaults and generates a token', () => {
  const config = normalizeConfig({});
  assert.equal(config.bind, '127.0.0.1');
  assert.equal(config.path, '/mcp');
  assert.equal(config.token.length >= 16, true);
  assert.equal(config.permissions.locks, false);
});

test('normalizes stable device shape', () => {
  assert.deepEqual(normalizeDevice({ name: 'Living Room Lamp', room: 'Living Room', type: 'light', state: { on: true } }), {
    id: 'living-room-living-room-lamp', name: 'Living Room Lamp', room: 'Living Room', type: 'light', reachable: null, state: { on: true }, capabilities: ['on'],
  });
});

test('lists devices and blocks writes in read-only mode', async () => {
  const registry = { list: async () => [{ id: 'lamp', name: 'Lamp' }], find: async () => ({ id: 'lamp', name: 'Lamp', type: 'light' }), call: async () => { throw new Error('blocked'); } };
  const server = new McpServer(normalizeConfig({ readOnly: true }), registry);
  const listed = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'home_list_devices', arguments: {} } });
  assert.equal(listed.result.structuredContent[0].id, 'lamp');
  const blocked = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'home_turn_on', arguments: { device: 'lamp' } } });
  assert.equal(blocked.result.isError, true);
});

test('negotiates supported MCP protocol versions during initialization', async () => {
  const server = new McpServer(normalizeConfig({}), { list: async () => [], find: async () => null, call: async () => null });
  const initialized = await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25' },
  });
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
});

test('advertises tools through modern server discovery', async () => {
  const server = new McpServer(normalizeConfig({}), { list: async () => [], find: async () => null, call: async () => null });
  const discovery = await server.handle({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
  assert.equal(discovery.result.resultType, 'complete');
  assert.equal(discovery.result.capabilities.tools !== undefined, true);
  assert.equal(discovery.result.supportedVersions.includes('2026-07-28'), true);
});

test('returns a camera image through the existing get-device tool', async () => {
  const server = new McpServer(normalizeConfig({}), {
    list: async () => [],
    find: async () => ({ id: 'camera', name: 'Backyard 0F09', type: 'camera' }),
    cameraSnapshot: async () => ({
      device: 'camera', name: 'Backyard 0F09', mimeType: 'image/jpeg', data: Buffer.from('jpeg'),
    }),
    call: async () => null,
  });
  const response = await server.handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'home_get_device', arguments: { device: 'Backyard 0F09' } },
  });
  assert.equal(response.result.content[0].type, 'image');
  assert.equal(response.result.content[0].mimeType, 'image/jpeg');
  assert.equal(response.result.structuredContent.name, 'Backyard 0F09');
});

test('publishes camera dimensions on the default get-device tool', async () => {
  const server = new McpServer(normalizeConfig({}), { list: async () => [], find: async () => null, call: async () => null });
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tool = response.result.tools.find((entry) => entry.name === 'home_get_device');
  assert.match(tool.description, /snapshot as an image attachment by default/);
  assert.deepEqual(tool.inputSchema.properties.width, { type: 'integer', minimum: 160, maximum: 1920 });
  assert.deepEqual(tool.inputSchema.properties.height, { type: 'integer', minimum: 120, maximum: 1080 });
});

// Strict MCP clients reject the whole tools/list response when any inputSchema
// omits the required "object" type, which silently disables every tool.
test('declares an object inputSchema for every listed tool', async () => {
  const server = new McpServer(normalizeConfig({}), { list: async () => [], find: async () => null, call: async () => null });
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.ok(response.result.tools.length > 0);
  for (const tool of response.result.tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} must declare an object inputSchema`);
    assert.equal(typeof tool.inputSchema.properties, 'object', `${tool.name} must declare inputSchema properties`);
  }
});

test('includes resultType on every result for protocol 2026-07-28 clients', async () => {
  const server = new McpServer(normalizeConfig({}), {
    list: async () => [],
    find: async () => { throw new Error('No device matches.'); },
    call: async () => null,
  });
  const responses = [
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28' } }),
    await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'home_list_devices', arguments: {} } }),
    await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'home_get_device', arguments: { device: 'missing' } } }),
  ];
  for (const response of responses) assert.equal(response.result.resultType, 'complete', `id ${response.id} is missing resultType`);
  assert.equal(responses[3].result.isError, true);
});

test('marks tools/list as a cacheable result for protocol 2026-07-28 clients', async () => {
  const server = new McpServer(normalizeConfig({}), { list: async () => [], find: async () => null, call: async () => null });
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(typeof response.result.ttlMs, 'number');
  assert.ok(response.result.ttlMs >= 0);
  assert.ok(['public', 'private'].includes(response.result.cacheScope));
});

test('returns home_get_camera_snapshot as an MCP image content block', async () => {
  const server = new McpServer(normalizeConfig({}), {
    list: async () => [],
    find: async () => ({ id: 'camera', name: 'Backyard 0F09', type: 'camera' }),
    cameraSnapshot: async () => ({
      device: 'camera', name: 'Backyard 0F09', mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff]),
    }),
    call: async () => null,
  });
  const response = await server.handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'home_get_camera_snapshot', arguments: { device: 'Backyard 0F09' } },
  });
  assert.deepEqual(response.result.content[0], {
    type: 'image', data: '/9j/', mimeType: 'image/jpeg',
  });
  assert.equal(response.result.structuredContent.name, 'Backyard 0F09');
});

test('discovers read-only devices from Homebridge accessory cache', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homebridge-mcp-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'cachedAccessories.0123456789AB'), JSON.stringify([{
    displayName: 'Living Room', UUID: 'accessory-id', services: [
      { displayName: 'Living Room Lamp', UUID: 'lamp-service', constructorName: 'Lightbulb', characteristics: [
        { constructorName: 'On', value: true }, { constructorName: 'Brightness', value: 65 },
      ] },
      { displayName: 'Accessory Information', UUID: 'info-service', constructorName: 'AccessoryInformation', characteristics: [] },
    ],
  }]));
  const adapter = new AccessoryCacheAdapter(directory);
  assert.deepEqual(await adapter.listDevices(), [{
    id: 'homebridge-accessory-id', name: 'Living Room', type: 'light', reachable: null,
    state: { on: true, brightness: 65 }, capabilities: ['on', 'brightness'],
  }]);
  await assert.rejects(adapter.perform(), /read-only/);
});

test('refreshes configured loopback HAP services and writes only mapped writable characteristics', async () => {
  const requestedPorts = [];
  const writes = [];
  const adapter = new LiveHapAdapter({
    storagePath: '/unused',
    readConfig: async () => ({ bridge: { port: 51826 }, platforms: [{ _bridge: { port: 51827 } }], accessories: [] }),
    discoverPorts: async () => [],
    request: async (port) => {
      requestedPorts.push(port);
      if (port === 51827) return [];
      return [{ aid: 1, services: [{ iid: 10, type: '00000043-0000-1000-8000-0026BB765291', characteristics: [
        { iid: 11, type: '00000023-0000-1000-8000-0026BB765291', perms: ['pr'], value: 'Live Lamp' },
        { iid: 12, type: '00000025-0000-1000-8000-0026BB765291', perms: ['pr', 'pw'], value: true },
        { iid: 13, type: '00000008-0000-1000-8000-0026BB765291', perms: ['pr'], value: 40 },
      ] }] }];
    },
    requestValues: async (_port, ids) => new Map(ids.map((id) => [id, id.endsWith('.11') ? 'Live Lamp' : (id.endsWith('.12') ? true : 40)])),
    writeValues: async (port, values) => writes.push({ port, values }),
  });
  assert.deepEqual(await adapter.listDevices(), [{
    id: 'homebridge-live-51826-1', name: 'Live Lamp', type: 'light', reachable: null,
    state: { on: true, brightness: 40 }, capabilities: ['on', 'brightness'],
  }]);
  assert.deepEqual(requestedPorts, [51826, 51827]);
  assert.deepEqual(await adapter.perform('homebridge-live-51826-1', 'turn_off'), { ok: true, device: 'homebridge-live-51826-1', action: 'turn_off' });
  assert.deepEqual(writes, [{ port: 51826, values: [{ aid: 1, iid: 12, value: false }] }]);
  await assert.rejects(adapter.perform('homebridge-live-51826-1', 'set_temperature', 22), /not supported/);
});

test('uses the Homebridge bridge PIN as the HAP authorization header', () => {
  const config = {
    bridge: { port: 51826, pin: '758-63-669' },
    platforms: [{ _bridge: { port: 51827 } }],
    accessories: [],
  };
  assert.equal(bridgePinForPort(config, 51826), '758-63-669');
  assert.equal(bridgePinForPort(config, 51827), '758-63-669');
  assert.deepEqual(hapHeaders(bridgePinForPort(config, 51826), 'application/hap+json', 12), {
    authorization: '758-63-669',
    'content-type': 'application/hap+json',
    'content-length': 12,
  });
});

test('normalizes a HomeKit camera service as a read-only snapshot device', () => {
  const devices = normalizeAccessory({
    aid: 7,
    services: [
      { type: '00000110-0000-1000-8000-0026BB765291', characteristics: [] },
      { type: '0000003E-0000-1000-8000-0026BB765291', characteristics: [
        { iid: 2, type: '00000023-0000-1000-8000-0026BB765291', perms: ['pr'] },
      ] },
    ],
  }, 51826, new Map([['7.2', 'Backyard Camera']]));
  assert.deepEqual(devices, [{
    id: 'homebridge-live-51826-7', name: 'Backyard Camera', type: 'camera', reachable: null,
    state: {}, capabilities: ['snapshot'], controls: {}, camera: { aid: 7 },
  }]);
});
