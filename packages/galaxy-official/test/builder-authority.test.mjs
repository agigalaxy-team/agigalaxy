import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { builderDeclaration } from './builders-workflow.mjs';
import { createApi } from '../src/http.mjs';

test('AIP operation claims, binding and Node approval do not certify Worker or Hub capability', async () => {
  const f = await serviceFixture(['binding', 'consent', 'builders']);
  const limited = await serviceFixture(['binding'], f.db, { migrateDatabase: false });
  const api = createApi({ ...f, rateLimit: 100 });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${api.address().port}`;
  const visibility = { visibility: 'Public', purpose: 'public-profile' };
  let requests = 0;
  // Synthetic untrusted assertions; these headers are not an AIP wire implementation.
  const claimedAuthority = { 'X-AIP-Identity': 'synthetic-external-operator', 'X-AIP-Scopes': 'admin builders capability:verified' };
  async function post(path, body, credential = f.credential, headers = {}) {
    requests++;
    const response = await fetch(origin + path, { method: 'POST', headers: {
      'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...headers
    }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  }
  async function publish(payload) {
    const grant = await f.authorize(payload, 'builder.publish', visibility);
    const result = await post('/v1/builders/events', grant);
    assert.equal(result.status, 200);
    return { grant, receipt: result.value };
  }
  async function read(builderId) {
    const response = await post('/v1/builders/read', { builderId }, null, claimedAuthority);
    assert.equal(response.status, 200);
    const view = response.value;
    assert.equal(view.registration.state, 'registered');
    assert.equal(view.capabilityVerified, false);
    assert.equal(view.compatibility.capabilityVerified, false);
    assert.equal(view.compatibility.state, 'unverified');
    assert.equal(view.evidence.state, 'none-current');
    assert.equal(view.evidence.builderAttributionVerified, false);
    assert.equal(view.reachability.endpointReachable, null);
    return view;
  }
  try {
    const builderId = randomUUID(), declaration = builderDeclaration('worker', f.actor.subjectId);
    declaration.capabilities[0] = { id: 'coding', claim: 'Owner claims external AIP operation permission implies certified coding ability', limitations: 'Synthetic owner claim; no professional capability evidence' };
    const root = { id: randomUUID(), builderId, kind: 'declare', expectedRevision: 0, declaration };
    const { grant } = await publish(root);
    let view = await read(builderId);
    assert.deepEqual(view.declaration.capabilities, declaration.capabilities);
    assert.equal(view.nodeControl.state, 'unverified');
    for (const credential of [null, limited.credential]) {
      const denied = await post('/v1/builders/events', grant, credential, claimedAuthority);
      assert.ok([401, 403].includes(denied.status), 'external assertions cannot supply the missing Galaxy authorization');
    }
    for (const patch of [{ capabilityVerified: true }, { aip: { scopes: ['admin'], professionalCapabilityVerified: true } }]) {
      const forged = { ...root, id: randomUUID(), builderId: randomUUID(), declaration: { ...declaration, ...patch } };
      const rejected = await post('/v1/builders/events', await f.authorize(forged, 'builder.publish', visibility));
      assert.equal(rejected.status, 400);
      assert.equal(rejected.value.error, 'invalid_builder_payload');
    }
    await publish({ id: randomUUID(), builderId, kind: 'node-control', expectedRevision: 1,
      declarationId: root.id, declarationHash: view.declarationHash, ownerId: f.actor.subjectId,
      nodeId: f.actor.subjectId, expiresAt: f.now + 300 });
    view = await read(builderId);
    assert.equal(view.nodeControl.state, 'node-authorized-owner');
    assert.equal(view.nodeControl.capabilityVerified, false);
    assert.equal(view.nodeControl.endpointControlVerified, false);
    await publish({ id: randomUUID(), builderId, kind: 'heartbeat', expectedRevision: 2, declarationId: root.id });
    assert.equal((await read(builderId)).reachability.state, 'recent-owner-heartbeat');
    const hubId = randomUUID();
    await publish({ id: randomUUID(), builderId: hubId, kind: 'declare', expectedRevision: 0, declaration: builderDeclaration('hub', f.actor.subjectId) });
    assert.equal((await read(hubId)).nodeControl.state, 'not-applicable');
    const spec = await post('/v1/builders/specification', {}, null);
    assert.equal(spec.value.hubConnection, false);
    assert.equal(spec.value.workerExecution, false);
    assert.equal(spec.value.automaticEndpointProbes, false);
    assert.equal(spec.value.capabilityVerified, false);
    assert.equal(Number((await f.db.query('SELECT count(*) FROM builders')).rows[0].count), 2);
    assert.equal(Number((await f.db.query('SELECT count(*) FROM builder_events')).rows[0].count), 4);
    console.log(JSON.stringify({ event: 'builder_authority_acceptance', httpRequests: requests, registeredTypes: ['worker', 'hub'],
      realGalaxyBinding: true, nodeApprovalVerified: true, capabilityCertified: false,
      externalClaimsGrantAuthority: false, aipProtocolImplemented: false, publicRelease: false }));
  } finally {
    api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await f.db.close();
  }
});
