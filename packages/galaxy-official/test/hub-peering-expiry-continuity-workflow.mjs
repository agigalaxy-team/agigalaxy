import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { serviceFixture } from './service-fixture.mjs';
import { prepareHub, hubScopes } from './hub-peering-workflow.mjs';
import { createPeeringProof } from './hub-ci-proof-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { digest } from '../src/shared/digest.mjs';
import { createSigningService } from "../src/security/signing-service.mjs";

export async function createPeeringExpiryFixture() {
  const now = Math.floor(Date.now() / 1000), a = await serviceFixture(hubScopes, null,
    { now, endpoint: 'https://expiry-a.example' }), apis = [];
  let b, currentTime = now;
  const close = async () => {
    for (const api of apis) await new Promise(ok => api.close(ok));
    await a.db.close(); if (b) await b.db.close();
  };
  try {
    b = await serviceFixture(hubScopes, null, { now, endpoint: 'https://expiry-b.example' });
    for (const f of [a, b]) {
      // The ordinary fixture clock is fixed. This isolated selected peering key
      // uses the production signer and a shared mutable clock for expiry tests.
      const key = generateKeyPairSync('ed25519');
      f.access.trustedKeys.set('expiry-peering', { publicKeyPem: key.publicKey.export({ type: 'spki', format: 'pem' }),
        notBefore: now - 1, notAfter: now + 200000, revoked: false });
      f.peering.sign = createSigningService({ endpoint: f.access.endpoint, signingKey: key.privateKey,
        kid: 'expiry-peering', trustedKeys: f.access.trustedKeys, now: () => currentTime }, ['hub-peering']).sign;
      const api = createApi(f); await new Promise(ok => api.listen(0, '127.0.0.1', ok)); apis.push(api);
      f.testAddress = `http://127.0.0.1:${api.address().port}`;
    }
    const call = async (f, path, input, who = f, expectedStatus = 200) => {
      const response = await fetch(f.testAddress + path, { method: 'POST', headers: {
        'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.credential}` } : {})
      }, body: JSON.stringify(input) });
      const body = await response.json(); assert.equal(response.status, expectedStatus,
        JSON.stringify({ error: body.error ?? null, itemCount: body.items?.length ?? null })); return body;
    };
    const ah = await prepareHub(a), bh = await prepareHub(b);
    const party = (f, hubId) => ({ endpoint: f.access.endpoint, hubId, operatorId: f.actor.subjectId,
      keys: [...f.access.trustedKeys].map(([kid, pin]) => ({ kid, publicKeyPem: pin.publicKeyPem,
        notBefore: pin.notBefore, notAfter: pin.notAfter })) });
    const agreement = { profile: 'galaxy-direct-proof/1', id: randomUUID(), version: 1,
      parties: [party(a, ah), party(b, bh)], sourceKinds: ['ci-proof-v2', 'contribution-summary'],
      purpose: 'help-discovery', ratePerMinute: 60, pageSize: 2, expiresAt: now + 1800,
      responseMaxAgeSeconds: 120, cache: 'no-response-body-retention', route: 'direct', officialProtocolFee: 0,
      localEvaluationAuthority: 'no-automatic-capability-upgrade', rawTaskContext: 'excluded', intake: 'each-party-hub-private-intake' };
    for (const [f, hubId] of [[a, ah], [b, bh]]) await call(f, '/v2/hubs/peering/events',
      await f.authorize({ schemaVersion: 2, id: randomUUID(), kind: 'peer-approve', hubId, expectedVersion: 0, agreement }, 'hub.publish'));
    let lastSignedResponse = null, remoteCalls = 0;
    a.peering.send = async (_url, { bodyJson }) => {
      remoteCalls++;
      const response = await call(b, '/v2/hubs/peering/exchange', JSON.parse(bodyJson), null);
      lastSignedResponse = response.signed; return response;
    };
    const rootId = randomUUID(), root = { schemaVersion: 2, eventId: rootId, caseId: rootId, kind: 'case-created',
      expectedVersion: 0, actorId: b.actor.subjectId, localRef: randomUUID(), title: 'Synthetic expiry workflow',
      summary: 'PRIVATE_NOT_FOR_PEERING', source: { kind: 'local', reference: randomUUID() }, synthetic: true };
    await b.cases.submitV2(b.actor, await b.authorize(root, 'case.teaser.publish', { objectId: rootId }));
    const intervention = { schemaVersion: 2, eventId: randomUUID(), caseId: rootId, kind: 'intervention',
      expectedVersion: 1, actorId: b.actor.subjectId, types: ['diagnosis'], affectsAttemptIds: [],
      description: 'PRIVATE_DIAGNOSIS', sourceRefs: [], observedEffect: 'Only an isolated protocol measurement' };
    const factAuth = await b.authorize(intervention, 'case.teaser.publish', { objectId: intervention.eventId });
    await b.cases.submitV2(b.actor, factAuth);
    const proof = await createPeeringProof(b, root, intervention);
    const sources = [proof.source, { kind: 'contribution-summary', source: { kind: 'case-event', id: intervention.eventId,
      eventVersion: 1, payloadHash: digest(factAuth.payloadJson) }, fields: ['eventType', 'actorId'] }];
    const grants = [];
    for (let i = 0; i < sources.length; i++) {
      const grant = { schemaVersion: 2, id: randomUUID(), hubId: bh, kind: 'source-grant', agreementId: agreement.id,
        agreementVersion: 1, source: sources[i], requesterIds: [a.actor.subjectId], expiresAt: now + 5 + i * 2,
        purpose: 'selected-peering-read-only', disclosure: 'exact-proof-or-selected-nonnarrative-contribution-fields', redactionConfirmed: true };
      await call(b, '/v2/hubs/peering/events', await b.authorize(grant, 'hub.publish')); grants.push(grant);
    }
    return { a, b, now, ah, bh, agreement, grants, proof, root, intervention, call, close,
      clock: time => { currentTime = time; for (const f of [a, b]) { f.access.now = () => time; f.peering.now = () => time; } },
      query: (overrides = {}, status = 200) => call(a, '/v2/hubs/peering/query',
        { hubId: ah, agreementId: agreement.id, queryId: randomUUID(), ...overrides }, a, status),
      signedResponse: () => lastSignedResponse, remoteCalls: () => remoteCalls };
  } catch (error) { await close(); throw error; }
}

