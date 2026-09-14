import { createHash, createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto';

export const GALAXY_GUID_PREFIX = 'GUID';
export const GALAXY_GUID_VERSION = '1';
export const GALAXY_GUID_LENGTH = 32;
export const GALAXY_GUID_BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// The origin code records only the immutable issuance context. It is not a
// trust level, a Hub membership, or a statement about the holder.
export const GALAXY_GUID_ORIGINS = Object.freeze({
  0: Object.freeze({ key: 'local', title: 'Local standalone client' }),
  1: Object.freeze({ key: 'official-main', title: 'Official main-network issuer' }),
  2: Object.freeze({ key: 'official-hub', title: 'Official reference Hub issuer' }),
  3: Object.freeze({ key: 'compatible-third-party', title: 'Compatible third-party issuer' }),
  4: Object.freeze({ key: 'migration-import', title: 'Migration or import' }),
  5: Object.freeze({ key: 'synthetic-test', title: 'Synthetic or test only' }),
});

const MAX_TIMESTAMP_MS = (1n << 50n) - 1n;
const BASE32_INDEX = new Map(Array.from(GALAXY_GUID_BASE32_ALPHABET, (character, index) => [character, index]));

function encodeBase32(value, length) {
  let remaining = BigInt(value);
  if (remaining < 0n) throw new Error('GUID values cannot be negative.');
  let encoded = '';
  for (let index = 0; index < length; index += 1) {
    encoded = `${GALAXY_GUID_BASE32_ALPHABET[Number(remaining & 31n)]}${encoded}`;
    remaining >>= 5n;
  }
  if (remaining !== 0n) throw new Error(`GUID value does not fit in ${length} Base32 characters.`);
  return encoded;
}

function decodeBase32(value) {
  let decoded = 0n;
  for (const character of value) {
    const digit = BASE32_INDEX.get(character);
    if (digit === undefined) throw new Error(`Invalid GUID Base32 character: ${character}.`);
    decoded = (decoded << 5n) + BigInt(digit);
  }
  return decoded;
}

function bytesToBigInt(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  return value;
}

function normalizeOriginCode(originCode) {
  const value = String(originCode ?? '0');
  if (!Object.hasOwn(GALAXY_GUID_ORIGINS, value)) {
    throw new Error(`Unknown Galaxy GUID origin code: ${value}.`);
  }
  return value;
}

/**
 * Creates a strict 32-character Galaxy GUID v1.
 *
 * GUID<V><O><TTTTTTTTTT><CCCCCCCCCCCCCCCC>
 *  4   1  1      10              16
 *
 * The commitment is deliberately opaque. It is derived from the initial
 * public key, creation time, origin, and a local CSPRNG nonce; it must not be
 * decoded as user identity, role, capability, Hub membership, or trust.
 */
export function createGalaxyGuid({
  publicKeyPem,
  issuedAtMs = Date.now(),
  originCode = '0',
  nonce = randomBytes(16),
} = {}) {
  if (typeof publicKeyPem !== 'string' || !publicKeyPem.trim()) {
    throw new Error('A public key PEM is required to create a Galaxy GUID.');
  }
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0 || BigInt(issuedAtMs) > MAX_TIMESTAMP_MS) {
    throw new Error('GUID issuedAtMs must be a non-negative safe integer that fits 50 bits.');
  }
  if (!(nonce instanceof Uint8Array) || nonce.byteLength < 16) {
    throw new Error('GUID nonce must contain at least 16 random bytes.');
  }

  const normalizedOriginCode = normalizeOriginCode(originCode);
  const commitmentBytes = createHash('sha256')
    .update('galaxy/guid/v1\0', 'utf8')
    .update(normalizedOriginCode, 'utf8')
    .update('\0', 'utf8')
    .update(String(issuedAtMs), 'utf8')
    .update('\0', 'utf8')
    .update(publicKeyPem.trim(), 'utf8')
    .update('\0', 'utf8')
    .update(nonce)
    .digest()
    .subarray(0, 10);

  return `${GALAXY_GUID_PREFIX}${GALAXY_GUID_VERSION}${normalizedOriginCode}${encodeBase32(BigInt(issuedAtMs), 10)}${encodeBase32(bytesToBigInt(commitmentBytes), 16)}`;
}

