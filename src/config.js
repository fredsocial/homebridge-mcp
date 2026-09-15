const crypto = require('node:crypto');

const DEFAULT_PERMISSIONS = Object.freeze({
  sensors: true, lights: true, switches: true, fans: true, thermostats: true,
  scenes: true, locks: false, garageDoors: false, securitySystems: false,
});
function createToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function normalizeCloudflareAccessConfig(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const cloudflareAccess = {
    enabled: value.enabled === true,
    teamDomain: '',
    audience: typeof value.audience === 'string' ? value.audience.trim() : '',
    certsUrl: '',
    error: null,
  };
  if (!cloudflareAccess.enabled) return cloudflareAccess;
  try {
    const teamUrl = new URL(typeof value.teamDomain === 'string' ? value.teamDomain.trim() : '');
    if (teamUrl.protocol !== 'https:' || teamUrl.username || teamUrl.password || teamUrl.pathname !== '/' || teamUrl.search || teamUrl.hash || !teamUrl.hostname.endsWith('.cloudflareaccess.com')) {
      throw new Error('Cloudflare Access teamDomain must be an HTTPS Cloudflare Access origin, for example https://your-team.cloudflareaccess.com.');
    }
    if (!cloudflareAccess.audience || cloudflareAccess.audience.length > 512) {
      throw new Error('Cloudflare Access audience is required and must be 512 characters or fewer.');
    }
    cloudflareAccess.teamDomain = teamUrl.origin;
    cloudflareAccess.certsUrl = `${teamUrl.origin}/cdn-cgi/access/certs`;
  } catch (error) {
    cloudflareAccess.error = error.message;
  }
  return cloudflareAccess;
}

function normalizeConfig(input = {}) {
  const bind = input.bind || '127.0.0.1';
  const path = input.path && input.path.startsWith('/') ? input.path : `/${input.path || 'mcp'}`;
  const cloudflareAccess = normalizeCloudflareAccessConfig(input.cloudflareAccess);
  return {
    name: input.name || 'Homebridge MCP', enabled: input.enabled !== false,
    bind, port: Number.isInteger(input.port) ? input.port : 8765, path,
    token: typeof input.token === 'string' && input.token.length >= 16 ? input.token : createToken(),
    cameraPin: typeof input.cameraPin === 'string' ? input.cameraPin.trim() : '',
    readOnly: input.readOnly === true,
    permissions: { ...DEFAULT_PERMISSIONS, ...(input.permissions || {}) },
    auditLogging: input.auditLogging !== false,
    writableDeviceIds: [...new Set((Array.isArray(input.writableDeviceIds) ? input.writableDeviceIds : String(input.writableDeviceIds || '').split(/[\n,]/)).map((id) => String(id).trim()).filter((id) => id.startsWith('homebridge-live-')))],
    cloudflareAccess,
  };
}

module.exports = { DEFAULT_PERMISSIONS, createToken, normalizeCloudflareAccessConfig, normalizeConfig };
