import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { consentSchema } from '../../packages/galaxy-contracts/src/consents-schema.mjs';
import { readMigrations } from '../../go/internal/databaseschema/generate.mjs';
const json = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

test('current version contract matches the authoritative Go SQL history', async () => {
  const contract = await json('../../docs/technical/reference/version-contract.json');
  assert.equal((await json('../../packages/galaxy-official/package.json')).version, contract.versions.service);
  assert.deepEqual((await readMigrations()).map(item => item.version), contract.versions.databaseMigrations);
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
