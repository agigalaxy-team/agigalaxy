import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createPrivateKey } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { initializeGalaxyIntegration } from '../../galaxy-core/src/local-store.mjs';
import { createConnectionProfile, saveConnectionProfile, revokeConnectionScope } from '../../galaxy-core/src/connection-profile.mjs';
import { createLocalHostRuntime } from "../../galaxy-official/src/clients/local/host-runtime.mjs";
import { serviceFixture } from '../../galaxy-official/test/service-fixture.mjs';
import { a2aHostFactory } from '../src/hosts/host-flow.mjs';
import { hash } from '../src/storage/journal.mjs';
import { sdkPeer } from './sdk-peer.mjs';
const { CompactSign } = createRequire(new URL('../../galaxy-official/package.json', import.meta.url))('jose');

test('actual local runtime signs A2A import, survives lost receipt/restart and cancels host operations', { timeout: 120000 }, async t => {
  const f = await serviceFixture(); t.after(() => f.db.close());
  const peer = await sdkPeer(); t.after(() => peer.close());
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-a2a-host-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await initializeGalaxyIntegration(directory, { profile: 'coding-case', source: 'test' });
  const endpoint = f.bindings.endpoint;
  const profile = createConnectionProfile({ targets: [{ id: 'official', kind: 'official', endpoint }], scopes: [
    { id: 'bind', targetId: 'official', action: 'binding', recipient: endpoint, purpose: 'Fixture connection',
      visibleFields: ['subjectId', 'genesisProof', 'installationId', 'scopes'], expiresAt: new Date((f.now + 90000) * 1000).toISOString() }] });
  await saveConnectionProfile(directory, profile);
  let actor, loseReceipt = false, externalPrincipal = 'external-fixture-user', consentWrites = 0, caseWrites = 0;
  const config = { dataDirectory: directory, endpoint, installationId: randomUUID(), scopes: ['binding', 'consent', 'case-teaser'],
    bindingScopeId: 'bind', trustedKeys: f.bindings.trustedKeys, manifest: (await f.manifest.get()).document, now: () => f.now,
    connectionSend: async (url, { bodyJson }) => {
      const body = JSON.parse(bodyJson);
      const handlers = { '/v1/binding-challenges': () => f.bindings.challenge(body), '/v1/bindings': () => f.bindings.bind(body),
        '/v1/session-challenges': () => f.access.challenge(body), '/v1/sessions': () => f.access.activate(body) };
      return handlers[new URL(url).pathname]();
    },
    caseRead: async (url, { credential }) => { actor = await f.access.authenticate(credential); return f.cases.get(actor, new URL(url).pathname.split('/').at(-1)); },
    consentSend: async (_url, { credential, bodyJson }) => {
      consentWrites++; return f.consents.create(await f.access.authenticate(credential), JSON.parse(bodyJson).signedIntent);
    },
    caseSend: async (_url, { credential, bodyJson }) => {
      caseWrites++; const receipt = await f.cases.submit(await f.access.authenticate(credential), JSON.parse(bodyJson));
      if (loseReceipt) throw new Error('Synthetic lost Case response');
      return receipt;
    },
    a2aHostFactory: a2aHostFactory({ peers: [{ id: 'peer', name: 'Fixture peer', endpoint: peer.endpoint, tenant: 'fixture',
      peerPrincipal: 'external-fixture-user', agentCard: peer.card }], post: (...args) => peer.post(...args),
      readPeerAuthorization: async (target, subjectId) => {
        assert.deepEqual(Object.keys(target).sort(), ['endpoint', 'id', 'peerPrincipal', 'tenant']);
        assert.match(subjectId, /^GUID/);
        return { peerPrincipal: externalPrincipal, credential: 'synthetic-external-token' };
      } }),
  };
  let runtime = createLocalHostRuntime(config); t.after(() => runtime.close());
  async function connect() { const preview = await runtime.controller.prepare(); return runtime.controller.execute(preview, preview.confirmation); }
  let status = await connect();
  await assert.rejects(runtime.controller.getCase(randomUUID())); // capture the synthetic authenticated actor
  const keyPath = join(directory, 'galaxy-id-private-key.pem');
  const keyBytes = await readFile(keyPath); const keyHash = hash(keyBytes);
  const signingKey = createPrivateKey(keyBytes);
  async function seed(event) {
    const payloadJson = JSON.stringify(event), intent = { version: 1, id: randomUUID(), subjectId: status.subjectId, bindingId: status.bindingId,
      endpoint, objectId: event.id, action: 'case.teaser.publish', purpose: 'operational', recipient: endpoint, fields: Object.keys(event),
      visibility: 'Private', viewers: [], payloadHash: hash(payloadJson), policyVersion: '0.1', issuedAt: f.now, expiresAt: f.now + 3600 };
    const signed = await new CompactSign(Buffer.from(JSON.stringify(intent))).setProtectedHeader({ alg: 'Ed25519', typ: 'galaxy-consent+jws' }).sign(signingKey);
    await f.consents.create(actor, signed);
    return f.cases.submit(actor, { consentId: intent.id, payloadJson });
  }
  async function start(text) {
    const caseId = randomUUID(), attemptId = randomUUID();
    await seed({ kind: 'case', id: caseId, localRef: caseId, title: 'Host task', summary: 'Private task',
      source: { kind: 'local', reference: caseId }, participants: [{ subjectId: status.subjectId, role: 'requester' }] });
    await seed({ kind: 'attempt', id: attemptId, caseId, expectedVersion: 1, sequence: 1, approach: 'Selected external task',
      configuration: { environment: 'fixture', version: '1', tools: ['A2A'] } });
    const preview = await runtime.controller.prepareA2a({ kind: 'send', peerId: 'peer', caseId, attemptId, text });
    return runtime.controller.executeA2a(preview, preview.confirmation);
  }
  const peers = await runtime.controller.readA2a('peers');
  assert.equal(peers.length, 1); assert.ok(!JSON.stringify(peers).includes('credential'));
  const link = await start('complete'), input = { peerId: 'peer', associationId: link.id };
  const preview = await runtime.controller.prepareA2a({ ...input, kind: 'result', visibility: 'Private', viewers: [] });
  assert.equal(consentWrites, 0); assert.equal(caseWrites, 0);
  assert.equal(JSON.parse(preview.intentJson).action, 'case.teaser.publish');
  assert.equal(JSON.parse(preview.payloadJson).attemptId, link.attemptId);
  await assert.rejects(runtime.controller.readA2a('list', { peerId: 'peer' }), /unavailable/);
  runtime.controller.cancel();
  await assert.rejects(runtime.controller.executeA2a(preview, preview.confirmation), /Unknown host/);
  const retry = await runtime.controller.prepareA2a({ ...input, kind: 'result', visibility: 'Private', viewers: [] });
  assert.equal(retry.eventId, preview.eventId); assert.equal(retry.intentJson, preview.intentJson);
  loseReceipt = true;
  await assert.rejects(runtime.controller.executeA2a(retry, retry.confirmation));
  assert.equal(consentWrites, 1); assert.equal(caseWrites, 1);
  assert.equal((await runtime.controller.getCase(link.caseId)).version, 3);
  runtime.close();
  runtime = createLocalHostRuntime(config); status = await connect();
  const reconciliation = await runtime.controller.readA2a('reconcile', input);
  assert.equal(reconciliation.state, 'acknowledged'); assert.equal(reconciliation.eventId, preview.eventId);
  await assert.rejects(runtime.controller.prepareA2a({ ...input, kind: 'result' }), /already imported/);
  assert.equal(caseWrites, 1); assert.equal(hash(await readFile(keyPath)), keyHash);
  const active = await start('work');
  const cancel = await runtime.controller.prepareA2a({ peerId: 'peer', associationId: active.id, kind: 'cancel' });
  externalPrincipal = 'changed';
  const count = peer.requests.length;
  await assert.rejects(runtime.controller.executeA2a(cancel, cancel.confirmation), /principal changed/);
  assert.equal(peer.requests.length, count);
  externalPrincipal = 'external-fixture-user';
  const cancel2 = await runtime.controller.prepareA2a({ peerId: 'peer', associationId: active.id, kind: 'cancel' });
  const canceled = await runtime.controller.executeA2a(cancel2, cancel2.confirmation);
  assert.equal(canceled.peer.state, 'canceled');
  await saveConnectionProfile(directory, revokeConnectionScope(profile, 'bind', new Date(f.now * 1000).toISOString()));
  await assert.rejects(runtime.controller.readA2a('peers'), /session required/);
  assert.equal(hash(await readFile(keyPath)), keyHash);
});
