import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { verifyBindingChallenge, verifyBindingReceipt, verifySessionChallenge, verifySessionActivation } from '../src/verification/connection.mjs';

test('connection verifiers bind genuine signed challenges, receipts and sessions to the exact local request', async () => {
  const f = await serviceFixture(['binding', 'consent']);
  try {
    const context = { endpoint: f.bindings.endpoint, trustedKeys: f.bindings.trustedKeys, now: f.now };
    const request = { subjectId: f.genesis.id, genesisProof: f.genesis.genesisProof,
      installationId: randomUUID(), scopes: ['binding', 'consent'] };
    const response = await f.bindings.challenge(request);
    const challenge = await verifyBindingChallenge(response, { ...context, request });
    for (const changed of [{ ...request, scopes: ['binding'] }, { ...request, installationId: randomUUID() }]) {
      await assert.rejects(verifyBindingChallenge(response, { ...context, request: changed }), /mismatch/);
    }
    await assert.rejects(verifyBindingChallenge({ ...response, clientSession: randomBytes(32).toString('base64url') },
      { ...context, request }), /mismatch/);
    const bound = await f.bindings.bind({ challenge: response.challenge, clientSession: response.clientSession,
      signature: await f.signForTest(response.challenge, 'galaxy-binding-response+jws') });
    const binding = await verifyBindingReceipt(bound, { ...context, challenge });
    const credentialHash = createHash('sha256').update(randomBytes(32)).digest('hex');
    const sessionResponse = await f.access.challenge({ bindingId: bound.bindingId, credentialHash });
    const session = await verifySessionChallenge(sessionResponse, { ...context, binding, credentialHash });
    const activated = await f.access.activate({ ...sessionResponse,
      signature: await f.signForTest(sessionResponse.challenge, 'galaxy-session-response+jws') });
    assert.deepEqual(verifySessionActivation(activated, { challenge: session, now: f.now }), activated);
    assert.throws(() => verifySessionActivation({ ...activated, scopes: ['binding', 'consent', 'proof'] },
      { challenge: session, now: f.now }), /mismatch/);
    assert.throws(() => verifySessionActivation({ ...activated, expiresAt: activated.expiresAt + 1 },
      { challenge: session, now: f.now }), /mismatch/);
    assert.throws(() => verifySessionActivation(activated, { challenge: session, now: session.expiresAt }), /mismatch/);

    // These mutations carry valid server signatures. User expectations, not
    // signature validity alone, must reject expanded or unrelated authority.
    for (const delta of [{ scopes: ['binding', 'consent', 'proof'] }, { bindingExpiresAt: f.now + 86401 }]) {
      const changed = await f.bindings.sign('binding-challenge', { ...challenge.data, ...delta }, challenge.id, 180);
      await assert.rejects(verifyBindingChallenge({ ...response, challenge: changed }, { ...context, request }), /mismatch/);
    }
    for (const delta of [{ auditReference: randomUUID() }, { publicKeyFingerprint: '0'.repeat(64) },
      { revokePath: '/different' }, { scopes: ['binding', 'consent', 'proof'] }]) {
      const receipt = await f.bindings.sign('binding-receipt', { ...binding.data, ...delta }, binding.id, 86400);
      await assert.rejects(verifyBindingReceipt({ ...bound, receipt }, { ...context, challenge }), /mismatch/);
    }
    for (const delta of [{ credentialHash: '0'.repeat(64) }, { scopes: ['binding', 'consent', 'proof'] },
      { bindingId: randomUUID() }, { credentialExpiresAt: f.now + 601 }]) {
      const token = await f.access.sign('session-challenge', { ...session.data, ...delta }, session.id, 120);
      await assert.rejects(verifySessionChallenge({ challenge: token }, { ...context, binding, credentialHash }), /mismatch/);
    }
    context.trustedKeys.get('fixture').revoked = true;
    await assert.rejects(verifyBindingReceipt(bound, { ...context, challenge }));
    await assert.rejects(verifySessionChallenge(sessionResponse, { ...context, binding, credentialHash }));
  } finally { await f.db.close(); }
});
