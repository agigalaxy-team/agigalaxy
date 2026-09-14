import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createConsentClient } from '../src/consent-client.mjs';
import { postPublicJson } from '../src/public-fetch.mjs';
import { serviceFixture } from './service-fixture.mjs';

const endpoint = 'https://official.example.org';
const subjectId = 'GUID' + '0'.repeat(28);
const bindingId = randomUUID();
const intent = () => ({ version: 1, id: randomUUID(), subjectId, bindingId, endpoint,
  objectId: randomUUID(), action: 'case.teaser.publish', purpose: 'operational', recipient: endpoint,
  fields: ['title'], visibility: 'Private', viewers: [], payloadHash: 'a'.repeat(64),
  policyVersion: '0.1', issuedAt: 1000, expiresAt: 1500 });
const actor = () => ({ subjectId, bindingId, scopes: ['consent'], expiresAt: 1600, revoked: false,
  credential: randomBytes(32).toString('base64url') });

test('consent preview is inert and immutable; exact confirmation, cancellation and single dispatch are enforced', async () => {
  let reads = 0, signs = 0, sends = 0;
  let signed;
  const client = createConsentClient({ endpoint, now: () => 1000,
    readAuthorization: async () => { reads++; return actor(); },
    signIntent: async (json, typ) => { signs++; signed = { json, typ }; return 'synthetic-signature'; },
    send: async () => { sends++; const accepted = JSON.parse(signed.json);
      return { consentId: accepted.id, status: 'active', intent: accepted }; } });
  const input = intent(); const preview = client.prepare(input);
  input.fields.push('password'); input.recipient = 'foreign';
  assert.deepEqual([reads, signs, sends], [0, 0, 0]);
  assert.throws(() => { preview.intentJson = '{}'; });
  await assert.rejects(client.execute({ ...preview }, preview.confirmation), /Exact confirmation/);
  await assert.rejects(client.execute(preview, preview.confirmation + ' '), /Exact confirmation/);
  assert.deepEqual([reads, signs, sends], [0, 0, 0]);
  await client.execute(preview, preview.confirmation);
  assert.equal(signed.json, preview.intentJson);
  assert.equal(signed.typ, 'galaxy-consent+jws');
  assert.deepEqual(JSON.parse(signed.json).fields, ['title']);
  assert.deepEqual([reads, signs, sends], [3, 1, 1]);
  await assert.rejects(client.execute(preview, preview.confirmation), /Exact confirmation/);
  const canceled = client.prepare(intent()); client.cancel(canceled);
  await assert.rejects(client.execute(canceled, canceled.confirmation));
  assert.equal(sends, 1);
});

test('revocation or cancellation during signing prevents sending; uncertain failure is never retried', async () => {
  for (const action of ['revoke', 'cancel', 'expire', 'foreign']) {
    const current = actor();
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    let signs = 0, sends = 0, now = 1000;
    const client = createConsentClient({ endpoint, now: () => now, readAuthorization: async () => current,
      signIntent: async () => { signs++; started(); await new Promise(resolve => { release = resolve; }); return 'signature'; },
      send: async () => { sends++; } });
    const preview = client.prepare(intent()); const running = client.execute(preview, preview.confirmation);
    const rejected = assert.rejects(running);
    await ready;
    await assert.rejects(client.execute(preview, preview.confirmation));
    if (action === 'revoke') current.revoked = true;
    if (action === 'cancel') client.cancel(preview);
    if (action === 'expire') now = 1500;
    if (action === 'foreign') current.subjectId = 'GUID' + '1'.repeat(28);
    release(); await rejected;
    assert.deepEqual([signs, sends], [1, 0]);
  }
  let sends = 0;
  const client = createConsentClient({ endpoint, now: () => 1000, readAuthorization: async () => actor(),
    signIntent: async () => 'signature', send: async () => { sends++; throw new Error('unknown outcome'); } });
  const preview = client.prepare(intent());
  await assert.rejects(client.execute(preview, preview.confirmation), /unknown outcome/);
  await assert.rejects(client.execute(preview, preview.confirmation));
  assert.equal(sends, 1);
});

