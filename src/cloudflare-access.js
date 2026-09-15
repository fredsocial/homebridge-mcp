const crypto = require('node:crypto');

const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;
const JWKS_FETCH_TIMEOUT_MS = 5 * 1000;

function decodeJson(value) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

class CloudflareAccessValidator {
  constructor(config, log = () => {}, jwksFetcher = null) {
    this.config = config;
    this.log = log;
    this.jwksFetcher = jwksFetcher || this.fetchJwks.bind(this);
    this.cachedKeys = new Map();
    this.cacheExpiresAt = 0;
  }

  get enabled() {
    return this.config.cloudflareAccess.enabled === true && !this.config.cloudflareAccess.error;
  }

  async fetchJwks() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), JWKS_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(this.config.cloudflareAccess.certsUrl, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Cloudflare Access signing keys request failed.');
      const body = await response.json();
      if (!body || !Array.isArray(body.keys)) throw new Error('Cloudflare Access signing keys response was invalid.');
      return body.keys;
    } finally {
      clearTimeout(timeout);
    }
  }

  async keys(forceRefresh = false) {
    if (!forceRefresh && this.cacheExpiresAt > Date.now() && this.cachedKeys.size) return this.cachedKeys;
    const keys = await this.jwksFetcher();
    const next = new Map();
    for (const key of keys) {
      if (key && key.kty === 'RSA' && typeof key.kid === 'string') next.set(key.kid, key);
    }
    if (!next.size) throw new Error('Cloudflare Access signing keys response had no usable RSA keys.');
    this.cachedKeys = next;
    this.cacheExpiresAt = Date.now() + JWKS_CACHE_TTL_MS;
    return next;
  }

  async validate(request) {
    if (!this.enabled) return null;
    const token = request.headers['cf-access-jwt-assertion'];
    if (typeof token !== 'string' || !token) {
      this.log('Cloudflare Access JWT rejected: assertion header is missing.');
      return null;
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
      this.log('Cloudflare Access JWT rejected: assertion format is invalid.');
      return null;
    }
    const header = decodeJson(parts[0]);
    const payload = decodeJson(parts[1]);
    if (!header || !payload || header.alg !== 'RS256' || typeof header.kid !== 'string') {
      this.log('Cloudflare Access JWT rejected: assertion header or payload is invalid.');
      return null;
    }
    let key;
    try {
      key = (await this.keys()).get(header.kid);
      if (!key) key = (await this.keys(true)).get(header.kid);
      if (!key) {
        this.log('Cloudflare Access JWT rejected: signing key was not found.');
        return null;
      }
      const verified = crypto.verify(
        'RSA-SHA256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        crypto.createPublicKey({ key, format: 'jwk' }),
        Buffer.from(parts[2], 'base64url'),
      );
      if (!verified) {
        this.log('Cloudflare Access JWT rejected: signature validation failed.');
        return null;
      }
      if (payload.iss !== this.config.cloudflareAccess.teamDomain) {
        this.log('Cloudflare Access JWT rejected: issuer did not match the configured team domain.');
        return null;
      }
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!audiences.includes(this.config.cloudflareAccess.audience)) {
        this.log('Cloudflare Access JWT rejected: audience did not match the configured application.');
        return null;
      }
      const now = Math.floor(Date.now() / 1000);
      if (!Number.isFinite(payload.exp) || payload.exp <= now || (Number.isFinite(payload.nbf) && payload.nbf > now)) {
        this.log('Cloudflare Access JWT rejected: token is expired or not yet valid.');
        return null;
      }
      this.log('Cloudflare Access JWT accepted for an MCP request.');
      return { source: 'cloudflare-access', scopes: new Set(['home.read', 'home.control']), email: typeof payload.email === 'string' ? payload.email : null };
    } catch {
      this.log('Cloudflare Access JWT validation failed.');
      return null;
    }
  }
}

module.exports = { CloudflareAccessValidator };
