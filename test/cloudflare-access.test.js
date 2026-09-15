const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConfig } = require('../src/config');
const { McpServer } = require('../src/mcp-server');

function signedAccessToken(privateKey, payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), privateKey).toString('base64url');
  return `${header}.${claims}.${signature}`;
}

test('Cloudflare Access JWT authorization validates signature, issuer, expiry, and audience', async (context) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config = normalizeConfig({
    bind: '127.0.0.1',
    port: 0,
    token: 'test-homebridge-token-that-is-long-enough',
    readOnly: true,
    cloudflareAccess: {
      enabled: true,
      teamDomain: 'https://home-team.cloudflareaccess.com',
      audience: 'home-mcp-audience',
    },
  });
  assert.equal(config.cloudflareAccess.error, null);
  const server = new McpServer(config, {
    list: async () => [{ id: 'lamp', name: 'Lamp' }],
    find: async () => null,
    call: async () => null,
  }, () => {}, {
    cloudflareJwksFetcher: async () => [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-key' }],
  });
  await server.start();
  context.after(() => server.stop());
  const baseUrl = `http://127.0.0.1:${server.server.address().port}`;
  const now = Math.floor(Date.now() / 1000);
  const token = signedAccessToken(privateKey, {
    iss: config.cloudflareAccess.teamDomain,
    aud: config.cloudflareAccess.audience,
    exp: now + 60,
    nbf: now - 1,
    email: 'owner@example.test',
  });
  const authorized = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(authorized.status, 200);

  const wrongAudience = signedAccessToken(privateKey, {
    iss: config.cloudflareAccess.teamDomain,
    aud: 'other-application',
    exp: now + 60,
  });
  const rejected = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'cf-access-jwt-assertion': wrongAudience, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  assert.equal(rejected.status, 401);
});

test('Cloudflare Access fails closed when its team domain or audience is incomplete', async () => {
  const config = normalizeConfig({ cloudflareAccess: { enabled: true, teamDomain: 'https://not-cloudflare.example.test' } });
  assert.match(config.cloudflareAccess.error, /teamDomain/);
  const server = new McpServer(config, { list: async () => [], find: async () => null, call: async () => null });
  await assert.rejects(server.start(), /Cloudflare Access configuration error/);
});
