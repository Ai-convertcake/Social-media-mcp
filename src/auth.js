import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken() {
  const token = `smm_${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashToken(token) };
}

// spec: comma-separated "label:sha256hex" entries (MCP_TOKEN_HASHES).
export function parseTokenHashes(spec = '') {
  return spec
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [label, hash] = entry.split(':');
      if (!label || !/^[0-9a-f]{64}$/.test(hash ?? '')) {
        throw new Error('MCP_TOKEN_HASHES entries must look like label:<sha256 hex>.');
      }
      return { label, hash: Buffer.from(hash, 'hex') };
    });
}

// Returns the matching label, or null.
export function verifyBearer(header, entries) {
  const match = /^Bearer (\S+)$/.exec(header ?? '');
  if (!match) return null;
  const presented = Buffer.from(hashToken(match[1]), 'hex');
  let found = null;
  for (const entry of entries) {
    if (timingSafeEqual(presented, entry.hash)) found = entry.label;
  }
  return found;
}
