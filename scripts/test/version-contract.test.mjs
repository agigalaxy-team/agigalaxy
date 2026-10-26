import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateManifest } from '../../packages/galaxy-official/src/verification/manifest.mjs';
import { consentSchema } from '../../packages/galaxy-official/src/shared/consents-schema.mjs';
import { migrations } from '../../packages/galaxy-official/src/infrastructure/migrations.mjs';
import { STORE_VERSION } from '../../packages/galaxy-core/src/domain/local-model.mjs';
const json = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

test('frozen current version contract matches service package and local store; unknown Manifest versions fail closed', async () => {
  const contract = await json('../../docs/technical/reference/version-contract.json');
  assert.equal((await json('../../packages/galaxy-official/package.json')).version, contract.versions.service);
  assert.equal(STORE_VERSION, contract.versions.coreStore);
  assert.deepEqual(migrations.map(item => item.version), contract.versions.databaseMigrations);
  const endpoint = 'https://official.example.org';
  const data = { schemaVersion: 1, networkType: 'official', displayName: 'Synthetic', operator: 'Test', endpoint,
    capabilities: ['binding', 'sessions'], policy: { automaticUpload: false, privateKeyCustody: 'client', url: endpoint + '/v1/policy' },
    region: 'test', serviceVersion: contract.versions.service, signingKeyId: 'fixture', revocationPath: '/v1/signing-keys/status' };
  assert.equal(validateManifest(data, endpoint), data);
  for (const patch of [{ schemaVersion: 2 }, { serviceVersion: '0.1.1' }, { serviceVersion: '1.0.0' }, { alternateVersion: 1 }])
    assert.throws(() => validateManifest({ ...data, ...patch }, endpoint));
});

test('Consent has no implicit fallback from future schema or policy to current authorization', () => {
  const id = '12345678-1234-4234-8234-123456789abc';
  const value = { version: 1, id, subjectId: 'GUID' + '0'.repeat(28), bindingId: id, endpoint: 'https://official.example.org',
    objectId: id, action: 'case.teaser.publish', purpose: 'operational', recipient: 'https://official.example.org', fields: ['title'],
    visibility: 'Private', viewers: [], payloadHash: 'a'.repeat(64), policyVersion: '0.1', issuedAt: 1000, expiresAt: 2000 };
  assert.equal(consentSchema.safeParse(value).success, true);
  assert.equal(consentSchema.safeParse({ ...value, version: 2 }).success, false);
  assert.equal(consentSchema.safeParse({ ...value, policyVersion: '0.2' }).success, false);
});
