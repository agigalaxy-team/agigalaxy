import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

// Runs against an explicitly selected private HTTP service. The production
// public HTTPS transport is not replaced or weakened. All identity material is
// generated separately by the caller in a disposable synthetic-client directory.
export async function verifyConnectionAcceptance({ address, endpoint, directory, db, modules, trustedKeys, onProgress = () => {} }) {
  const location = new URL(address);
  assert.equal(location.protocol, 'http:');assert.equal(location.hostname, '127.0.0.1');
  const identityBefore = await readFile(join(directory, 'galaxy-id.json'));
  const identity = JSON.parse(identityBefore);
  const tests = {}, statuses = {}, now = () => Math.floor(Date.now() / 1000);
  let calls = 0, credential = null, originalBindingRequest = null;
  const counts = async () => Object.fromEntries(await Promise.all(['cases', 'case_events', 'consents', 'proofs', 'context_grants'].map(async table =>
    [table, Number((await db.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count)])));
  const before = await counts();
  async function raw(path, body, token = null) {
    calls++;
    const response = await fetch(address + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + String(token) } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  }
  const manifest = (await raw('/.well-known/galaxy-network.json')).body;
  const opened = await modules.verifyNetworkManifest(manifest, { endpoint, trustedKeys, networkType: 'official', now: now() });
  assert.deepEqual([...opened.data.capabilities].sort((a, b) => a.localeCompare(b)), ['binding', 'docs-mcp', 'sessions']);
  tests.connectionOnlyManifestVerified = true;
  const foreign = generateKeyPairSync('ed25519');
  let bindingChallengeChecked = false;
  const send = async (url, options) => {
    assert.equal(new URL(url).origin, endpoint);
    const path = new URL(url).pathname, body = options.bodyJson === undefined ? undefined : JSON.parse(options.bodyJson);
    if (options.credential) credential = options.credential;
    if (path === '/v1/binding-challenges' && !bindingChallengeChecked) {
      bindingChallengeChecked = true;
      const wrong = await raw(path, { ...body, genesisProof: { ...body.genesisProof, publicKeyPem: foreign.publicKey.export({ type: 'spki', format: 'pem' }) } });
      assert.equal(wrong.status, 400);statuses.mismatchedIdAndKey = wrong.status;
    }
    if (path === '/v1/bindings' && !originalBindingRequest) {
      originalBindingRequest = structuredClone(body);
      const wrongSignature = await new modules.CompactSign(Buffer.from(body.challenge)).setProtectedHeader({ alg: 'Ed25519', typ: 'galaxy-binding-response+jws' }).sign(foreign.privateKey);
      const parts = body.challenge.split('.'), claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
      claims.aud = 'https://different.example.org';parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url');
      for (const [name, changed] of [['wrongSigner', { signature: wrongSignature }], ['wrongClientSession', { clientSession: 'a'.repeat(43) }], ['wrongAudience', { challenge: parts.join('.') }]]) {
        const denied = await raw(path, { ...body, ...changed });assert.equal(denied.status, 401);statuses[name] = denied.status;
      }
      const results = await Promise.all([raw(path, body), raw(path, body)]);
      assert.ok(results.every(result => result.status === 200));assert.deepEqual(results[0].body, results[1].body);
      tests.concurrentRetryReturnsOneReceipt = true;
      return results[0].body;
    }
    const result = await raw(path, body, options.credential);
    if (result.status >= 400) {
      const error = new Error('Private service rejected the request');
      if ([401, 403].includes(result.status)) error.code = 'GALAXY_REMOTE_REJECTED';
      throw error;
    }
    return result.body;
  };
  const runtimeFor = (scopes, document = manifest) => modules.createLocalHostRuntime({
    dataDirectory: directory, endpoint, installationId: randomUUID(), bindingScopeId: 'binding-intent', scopes, trustedKeys, manifest: document,
    connectionSend: send, statusSend: send, bindingManagementSend: send, historySend: send, caseSend: send, caseRead: send, consentSend: send,
  });
  const broken = structuredClone(manifest), parts = broken.signed.split('.');
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);broken.signed = parts.join('.');
  const invalid = runtimeFor(['binding', 'history'], broken), beforeInvalid = calls;
  try { await assert.rejects(invalid.controller.prepare());assert.equal(calls, beforeInvalid); }
  finally { invalid.close(); }
  tests.changedManifestRejectedBeforeNetwork = true;
  const runtime = runtimeFor(['binding', 'history']);
  let firstBindingId;
  try {
    onProgress('local-preview-and-binding');
    const beforePrepare = calls;
    const canceled = await runtime.controller.prepare();runtime.controller.cancel();
    await assert.rejects(runtime.controller.execute(canceled, canceled.confirmation));
    const wrong = await runtime.controller.prepare();await assert.rejects(runtime.controller.execute(wrong, 'wrong confirmation'));
    assert.equal(calls, beforePrepare);
    const preview = await runtime.controller.prepare();
    assert.equal(JSON.parse(preview.requestJson).subjectId, identity.id);assert.equal(preview.endpoint, endpoint);
    const status = await runtime.controller.execute(preview, preview.confirmation);
    assert.equal(status.state, 'session-local');firstBindingId = status.bindingId;
    assert.equal((await runtime.controller.checkRemote()).state, 'binding-verified');
    const page = await runtime.controller.queryBindings({});assert.equal(page.items.length, 1);
    assert.equal(page.items[0].bindingId, firstBindingId);
    assert.equal((await runtime.controller.queryHistory({ query: 'synthetic acceptance ' + randomUUID() })).items.length, 0);
    assert.equal(Number((await db.query('SELECT count(*) AS count FROM bindings WHERE subject_id=$1', [identity.id])).rows[0].count), 1);
    assert.equal(Number((await db.query("SELECT count(*) AS count FROM audit_events WHERE object_id=$1 AND action='binding.create'", [firstBindingId])).rows[0].count), 1);
    tests.existingIdentityPreviewSignedBindingAndQuery = true;
    onProgress('binding-does-not-authorize-publication');
    const payloads = {
      '/v1/cases': { id: randomUUID(), kind: 'case', localRef: randomUUID(), title: 'Synthetic no-authority Case', summary: 'Must remain local',
        source: { kind: 'local', reference: randomUUID() }, participants: [{ subjectId: identity.id, role: 'requester' }] },
      '/v1/proofs': { id: randomUUID(), evidenceId: randomUUID(), preparedAt: now() },
      '/v1/context-grants': { id: randomUUID(), assistanceId: randomUUID(), caseId: randomUUID(), participantId: identity.id,
        scope: 'Synthetic selected excerpt', scopeEventId: randomUUID(), expiresAt: now() + 300,
        materials: [{ id: randomUUID(), label: 'Fixture', mediaType: 'text/plain', content: 'Synthetic test excerpt' }] },
    };
    for (const [path, payload] of Object.entries(payloads)) {
      const result = await raw(path, { consentId: randomUUID(), payloadJson: JSON.stringify(payload) }, credential);
      assert.equal(result.status, 401, path);statuses[path] = result.status;
    }
    assert.deepEqual(await counts(), before);tests.bindingWithoutPublicationScopesCannotWrite = true;
    onProgress('confirmed-revocation');
    const savedCredential = credential;
    const revoke = await runtime.controller.prepareBindingRevoke(firstBindingId);
    assert.equal(revoke.currentSession, true);
    const result = await runtime.controller.executeBindingRevoke(revoke, revoke.confirmation);
    assert.equal(result.state, 'revoked');assert.equal(result.currentSessionEnded, true);
    assert.equal((await raw('/v1/bindings/' + firstBindingId, undefined, savedCredential)).status, 401);
    assert.equal((await raw('/v1/bindings', originalBindingRequest)).status, 409);
    await assert.rejects(runtime.controller.queryHistory({ query: 'after revoke' }));
    tests.revocationBlocksOldSessionAndConsumedChallenge = true;
  } finally { runtime.close();credential = null; }
  const second = runtimeFor(['binding', 'history', 'case-teaser']);
  try {
    onProgress('scope-is-not-object-consent');
    const preview = await second.controller.prepare();await second.controller.execute(preview, preview.confirmation);
    await second.controller.checkRemote();
    const payload = { kind: 'case', id: randomUUID(), localRef: randomUUID(), title: 'Scope without Consent', summary: 'Synthetic denied publication',
      source: { kind: 'local', reference: randomUUID() }, participants: [{ subjectId: identity.id, role: 'requester' }] };
    const denied = await raw('/v1/cases', { consentId: randomUUID(), payloadJson: JSON.stringify(payload) }, credential);
    assert.equal(denied.status, 403);statuses.caseScopeWithoutConsent = denied.status;
    assert.deepEqual(await counts(), before);tests.caseScopeWithoutObjectConsentCannotWrite = true;
    const state = await second.controller.status(), revoke = await second.controller.prepareBindingRevoke(state.bindingId);
    await second.controller.executeBindingRevoke(revoke, revoke.confirmation);
  } finally { second.close();credential = null; }
  const draft = await modules.createCaseDraft(directory, { title: 'Offline after revocation', failureSummary: 'Synthetic local workflow remains available' });
  assert.equal(draft.localOnly, true);
  assert.deepEqual(await readFile(join(directory, 'galaxy-id.json')), identityBefore);
  assert.deepEqual(await counts(), before);
  tests.identityPreservedAndLocalCaseContinues = true;
  return { tests, statuses, httpRequests: calls, schema: (await db.query('SELECT max(version) AS version FROM schema_migrations')).rows[0].version,
    originalBusinessCounts: before, finalBusinessCounts: await counts(), syntheticOnly: true,
    nativeHostUiVerified: false, publicHttpsVerified: false, fixtureBindingsRetainedRevoked: 2 };
}