test('confirmed client signs a real service consent; server revocation still wins after local checks', async () => {
  const f = await serviceFixture(['binding', 'consent']);
  try {
    let revokeAtDispatch = false;
    const client = createConsentClient({ endpoint, now: () => f.now,
      readAuthorization: async () => ({ ...f.actor, credential: f.credential, revoked: false, expiresAt: f.now + 600 }),
      signIntent: f.signForTest,
      send: async (url, request) => {
        assert.equal(url, endpoint + '/v1/consents');
        if (revokeAtDispatch) await f.bindings.revoke(f.actor.bindingId, f.actor.subjectId, randomUUID(), null, f.actor);
        const authenticated = await f.access.authenticate(request.credential, 'consent');
        return f.consents.create(authenticated, JSON.parse(request.bodyJson).signedIntent);
      } });
    const input = { ...intent(), subjectId: f.actor.subjectId, bindingId: f.actor.bindingId,
      issuedAt: f.now, expiresAt: f.now + 500 };
    const preview = client.prepare(input);
    const result = await client.execute(preview, preview.confirmation);
    assert.equal(result.consentId, input.id);
    assert.equal(result.status, 'active');
    revokeAtDispatch = true;
    const next = client.prepare({ ...input, id: randomUUID() });
    await assert.rejects(client.execute(next, next.confirmation), /access_denied/);
    assert.equal((await f.db.query('SELECT count(*)::int AS count FROM consents')).rows[0].count, 1);
  } finally { await f.db.close(); }
});

test('public write gate rejects unsafe destinations, invalid credentials and pre-aborted requests', async () => {
  const options = { bodyJson: '{}', credential: actor().credential };
  for (const url of ['http://example.org/v1/consents', 'https://127.0.0.1/v1/consents',
    'https://user:secret@example.org/v1/consents', 'https://example.org/v1/consents?token=x']) {
    await assert.rejects(postPublicJson(url, options));
  }
  await assert.rejects(postPublicJson(endpoint, { ...options, credential: 'invalid' }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(postPublicJson(endpoint, { ...options, signal: controller.signal }));
});

test('consent response must preserve all confirmed fields; invalid acknowledgements never trigger a retry', async () => {
  const changes = [reply => ({ ...reply, consentId: randomUUID() }), reply => ({ ...reply, status: 'pending' }),
    reply => ({ ...reply, extra: true }), reply => ({ ...reply, intent: { ...reply.intent, recipient: 'other' } }),
    reply => ({ ...reply, intent: { ...reply.intent, fields: ['title', 'detail'] } }),
    reply => ({ ...reply, intent: { ...reply.intent, expiresAt: 9999 } }),
    reply => ({ ...reply, intent: { ...reply.intent, payloadHash: 'b'.repeat(64) } }),
    reply => ({ ...reply, intent: { ...reply.intent, subjectId: 'GUID' + '1'.repeat(28) } }),
    reply => ({ ...reply, intent: { ...reply.intent, visibility: 'Public' } }), () => null];
  for (const change of changes) {
    let sends = 0;
    const input = intent();
    const client = createConsentClient({ endpoint, now: () => 1000, readAuthorization: async () => actor(),
      signIntent: async () => 'signature', send: async () => {
        sends++; return change({ consentId: input.id, status: 'active', intent: input });
      } });
    const preview = client.prepare(input);
    await assert.rejects(client.execute(preview, preview.confirmation), /response mismatch/);
    await assert.rejects(client.execute(preview, preview.confirmation));
    assert.equal(sends, 1);
  }
});

test('an exact response received after local revocation or expiry is not surfaced as success', async () => {
  for (const condition of ['revoke', 'expire']) {
    const current = actor(); let now = 1000;
    const input = intent();
    const client = createConsentClient({ endpoint, now: () => now, readAuthorization: async () => current,
      signIntent: async () => 'signature', send: async () => {
        if (condition === 'revoke') current.revoked = true;
        else now = input.expiresAt;
        return { consentId: input.id, status: 'active', intent: input };
      } });
    const preview = client.prepare(input);
    await assert.rejects(client.execute(preview, preview.confirmation));
  }
});
