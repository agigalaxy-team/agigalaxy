import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { CompactSign } from 'jose';
import { receiptStatusFixture, verifyReceiptStatusExpiredContinuity } from './receipt-status-workflow.mjs';
import { receiptStatusResponseType } from '../src/shared/receipt-status-schema.mjs';
import { createReceiptStatusClient, createReceiptStatusDeviceSigner } from "../src/clients/receipt-status.mjs";
import { signIdentityPayload } from '../../galaxy-core/src/domain/identity-material.mjs';
import { digest } from '../src/shared/digest.mjs';

test('Retained exact owner receipt is authenticated after all ordinary sessions and bindings expire without reviving writes or content', async () => {
  const observed = await verifyReceiptStatusExpiredContinuity(); assert.equal(observed.originalAcknowledgmentOnly, true);
});

test('Purpose-bound proof rejects changed locator, unrelated key, ordinary-session signature, expiry and revoked current device', async () => {
  const t = await receiptStatusFixture();
  try {
    const input = { subjectId: t.identity.subjectId, control: t.context.control, operation: t.operation, clientNonce: randomBytes(32).toString('base64url') };
    const issued = (await t.request('/v2/receipt-status/challenges', input)); assert.equal(issued.status, 201);
    const signature = await t.signer(issued.body.challenge);
    const proof = { challenge: issued.body.challenge, signature };
    assert.equal((await t.request('/v2/receipt-status/query', proof)).body.state, 'acknowledged');
    assert.equal((await t.request('/v2/receipt-status/query', { ...proof, operation: { ...t.operation, versionId: randomUUID() } })).status, 400);
    const foreign = generateKeyPairSync('ed25519');
    const signed = type => new CompactSign(Buffer.from(issued.body.challenge)).setProtectedHeader({ alg: 'Ed25519', typ: type }).sign(foreign.privateKey);
    assert.equal((await t.request('/v2/receipt-status/query', { ...proof, signature: await signed(receiptStatusResponseType) })).status, 401);
    const ordinarySignature = await signIdentityPayload(issued.body.challenge, t.material.privateKey, { type: 'galaxy-session-response+jws' });
    assert.equal((await t.request('/v2/receipt-status/query', { ...proof, signature: ordinarySignature })).status, 401);
    assert.equal((await t.request('/v1/sessions', proof)).status, 401, 'special challenge cannot activate an ordinary session');
    await t.f.db.query("UPDATE device_authorizations SET status='revoked',revoked_at=$2 WHERE device_id=$1", [t.identity.deviceId, new Date(t.now() * 1000).toISOString()]);
    assert.equal((await t.request('/v2/receipt-status/query', proof)).status, 401);
    await t.f.db.query("UPDATE device_authorizations SET status='active',revoked_at=NULL WHERE device_id=$1", [t.identity.deviceId]);
    t.setTime(issued.body.expiresAt); assert.equal((await t.request('/v2/receipt-status/query', proof)).status, 401);
  } finally { await t.close(); }
});

test('Client query binds current owner/control/generation across challenge, private-key load and receipt response and never retries business', async () => {
  const t = await receiptStatusFixture();
  try {
    const start = t.requests.length;
    const signer = t.signer;
    const changed = await t.request('/v2/receipt-status/challenges', { subjectId: t.identity.subjectId, control: t.context.control,
      operation: t.operation, clientNonce: randomBytes(32).toString('base64url') });
    assert.equal(changed.status, 201);
    t.context.subjectId = t.f.actor.subjectId; await assert.rejects(signer(changed.body.challenge), /authority_changed/);
    t.context.subjectId = t.identity.subjectId;
    const make = extra => createReceiptStatusClient({ endpoint: t.f.access.endpoint, trustedKeys: t.trustedKeys,
      getContext: t.getContext, signReceiptStatus: t.signer, fetch: t.transport, now: t.now, ...extra });
    let hook = '/v2/receipt-status/challenges';
    const changedAfterHttp = make({ fetch: async (...args) => {
      const response = await t.transport(...args);
      if (new URL(args[0]).pathname === hook) t.rebind(); return response;
    } });
    const prior = t.requests.filter(r => r.path === '/v2/receipt-status/query').length;
    await assert.rejects(changedAfterHttp.query(t.operation), /authority_changed/);
    assert.equal(t.requests.filter(r => r.path === '/v2/receipt-status/query').length, prior, 'no query is sent with an old challenge after rebind');
    const changedOnPrivateLoad = createReceiptStatusDeviceSigner({ endpoint: t.f.access.endpoint, trustedKeys: t.trustedKeys,
      getContext: t.getContext, now: t.now, getPrivateKey: async () => { t.rebind(); return t.material.privateKey; } });
    await assert.rejects(make({ signReceiptStatus: changedOnPrivateLoad }).query(t.operation), /authority_changed/);
    assert.equal(t.requests.filter(r => r.path === '/v2/receipt-status/query').length, prior);
    hook = '/v2/receipt-status/query'; await assert.rejects(changedAfterHttp.query(t.operation), /authority_changed/);
    assert.equal(t.requests.filter(r => r.path === '/v2/receipt-status/query').length, prior + 1, 'an already completed read is withheld, not described as cancelled');
    const recovered = await t.client.query(t.operation); assert.equal(recovered.state, 'acknowledged');
    assert.equal(t.requests.slice(start).some(r => /put|preferences\/save|\/v1\/sessions/.test(r.path)), false);
  } finally { await t.close(); }
});