export async function verifyPeeringProjectionExpiry() {
  const f = await createPeeringExpiryFixture();
  try {
    const before = await f.query(), proof = before.items.find(i => i.grantId === f.grants[0].id),
      summary = before.items.find(i => i.grantId === f.grants[1].id), signed = decodeJwt(f.signedResponse());
    assert.equal(proof.expiresAt, f.grants[0].expiresAt, 'the original proof expiry must not replace the selected grant expiry');
    assert.equal(summary.expiresAt, f.grants[1].expiresAt);
    assert.equal(before.expiresAt, f.grants[0].expiresAt);
    assert.equal(signed.data.expiresAt, before.expiresAt); assert.equal(signed.exp, before.expiresAt);
    assert.equal(proof.signed, f.proof.published.signed, 'the original proof envelope is unchanged');
    assert.equal(proof.sourceObject.payloadHash, f.proof.source.payloadHash);
    for (const secret of [f.root.summary, f.intervention.description]) assert.equal(JSON.stringify(before).includes(secret), false);
    assert.equal(before.capabilityVerified, false); assert.equal(before.responseBodyPersisted, false);

    f.clock(f.now + 5); // Exact deadline: the earlier item cannot be labelled current.
    const after = await f.query({ after: before.nextCursor, recheck: f.grants.map(g => g.id) });
    assert.deepEqual(after.items.find(i => i.grantId === proof.grantId), { grantId: proof.grantId, state: 'unavailable' });
    assert.equal(after.items.find(i => i.grantId === summary.grantId).state, 'current');
    assert.equal(after.expiresAt, summary.expiresAt, 'unavailable items have no old display deadline');

    await f.call(f.b, '/v2/hubs/peering/events', await f.b.authorize({ schemaVersion: 2, id: randomUUID(), hubId: f.bh,
      kind: 'source-revoke', grantId: summary.grantId }, 'hub.publish'));
    const revoked = await f.query({ after: after.nextCursor, recheck: f.grants.map(g => g.id) });
    assert.ok(revoked.items.every(i => i.state === 'unavailable' && Object.keys(i).sort().join(',') === 'grantId,state'));
    assert.equal(revoked.expiresAt, f.now + 5 + 120, 'body-free unavailable items cannot expire the whole page in the past');
    const empty = await f.query({ after: revoked.nextCursor }); assert.deepEqual(empty.items, []);
    assert.equal(empty.expiresAt, f.now + 5 + 120);
    const ownGrant = await f.call(f.b, '/v2/hubs/peering/receipt', { operationId: f.grants[0].id,
      payloadHash: digest(JSON.stringify(f.grants[0])) });
    assert.equal(ownGrant.state, 'recorded', 'expiry does not erase the original accepted operation');
    return { proofGrantSeconds: 5, summaryGrantSeconds: 7, proofBytesPreserved: true,
      expiredSourceWithheld: true, revokedSourceWithheld: true, unavailableAndEmptyRemainBounded: true };
  } finally { await f.close(); }
}

export async function verifyPeeringForeignDisplayDeadline() {
  const f = await createPeeringExpiryFixture();
  try {
    const actual = f.b.peering.exchange.bind(f.b.peering);
    let envelopeTtl = 120;
    f.b.peering.exchange = async input => {
      const original = await actual(input), jwt = decodeJwt(original.signed);
      // A selected peer may use an older outer page window. Its signature is
      // still verified; the consumer derives a narrower local display deadline.
      const data = { ...jwt.data, expiresAt: f.now + 120 };
      return { signed: await f.b.peering.sign('hub-peering', data, jwt.jti, envelopeTtl) };
    };
    const result = await f.query(); assert.equal(decodeJwt(f.signedResponse()).data.expiresAt, f.now + 120);
    assert.equal(result.expiresAt, f.now + 5, 'a long signed page window cannot extend a selected item');
    assert.equal(result.items.find(i => i.grantId === f.grants[0].id).signed, f.proof.published.signed);
    envelopeTtl = 2;
    const shorter = await f.query(); assert.equal(decodeJwt(f.signedResponse()).exp, f.now + 2);
    assert.equal(shorter.expiresAt, f.now + 2, 'the outer signing envelope also limits the local display window');
    assert.equal(f.remoteCalls(), 2); return { itemDeadlineClamped: true, actualOuterSignatureDeadlineClamped: true };
  } finally { await f.close(); }
}