export function parseGalaxyGuid(value) {
  if (typeof value !== 'string' || value.length !== GALAXY_GUID_LENGTH || !value.startsWith(GALAXY_GUID_PREFIX)) {
    throw new Error('A Galaxy GUID must be a 32-character string beginning with GUID.');
  }
  const version = value[4];
  const originCode = value[5];
  const timestampPart = value.slice(6, 16);
  const genesisCommitment = value.slice(16);
  if (!BASE32_INDEX.has(version) || !BASE32_INDEX.has(originCode) || !Array.from(`${timestampPart}${genesisCommitment}`).every((character) => BASE32_INDEX.has(character))) {
    throw new Error('A Galaxy GUID contains non-canonical Base32 characters.');
  }
  if (version !== GALAXY_GUID_VERSION) throw new Error(`Unsupported Galaxy GUID version: ${version}.`);
  const normalizedOriginCode = normalizeOriginCode(originCode);
  const issuedAtMs = Number(decodeBase32(timestampPart));

  return {
    id: value,
    format: 'guid-32-v1',
    version,
    originCode: normalizedOriginCode,
    origin: GALAXY_GUID_ORIGINS[normalizedOriginCode],
    issuedAtMs,
    issuedAt: new Date(issuedAtMs).toISOString(),
    genesisCommitment,
  };
}

export function isGalaxyGuid(value) {
  try {
    parseGalaxyGuid(value);
    return true;
  } catch {
    return false;
  }
}

export function formatGalaxyGuidForDisplay(value) {
  const parsed = parseGalaxyGuid(value);
  return `GUID-${parsed.version}${parsed.originCode}-${value.slice(6, 16)}-${parsed.genesisCommitment}`;
}

// A public commitment opening, not a private key. It is retained locally at
// creation and disclosed only by an explicit future identity-binding action.
export function createGalaxyGenesis({ publicKeyPem, issuedAtMs = Date.now(), originCode = '0', nonce = randomBytes(32) } = {}) {
  if (!(nonce instanceof Uint8Array) || nonce.byteLength < 16 || nonce.byteLength > 64) {
    throw new Error('Genesis nonce must contain 16 to 64 bytes.');
  }
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Galaxy genesis requires Ed25519.');
  const canonicalPem = key.export({ type: 'spki', format: 'pem' });
  const id = createGalaxyGuid({ publicKeyPem: canonicalPem, issuedAtMs, originCode, nonce });
  return {
    id,
    genesisProof: {
      version: 1,
      publicKeyPem: canonicalPem,
      nonce: Buffer.from(nonce).toString('base64url'),
    },
  };
}

export function verifyGalaxyGenesis(id, proof) {
  try {
    if (!proof || Object.getPrototypeOf(proof) !== Object.prototype
      || Object.keys(proof).sort().join(',') !== 'nonce,publicKeyPem,version'
      || proof.version !== 1 || typeof proof.publicKeyPem !== 'string' || proof.publicKeyPem.length > 256
      || typeof proof.nonce !== 'string' || !/^[A-Za-z0-9_-]{22,86}$/.test(proof.nonce)) return false;
    const nonce = Buffer.from(proof.nonce, 'base64url');
    if (nonce.length < 16 || nonce.length > 64 || nonce.toString('base64url') !== proof.nonce) return false;
    const parsed = parseGalaxyGuid(id);
    const key = createPublicKey(proof.publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const canonicalPem = key.export({ type: 'spki', format: 'pem' });
    if (canonicalPem !== proof.publicKeyPem) return false;
    const expected = createGalaxyGuid({ publicKeyPem: canonicalPem, nonce,
      issuedAtMs: parsed.issuedAtMs, originCode: parsed.originCode });
    return timingSafeEqual(Buffer.from(expected), Buffer.from(id));
  } catch { return false; }
}
