import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGalaxyGuid,
  formatGalaxyGuidForDisplay,
  isGalaxyGuid,
  parseGalaxyGuid,
} from '../src/galaxy-guid.mjs';

const publicKeyPem = '-----BEGIN PUBLIC KEY-----\nGalaxy test public key\n-----END PUBLIC KEY-----\n';
const issuedAtMs = 1_788_134_400_123;

test('GUID-32 v1 is fixed-length, time-sortable, and bound to its local genesis inputs', () => {
  const first = createGalaxyGuid({
    publicKeyPem,
    issuedAtMs,
    originCode: '0',
    nonce: Buffer.alloc(16, 1),
  });
  const second = createGalaxyGuid({
    publicKeyPem,
    issuedAtMs,
    originCode: '0',
    nonce: Buffer.alloc(16, 2),
  });

  assert.match(first, /^GUID[0-9A-HJKMNPQRSTVWXYZ]{28}$/);
  assert.equal(first.length, 32);
  assert.notEqual(first, second);
  assert.equal(first.slice(6, 16), second.slice(6, 16));

  const parsed = parseGalaxyGuid(first);
  assert.equal(parsed.format, 'guid-32-v1');
  assert.equal(parsed.version, '1');
  assert.equal(parsed.originCode, '0');
  assert.equal(parsed.origin.key, 'local');
  assert.equal(parsed.issuedAtMs, issuedAtMs);
  assert.equal(parsed.genesisCommitment.length, 16);
  assert.equal(formatGalaxyGuidForDisplay(first), `GUID-10-${first.slice(6, 16)}-${first.slice(16)}`);
  assert.equal(isGalaxyGuid(first), true);
});

test('GUID-32 rejects non-canonical values and unsupported claims', () => {
  assert.equal(isGalaxyGuid('GUID10OOOOOOOOOO0000000000000000'), false);
  assert.throws(() => parseGalaxyGuid('gUid10ABCDEFGHJKMNPQRSTVWXYZ1234'), /32-character string beginning with GUID/);
  assert.throws(() => createGalaxyGuid({ publicKeyPem, originCode: '9' }), /Unknown Galaxy GUID origin code/);
  assert.throws(() => createGalaxyGuid({ publicKeyPem: '' }), /public key PEM/);
});