export async function verifyPeeringLateExpiryWithheld() {
  const f = await createPeeringExpiryFixture();
  try {
    const validate = f.a.peering.validateResponse.bind(f.a.peering);
    f.a.peering.validateResponse = async (...args) => {
      const value = await validate(...args); f.clock(f.now + 5); return value;
    };
    const queryId = randomUUID(), failure = await f.query({ queryId }, 409);
    assert.equal(failure.error, 'peering_response_expired'); assert.equal(failure.items, undefined);
    const row = (await f.a.db.query('SELECT state,response_hash FROM hub_peering_receipts_v2 WHERE query_id=$1 AND side=$2',
      [queryId, 'outgoing'])).rows[0];
    assert.equal(row.state, 'unknown'); assert.equal(row.response_hash, null);
    assert.equal(f.remoteCalls(), 1, 'late expiry neither resends nor invents a canceled remote query');
    return { expiryAfterValidationWithheld: true, originalQueryUnknownWithoutResend: true };
  } finally { await f.close(); }
}

export async function verifyPeeringInnerSignatureDeadline() {
  const f = await createPeeringExpiryFixture();
  try {
    const actual = f.b.peering.exchange.bind(f.b.peering);
    f.b.peering.exchange = async input => {
      const response = await actual(input), outer = decodeJwt(response.signed), items = [];
      for (const item of outer.data.items) {
        if (item.sourceObject?.kind !== 'ci-proof-v2') { items.push(item); continue; }
        const original = decodeJwt(item.signed);
        // Same data/hash/id and a currently selected issuer pin. The actual
        // signature can expire sooner than its data and selected grant.
        const signed = await f.b.ciV2.sign('proof', original.data, original.jti, 2);
        items.push({ ...item, signed });
      }
      return { signed: await f.b.peering.sign('hub-peering', { ...outer.data, items }, outer.jti, outer.exp - f.now) };
    };
    const result = await f.query(), item = result.items.find(i => i.sourceObject?.kind === 'ci-proof-v2'),
      inner = decodeJwt(item.signed), outer = decodeJwt(f.signedResponse()),
      sentItem = outer.data.items.find(i => i.grantId === item.grantId);
    assert.equal(inner.exp, f.now + 2); assert.equal(inner.data.expiresAt, f.now + 3600);
    assert.equal(sentItem.expiresAt, f.now + 5, 'the peer-signed projection is not rewritten locally');
    assert.equal(outer.data.expiresAt, f.now + 5);
    assert.equal(item.expiresAt, inner.exp, 'the local current item must respect its actual signature deadline');
    assert.equal(result.expiresAt, inner.exp, 'the page must respect its shortest current item signature');
    assert.equal(item.signed, sentItem.signed); assert.equal(item.sourceObject.payloadHash, f.proof.source.payloadHash);
    assert.equal(decodeJwt(item.signed).jti, decodeJwt(f.proof.published.signed).jti);
    assert.equal((await f.b.db.query('SELECT signed FROM ci_proofs_v2 WHERE id=$1', [f.proof.source.id])).rows[0].signed,
      f.proof.published.signed, 'the original stored proof remains byte-for-byte unchanged');
    assert.equal(JSON.stringify(result).includes(f.root.summary), false);
    assert.equal(JSON.stringify(result).includes(f.intervention.description), false);

    const validate = f.a.peering.validateResponse.bind(f.a.peering);
    f.a.peering.validateResponse = async (...args) => {
      const value = await validate(...args); f.clock(inner.exp); return value;
    };
    const queryId = randomUUID(), failure = await f.query({ queryId }, 409);
    assert.equal(failure.error, 'peering_response_expired'); assert.equal(failure.items, undefined);
    const row = (await f.a.db.query('SELECT state,response_hash FROM hub_peering_receipts_v2 WHERE query_id=$1 AND side=$2',
      [queryId, 'outgoing'])).rows[0];
    assert.equal(row.state, 'unknown'); assert.equal(row.response_hash, null);
    assert.equal(f.remoteCalls(), 2, 'final expiry neither resends nor claims remote cancellation');
    return { actualSignedDoubleHttp: true, sourceGrantSeconds: 5, originalDataSeconds: 3600,
      actualItemSignatureSeconds: 2, itemDisplaySeconds: 2, pageDisplaySeconds: 2,
      signedProjectionUnchanged: true, originalStoredProofUnchanged: true, lateInnerExpiryWithheld: true,
      privateBodyIncluded: false, actualBrowser: false, databases: 'two PGlite', syntheticCi: true };
  } finally { await f.close(); }
}
