import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrustPackageClient } from '../src/trust-package-client.mjs';
import { trustCanonical } from '../src/shared/trust-package-crypto.mjs';
import { trustSubjectUri } from '../src/shared/trust-package-vc-jose.mjs';
import { vcJoseClientFixture } from './trust-package-vc-jose-workflow.mjs';

test('explicit local VC review signs with the existing device and receiver pin; source revocation rejects a new export without changing the ordinary bytes', async () => {
  const f = await vcJoseClientFixture();
  try {
    const selected = await f.source(), permissionId = await f.grantCopy(selected.ref);
    const container = await f.ordinary([{ ref: selected.ref, mode: 'copy', permissionId }]);
    const original = trustCanonical(container), preview = await f.client.prepareVcPackage(container);
    await assert.rejects(f.client.exportVcPackage(preview), /trust_preview_required/);
    const result = await f.client.exportVcPackage(preview, { confirmed: true });
    const pins = new Map([[trustSubjectUri(f.genesis.id), new Map([[f.keyId, { publicKeyPem: f.material.publicKeyPem }]])]]);
    const imported = await f.client.importVcPackage(result.bundle, { trustedIssuers: pins, audience: f.genesis.id, now: f.f.now });
    assert.equal(imported.integrity, 'valid'); assert.equal(imported.currentStatus, 'unknown'); assert.equal(imported.capabilityVerified, false);
    assert.equal(f.state.signs, 1); assert.equal(result.remotePublished, false); assert.equal(trustCanonical(container), original);
    assert.equal(trustCanonical(result.bundle.package), original);
    const stale = await f.client.prepareVcPackage(container);
    await f.api.call('/v1/consents/' + selected.consentId + '/revoke', {});
    await assert.rejects(f.client.exportVcPackage(stale, { confirmed: true }), /trust_source_changed/);
    await assert.rejects(f.client.prepareVcPackage(container), /trust_source_changed/);
    assert.equal(f.state.signs, 1); assert.equal(trustCanonical(container), original);
    const historical = await f.client.importVcPackage(result.bundle, { trustedIssuers: pins, audience: f.genesis.id, now: f.f.now });
    assert.equal(historical.integrity, 'valid'); assert.equal(historical.currentStatus, 'unknown');
  } finally { await f.close(); }
});

test('same-subject reconnect after current sources, before signing or inside queue withholds the old selected preview', async () => {
  const f = await vcJoseClientFixture();
  try {
    const selected = await f.source(), container = await f.ordinary([{ ref: selected.ref, mode: 'reference' }]);
    f.state.reconnectAfterSources = true;
    await assert.rejects(f.client.prepareVcPackage(container), /trust_vc_identity_changed/);
    const preview = await f.client.prepareVcPackage(container); f.state.reconnectBeforeSigning = true;
    await assert.rejects(f.client.exportVcPackage(preview, { confirmed: true }), /trust_vc_identity_changed/);
    assert.equal(f.state.signs, 0);
    let entered, release; const started = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
    const queued = createTrustPackageClient({ ...f.options, locks: { request: async (_name, _options, callback) => { entered(); await wait; return callback(); } } });
    const next = await queued.prepareVcPackage(container), operation = queued.exportVcPackage(next, { confirmed: true });
    const rejected = assert.rejects(operation, /trust_vc_identity_changed/);
    await started; await f.connect(); release(); await rejected; assert.equal(f.state.signs, 0);
  } finally { await f.close(); }
});

test('same binding ID with generation change during signing and final local save cannot return the old selected private package', async () => {
  const f = await vcJoseClientFixture();
  try {
    const container = await f.ordinary(), realSnapshot = f.api.snapshot; let extra = 0;
    const snapshot = () => ({ ...realSnapshot(), generation: realSnapshot().generation + extra });
    const client = createTrustPackageClient({ ...f.options, api: { ...f.consumerApi, snapshot },
      current: async () => ({ ...await f.device.current(), generation: snapshot().generation }),
      signVc: async (preview, expected) => { const signature = await f.device.signVc(preview, expected); extra++; return signature; } });
    const preview = await client.prepareVcPackage(container);
    await assert.rejects(client.exportVcPackage(preview, { confirmed: true }), /trust_vc_identity_changed/);
    assert.equal(f.memory.get('trust-package:last-vc-export'), undefined);
    const next = await f.client.prepareVcPackage(container); f.state.reconnectOnSave = true;
    await assert.rejects(f.client.exportVcPackage(next, { confirmed: true }), /trust_vc_identity_changed/);
    assert.ok(f.memory.get('trust-package:last-vc-export'), 'original signed local artifact may persist; failure is not rollback');
    assert.equal((await f.client.lastVcExport()).bundle.package.manifestJson, container.manifestJson);
  } finally { await f.close(); }
});

test('one selected VC preview permits one actual signature and local save under two concurrent executes', async () => {
  const f = await vcJoseClientFixture();
  try {
    const container = await f.ordinary(), original = trustCanonical(container);
    const preview = await f.client.prepareVcPackage(container);
    const save = f.memory.set.bind(f.memory); let storageWrites = 0;
    f.memory.set = (key, value) => { if (key === 'trust-package:last-vc-export') storageWrites++; return save(key, value); };
    const results = await Promise.allSettled([
      f.client.exportVcPackage(preview, { confirmed: true }),
      f.client.exportVcPackage(preview, { confirmed: true }),
    ]);
    const accepted = results.filter(value => value.status === 'fulfilled');
    const rejected = results.filter(value => value.status === 'rejected');
    assert.equal(accepted.length, 1); assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'trust_preview_required');
    assert.equal(f.state.signs, 1); assert.equal(storageWrites, 1);
    assert.equal(trustCanonical(container), original);
    assert.equal(trustCanonical(accepted[0].value.bundle.package), original);
    const pins = new Map([[trustSubjectUri(f.genesis.id), new Map([[f.keyId, { publicKeyPem: f.material.publicKeyPem }]])]]);
    assert.equal((await f.client.importVcPackage(accepted[0].value.bundle,
      { trustedIssuers: pins, audience: f.genesis.id, now: f.f.now })).integrity, 'valid');
  } finally { await f.close(); }
});
