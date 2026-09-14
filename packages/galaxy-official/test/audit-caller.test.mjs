import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { digest } from '../src/shared/digest.mjs';

test('cross-binding audit separates executing installation from target consent and binding', async () => {
  const f = await serviceFixture();
  try {
    const targetBinding = f.actor.bindingId;
    const targetClient = (await f.db.query('SELECT payload FROM binding_challenges WHERE id=(SELECT challenge_id FROM bindings WHERE id=$1)', [targetBinding])).rows[0].payload.installationId;
    const callerClient = randomUUID();
    const issued = await f.bindings.challenge({ subjectId: f.genesis.id, genesisProof: f.genesis.genesisProof,
      installationId: callerClient, scopes: ['binding', 'consent', 'case-teaser'] });
    const callerBinding = (await f.bindings.bind({ challenge: issued.challenge, clientSession: issued.clientSession,
      signature: await f.signForTest(issued.challenge, 'galaxy-binding-response+jws') })).bindingId;
    const token = randomBytes(32).toString('base64url');
    const session = await f.access.challenge({ bindingId: callerBinding, credentialHash: digest(token) });
    await f.access.activate({ ...session, signature: await f.signForTest(session.challenge, 'galaxy-session-response+jws') });
    const actor = { ...await f.access.authenticate(token), callerBindingId: targetBinding, installationId: 'forged-client' };
    const event = { id: randomUUID(), kind: 'case', localRef: 'cross-binding', title: 'Synthetic cross binding', summary: 'Fixture only',
      source: { kind: 'local', reference: 'fixture' }, participants: [{ subjectId: actor.subjectId, role: 'requester' }] };
    const grant = await f.authorize(event);
    await f.cases.submit(actor, grant);
    await f.consents.revoke(actor, grant.consentId);
    await f.bindings.revoke(targetBinding, actor.subjectId, randomUUID(), null, actor);
    const rows = (await f.db.query("SELECT * FROM audit_events WHERE action IN ('case.case','consent.revoke','binding.revoke')")).rows;
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.binding_id, targetBinding);
      assert.equal(row.client_id, targetClient);
      assert.equal(row.caller_binding_id, callerBinding);
      assert.equal(row.caller_client_id, callerClient);
      assert.equal(row.caller_audience, f.bindings.endpoint);
      assert.deepEqual(row.caller_binding_scopes, ['binding', 'consent', 'case-teaser']);
      assert.deepEqual(row.credential_scopes, ['binding', 'consent', 'case-teaser']);
    }
    await f.db.query("UPDATE binding_challenges SET payload=jsonb_set(payload,'{installationId}',$1::jsonb) WHERE id=(SELECT challenge_id FROM bindings WHERE id=$2)", [JSON.stringify('changed-client'), callerBinding]);
    await f.db.query("UPDATE bindings SET scopes='[]' WHERE id=$1", [callerBinding]);
    const historical = (await f.db.query("SELECT caller_client_id,caller_binding_scopes FROM audit_events WHERE action='case.case'")).rows[0];
    assert.equal(historical.caller_client_id, callerClient);
    assert.deepEqual(historical.caller_binding_scopes, ['binding', 'consent', 'case-teaser']);
    assert.ok(!JSON.stringify(rows).includes(token));
    assert.ok(!JSON.stringify(rows).includes(digest(token)));
  } finally { await f.db.close(); }
});