test('Owner-only absent/conflict and retention are checked without reading source/body, enabling synchronization or inventing a deleted operation ledger', async () => {
  const t = await receiptStatusFixture();
  try {
    const priorReader = t.f.choices.sourceReader.statusWithin.bind(t.f.choices.sourceReader), priorGet = t.f.choices.getWithin.bind(t.f.choices);
    t.f.choices.sourceReader.statusWithin = () => { throw new Error('forbidden source/body read'); };
    t.f.choices.getWithin = () => { throw new Error('forbidden current body read'); };
    try {
      assert.equal((await t.client.query(t.operation)).state, 'acknowledged');
      assert.equal((await t.client.query({ ...t.operation, requestHash: '0'.repeat(64) })).state, 'conflict');
      const input = { subjectId: t.f.actor.subjectId, control: { deviceId: null, keyId: t.f.actor.keyId, epoch: 0 },
        operation: t.operation, clientNonce: randomBytes(32).toString('base64url') };
      const challenge = await t.request('/v2/receipt-status/challenges', input); assert.equal(challenge.status, 201);
      const stranger = await t.request('/v2/receipt-status/query', { challenge: challenge.body.challenge,
        signature: await t.f.signForTest(challenge.body.challenge, receiptStatusResponseType) });
      assert.equal(stranger.status, 200); assert.equal(stranger.body.state, 'absent');
      assert.equal((await t.request('/v2/receipt-status/challenges', { ...input, operation: { ...input.operation, kind: 'choice-get' } })).status, 400);
      await t.f.db.query('DELETE FROM choice_snapshot_versions WHERE subject_id=$1', [t.identity.subjectId]);
      const absent = await t.client.query(t.operation); assert.equal(absent.state, 'absent'); assert.equal(absent.absenceMeaning, 'no-retained-owner-operation');
      assert.equal(Number((await t.f.db.query('SELECT count(*) FROM choice_snapshot_versions WHERE subject_id=$1', [t.identity.subjectId])).rows[0].count), 0);
    } finally { t.f.choices.sourceReader.statusWithin = priorReader; t.f.choices.getWithin = priorGet; }
  } finally { await t.close(); }
});

test('A real signed device authorization and revocation invalidates an old proof; the current owner device can read metadata without creating any binding', async () => {
  const t = await receiptStatusFixture();
  try {
    const issued = await t.request('/v2/receipt-status/challenges', { subjectId: t.identity.subjectId, control: t.context.control,
      operation: t.operation, clientNonce: randomBytes(32).toString('base64url') });
    assert.equal(issued.status, 201);
    const oldProof = { challenge: issued.body.challenge, signature: await t.signer(issued.body.challenge) };
    const second = generateKeyPairSync('ed25519'), deviceId = randomUUID(), publicKeyPem = second.publicKey.export({ type: 'spki', format: 'pem' });
    const firstState = await t.f.identityControl.publicState(t.identity.subjectId);
    const add = await t.f.identityControl.challenge({ kind: 'authorize-device', operationId: randomUUID(), subjectId: t.identity.subjectId,
      expectedEpoch: firstState.epoch, previousEventHash: firstState.chainHead, signerKeyId: t.context.control.keyId,
      newDevice: { deviceId, publicKeyPem, scopes: ['binding', 'manage-identity'] } });
    const secondSign = (text, type = 'galaxy-identity-control-v2+jws') => new CompactSign(Buffer.from(text)).setProtectedHeader({ alg: 'Ed25519', typ: type }).sign(second.privateKey);
    await t.f.identityControl.commit({ operationId: add.operationId,
      controllerSignature: await signIdentityPayload(add.challenge, t.material.privateKey), newDeviceProof: await secondSign(add.challenge) });
    const added = await t.f.identityControl.publicState(t.identity.subjectId);
    const revoke = await t.f.identityControl.challenge({ kind: 'revoke-device', operationId: randomUUID(), subjectId: t.identity.subjectId,
      expectedEpoch: added.epoch, previousEventHash: added.chainHead, signerKeyId: digest(publicKeyPem), deviceId: t.identity.deviceId });
    await t.f.identityControl.commit({ operationId: revoke.operationId, controllerSignature: await secondSign(revoke.challenge) });
    assert.equal((await t.request('/v2/receipt-status/query', oldProof)).status, 401);
    const count = Number((await t.f.db.query('SELECT count(*) FROM bindings WHERE subject_id=$1', [t.identity.subjectId])).rows[0].count);
    const fresh = await t.request('/v2/receipt-status/challenges', { subjectId: t.identity.subjectId,
      control: { deviceId, keyId: digest(publicKeyPem), epoch: added.epoch }, operation: t.operation, clientNonce: randomBytes(32).toString('base64url') });
    assert.equal(fresh.status, 201);
    const ack = await t.request('/v2/receipt-status/query', { challenge: fresh.body.challenge,
      signature: await secondSign(fresh.body.challenge, receiptStatusResponseType) });
    assert.equal(ack.status, 200); assert.equal(ack.body.state, 'acknowledged'); assert.equal(ack.body.currentAccessGranted, false);
    assert.equal(Number((await t.f.db.query('SELECT count(*) FROM bindings WHERE subject_id=$1', [t.identity.subjectId])).rows[0].count), count);
    assert.equal(Number((await t.f.db.query('SELECT count(*) FROM bindings WHERE device_id=$1', [deviceId])).rows[0].count), 0);
  } finally { await t.close(); }
});
