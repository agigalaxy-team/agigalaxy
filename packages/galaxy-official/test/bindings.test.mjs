import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, randomBytes } from 'node:crypto';
import { CompactSign } from 'jose';
import { PGlite } from '@electric-sql/pglite';
import { createGalaxyGenesis } from '../../galaxy-core/src/galaxy-guid.mjs';
import { migrate, transaction } from "../src/infrastructure/database.mjs";
import { BindingService, digest } from "../src/identity/bindings.mjs";
import { AccessService } from "../src/security/access.mjs";
import { createApi } from '../src/http.mjs';
import { ConsentService, canReadProjection } from "../src/consents/consents.mjs";

test('binding validates ownership, consumes once, scopes reads and atomically revokes', async () => {
  const db = new PGlite();
  let http;
  try {
    await migrate(db);
    const server = generateKeyPairSync('ed25519');
    const local = generateKeyPairSync('ed25519');
    const foreign = generateKeyPairSync('ed25519');
    const genesis = createGalaxyGenesis({ publicKeyPem: local.publicKey.export({ type: 'spki', format: 'pem' }), originCode: '5' });
    let now = 2000000000;
    const service = new BindingService({ db, endpoint: 'https://official.example.org', kid: 'fixture',
      signingKey: server.privateKey, now: () => now, allowedScopes: ['binding', 'consent'],
      authorizeAdministrativeRevoke:()=>true, // This fixture explicitly exercises trusted process administration.
      trustedKeys: new Map([['fixture', { publicKeyPem: server.publicKey.export({ type: 'spki', format: 'pem' }),
        notBefore: now - 1, notAfter: now + 200000, revoked: false }]]) });
    const request = { subjectId: genesis.id, genesisProof: genesis.genesisProof,
      installationId: randomUUID(), scopes: ['binding', 'consent'] };
    const logs = [];
    const access = new AccessService(service);
    const consents = new ConsentService(access);
    http = createApi({ bindings: service, access, consents, logger: record => logs.push(record) });
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${http.address().port}`;
    const post = (path, input, headers = {}) => fetch(origin + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) });
    assert.equal((await fetch(origin + '/healthz')).status, 200);
    assert.equal((await post('/v1/binding-challenges', { ...request, privateKey: 'must-never-log' })).status, 400);
    assert.equal((await post('/v1/binding-challenges', request, { Origin: 'https://foreign.example' })).status, 403);
    await assert.rejects(service.challenge({ ...request, scopes: ['case'] }), /identity_or_scope_invalid/);
    await assert.rejects(service.challenge({ ...request, genesisProof: { ...genesis.genesisProof,
      publicKeyPem: foreign.publicKey.export({ type: 'spki', format: 'pem' }) } }), /identity_or_scope_invalid/);
    const issuedResponse = await post('/v1/binding-challenges', request);
    assert.equal(issuedResponse.status, 201);
    const issued = await issuedResponse.json();
    const sign = key => new CompactSign(Buffer.from(issued.challenge))
      .setProtectedHeader({ alg: 'Ed25519', typ: 'galaxy-binding-response+jws' }).sign(key);
    const response = { challenge: issued.challenge, signature: await sign(local.privateKey), clientSession: issued.clientSession };
    await assert.rejects(service.bind({ ...response, signature: await sign(foreign.privateKey) }), /binding_proof_invalid/);
    await assert.rejects(service.bind({ ...response, clientSession: 'a'.repeat(43) }), /binding_proof_invalid/);
    const [first, repeated] = await Promise.all([post('/v1/bindings', response).then(r => r.json()), service.bind(response)]);
    assert.deepEqual(first, repeated);
    assert.equal((await db.query('SELECT * FROM bindings')).rows.length, 1);
    assert.equal((await db.query("SELECT * FROM audit_events WHERE action='binding.create'")).rows.length, 1);
    assert.equal((await service.get(first.bindingId, genesis.id)).state, 'active');
    const credential = randomBytes(32).toString('base64url');
    const sessionChallenge = await access.challenge({ bindingId: first.bindingId, credentialHash: digest(credential) });
    const sessionSignature = await new CompactSign(Buffer.from(sessionChallenge.challenge))
      .setProtectedHeader({ alg: 'Ed25519', typ: 'galaxy-session-response+jws' }).sign(local.privateKey);
    await assert.rejects(access.authenticate(credential), /access_denied/);
    await assert.rejects(access.activate({ ...sessionChallenge, signature: response.signature }), /access_denied/);
    const activatedHttp = await post('/v1/sessions', { ...sessionChallenge, signature: sessionSignature });
    assert.equal(activatedHttp.status, 200);
    const activation = await activatedHttp.json();
    assert.deepEqual(await access.activate({ ...sessionChallenge, signature: sessionSignature }), activation);
    assert.equal((await access.authenticate(credential)).subjectId, genesis.id);
    assert.equal((await fetch(origin + `/v1/bindings/${first.bindingId}`, { headers: { Authorization: `Bearer ${credential}` } })).status, 200);
    assert.equal((await fetch(origin + `/v1/bindings/${first.bindingId}`)).status, 401);
    await assert.rejects(access.authenticate(first.receipt), /access_denied/);
    await assert.rejects(access.authenticate(credential, 'case'), /access_denied/);
    const actor = await access.authenticate(credential, 'consent');
    const payloadJson = JSON.stringify({ title: 'Synthetic case' });
    const intent = { version: 1, id: randomUUID(), subjectId: genesis.id, bindingId: first.bindingId,
      endpoint: service.endpoint, objectId: randomUUID(), action: 'case.teaser.publish', purpose: 'operational',
      recipient: service.endpoint, fields: ['title'], visibility: 'Private', viewers: [], payloadHash: digest(payloadJson),
      policyVersion: '0.1', issuedAt: now, expiresAt: now + 3600 };
    const signedIntent = await new CompactSign(Buffer.from(JSON.stringify(intent)))
      .setProtectedHeader({ alg: 'Ed25519', typ: 'galaxy-consent+jws' }).sign(local.privateKey);
    const granted = await post('/v1/consents', { signedIntent }, { Authorization: `Bearer ${credential}` });
    assert.equal(granted.status, 200);
    assert.equal((await consents.create(actor, signedIntent)).consentId, intent.id);
    const createdAudit = (await db.query("SELECT * FROM audit_events WHERE action='consent.create' AND object_id=$1", [intent.id])).rows;
    assert.equal(createdAudit.length, 1);
    assert.equal(createdAudit[0].context_version, 1);
    assert.equal(createdAudit[0].client_id, request.installationId);
    assert.equal(createdAudit[0].audience, service.endpoint);
    assert.equal(createdAudit[0].scope, 'consent');
    assert.deepEqual(createdAudit[0].credential_scopes, ['binding', 'consent']);
    assert.equal(createdAudit[0].consent_id, intent.id);
    assert.equal(createdAudit[0].binding_id, first.bindingId);
    assert.equal(createdAudit[0].http_request_id, granted.headers.get('x-request-id'));
    assert.equal(createdAudit[0].idempotency_key, intent.id);
    assert.ok(!JSON.stringify(createdAudit).includes(credential));

    assert.equal((await consents.list(actor)).items[0].status, 'active');
    const usage = { id: intent.id, subjectId: genesis.id, objectId: intent.objectId,
      action: intent.action, recipient: intent.recipient, payloadJson };
    await transaction(db, tx => consents.require(tx, usage));
    await assert.rejects(transaction(db, tx => consents.require(tx, { ...usage, payloadJson: '{}' })), /consent_required/);
    await assert.rejects(transaction(db, tx => consents.require(tx, { ...usage, recipient: 'foreign' })), /consent_required/);
    assert.equal(canReadProjection(intent, { now }), false);
    assert.equal(canReadProjection({ ...intent, visibility: 'Proof-only' }, { now }), false);
    assert.equal(canReadProjection({ ...intent, visibility: 'Public' }, { now }), false);
    assert.equal(canReadProjection({ ...intent, visibility: 'Public', purpose: 'public-profile' }, { now }), true);
    assert.equal(canReadProjection({ ...intent, visibility: 'Public', purpose: 'public-profile' }, { now: intent.expiresAt }), false);
    await db.query('UPDATE access_credentials SET scopes=$1 WHERE token_hash=$2', [JSON.stringify(['consent']), digest(credential)]);
    await consents.revoke({ ...actor, scopes: ['binding', 'consent', 'admin-forged'] }, intent.id);
    await consents.revoke(actor, intent.id);
    const revokedAudit = (await db.query("SELECT * FROM audit_events WHERE action='consent.revoke' AND object_id=$1", [intent.id])).rows;
    assert.equal(revokedAudit.length, 1);
    assert.equal(revokedAudit[0].context_version, 1);
    assert.equal(revokedAudit[0].consent_id, intent.id);
    assert.equal(revokedAudit[0].http_request_id, null);
    assert.deepEqual(revokedAudit[0].binding_scopes, ['binding', 'consent']);
    assert.deepEqual(revokedAudit[0].credential_scopes, ['consent'], 'audit uses transaction authorization, not stale or forged actor scopes');

    assert.equal((await consents.list(actor)).items[0].status, 'revoked');
    assert.equal((await consents.list(actor, intent.id)).items.length, 0);
    await assert.rejects(transaction(db, tx => consents.require(tx, usage)), /consent_required/);
    await assert.rejects(consents.create(actor, signedIntent), /consent_conflict/);
    await assert.rejects(service.get(first.bindingId, 'foreign-subject'), /not_found/);
    await assert.rejects(service.revoke(first.bindingId, 'foreign-subject', randomUUID()), /not_found/);
    await db.query('INSERT INTO access_credentials(token_hash,binding_id,scopes,expires_at) VALUES ($1,$2,$3,$4)',
      ['fixture-hash', first.bindingId, '[]', new Date((now + 600) * 1000).toISOString()]);
    await service.revoke(first.bindingId, genesis.id, randomUUID());
    await service.revoke(first.bindingId, genesis.id, randomUUID());
    await assert.rejects(access.authenticate(credential), /access_denied/);
    await assert.rejects(consents.create(actor, signedIntent), /access_denied/);
    await assert.rejects(access.activate({ ...sessionChallenge, signature: sessionSignature }), /access_denied/);
    assert.equal((await service.get(first.bindingId, genesis.id)).state, 'revoked');
    assert.ok((await db.query('SELECT revoked_at FROM access_credentials')).rows[0].revoked_at);
    assert.equal((await db.query("SELECT * FROM audit_events WHERE action='binding.revoke'")).rows.length, 1);
    const authAudit = (await db.query("SELECT * FROM audit_events WHERE action IN ('binding.create','binding.revoke','session.create') ORDER BY action")).rows;
    assert.equal(authAudit.length, 3);
    for (const entry of authAudit) {
      assert.equal(entry.context_version, 1);
      assert.equal(entry.client_id, request.installationId);
      assert.equal(entry.audience, service.endpoint);
      assert.equal(entry.scope, 'binding');
      assert.deepEqual(entry.binding_scopes, ['binding', 'consent']);
      assert.equal(entry.binding_id, first.bindingId);
      assert.equal(entry.consent_id, null, 'authentication must not invent object consent');
      assert.deepEqual(entry.credential_scopes, entry.action === 'session.create' ? ['binding', 'consent'] : null);
      assert.equal(entry.caller_binding_id, entry.action === 'binding.revoke' ? null : first.bindingId);
      assert.equal(entry.caller_client_id, entry.action === 'binding.revoke' ? null : request.installationId);
    }
    assert.equal(authAudit[0].idempotency_key, issued.challengeId);
    assert.equal(authAudit[1].idempotency_key, first.bindingId);
    assert.equal(authAudit[2].idempotency_key, authAudit[2].request_id);
    assert.equal(authAudit[2].http_request_id, activatedHttp.headers.get('x-request-id'));
    assert.ok(!JSON.stringify(authAudit).includes(credential));
    assert.ok(!JSON.stringify(authAudit).includes(issued.clientSession));

    await db.query("UPDATE access_credentials SET scopes='[]' WHERE token_hash=$1", [digest(credential)]);
    const historicCredentialScopes = (await db.query("SELECT credential_scopes FROM audit_events WHERE action='consent.revoke' AND object_id=$1", [intent.id])).rows[0];
    assert.deepEqual(historicCredentialScopes.credential_scopes, ['consent']);
    // Simulate a later administrative change; historical grants are snapshots.
    await db.query("UPDATE bindings SET scopes='[]' WHERE id=$1", [first.bindingId]);
    const snapshots = (await db.query('SELECT binding_scopes FROM audit_events WHERE binding_id=$1', [first.bindingId])).rows;
    assert.ok(snapshots.length >= 5);
    assert.ok(snapshots.every(row => JSON.stringify(row.binding_scopes) === JSON.stringify(['binding', 'consent'])));

    await assert.rejects(service.bind(response), /challenge_consumed/);
    now += 181;
    await assert.rejects(service.bind(response), /binding_proof_invalid/);
    assert.equal(JSON.stringify(logs).includes(credential), false);
    assert.equal(JSON.stringify(logs).includes('must-never-log'), false);
  } finally {
    if (http) { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
    await db.close();
  }
});
