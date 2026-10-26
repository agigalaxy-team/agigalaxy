import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { browserScopes, createBrowserClient } from '../src/browser-client.mjs';
import { createTrustPackageClient } from "../src/clients/trust-package.mjs";
import { createTrustPackageDeviceAdapter } from "../src/clients/trust-package-device-adapter.mjs";
import { createDeviceMaterial, signIdentityPayload } from '../../galaxy-core/src/domain/identity-material.mjs';
import { createBrowserGenesis } from '../../galaxy-core/src/domain/guid-browser-adapter.mjs';
import { trustHash } from '../src/shared/trust-package-crypto.mjs';

// Actual signed BrowserClient -> HTTP -> services/PGlite. Synthetic owner and
// Map persistence isolate this from any production identity and real IndexedDB.
export async function vcJoseClientFixture() {
  const f = await serviceFixture(browserScopes, null, { now: Math.floor(Date.now() / 1000) });
  const material = await createDeviceMaterial(), genesis = await createBrowserGenesis({ publicKeyPem: material.publicKeyPem });
  const keyId = await trustHash(material.publicKeyPem), operationId = randomUUID();
  const sign = (text, type) => signIdentityPayload(text, material.privateKey, { type });
  const challenge = await f.identityControl.challenge({ version: 2, operationId, subjectId: genesis.id, kind: 'bootstrap', expectedEpoch: 0,
    previousEventHash: null, signerKeyId: keyId, genesisProof: genesis.genesisProof,
    newDevice: { deviceId: material.deviceId, publicKeyPem: material.publicKeyPem, scopes: ['manage-identity', ...browserScopes] } });
  const proof = await sign(challenge.challenge, 'galaxy-identity-control-v2+jws');
  await f.identityControl.commit({ operationId, controllerSignature: proof, newDeviceProof: proof });
  const server = createApi({ ...f, rateLimit: 2000 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port, calls = [], memory = new Map();
  const state = { reconnectAfterSources: false, reconnectBeforeSigning: false, reconnectOnSave: false, saveWait: null, signs: 0 };
  const api = createBrowserClient({ endpoint: f.access.endpoint, trustedKeys: f.bindings.trustedKeys, now: () => f.now, sign,
    fetch: async (url, init) => { const path = new URL(url).pathname; calls.push(path); return fetch(origin + path, init); } });
  const connect = () => api.connect({ subjectId: genesis.id, genesisProof: genesis.genesisProof, installationId: randomUUID(),
    scopes: browserScopes, control: { deviceId: material.deviceId, keyId, epoch: 1 } }, { confirmed: true });
  await connect();
  const device = createTrustPackageDeviceAdapter({ endpoint: api.endpoint, getBinding: api.snapshot, now: () => f.now,
    getMaterial: async () => ({ subjectId: genesis.id, genesisProof: genesis.genesisProof, material, localGenesis: false }),
    readIdentity: async subject => structuredClone(memory.get('identity:' + subject)),
    writeIdentity: async (subject, value) => memory.set('identity:' + subject, structuredClone(value)),
    fetchIdentity: subject => api.call('/v2/identity/' + subject + '/control', undefined, { method: 'GET', authenticated: false }) });
  await device.refreshIdentity();
  const consumerApi = { ...api, call: async (...args) => {
    const value = await api.call(...args);
    if (state.reconnectAfterSources && args[0] === '/v2/trust-package/sources') { state.reconnectAfterSources = false; await connect(); }
    return value;
  } };
  const options = { api: consumerApi, current: device.current, sign: device.sign, now: () => f.now, locks: null,
    signVc: async (...args) => {
      if (state.reconnectBeforeSigning) { state.reconnectBeforeSigning = false; await connect(); }
      const value = await device.signVc(...args); state.signs++; return value;
    },
    getLocal: async key => structuredClone(memory.get(key)),
    putLocal: async (key, value) => {
      memory.set(key, structuredClone(value));
      if (key === 'trust-package:last-vc-export') {
        if (state.saveWait) await state.saveWait();
        if (state.reconnectOnSave) { state.reconnectOnSave = false; await connect(); }
      }
    } };
  const client = createTrustPackageClient(options), audience = { kind: 'subjects', subjectIds: [genesis.id] };
  async function ordinary(selections = []) {
    const preview = await client.prepare({ claims: [{ id: randomUUID(), text: 'Synthetic explicitly selected parser experience.', authority: 'self-asserted', capabilityVerified: false }],
      selections, audience, expiresAt: f.now + 1000 });
    return (await client.exportPackage(preview, { confirmed: true })).container;
  }
  async function source() {
    const caseId = randomUUID(), payload = { schemaVersion: 2, kind: 'case-created', eventId: caseId, caseId,
      expectedVersion: 0, actorId: genesis.id, localRef: randomUUID(), title: 'Synthetic VC reference source', summary: 'Authored context, not proof of success.',
      source: { kind: 'local', reference: randomUUID() }, synthetic: true };
    const prepared = await api.prepareAuthorization(JSON.stringify(payload), { objectId: caseId,
      action: 'case.teaser.publish', visibility: 'Private', viewers: [], confirmed: true });
    const submission = await api.submitAuthorization(prepared, { confirmed: true });
    await api.call('/v2/cases/events', { consentId: submission.consentId, payloadJson: prepared.payloadJson });
    return { consentId: submission.consentId, ref: { endpoint: api.endpoint, kind: 'case-event', id: caseId, caseId, version: 1 } };
  }
  async function grantCopy(ref) {
    const id = randomUUID(), preview = await client.permissionPreview({ id, operationId: randomUUID(), source: ref,
      grantee: genesis.id, audience, expiresAt: f.now + 1200 });
    await client.executePermission(preview, { confirmed: true });return id;
  }
  return { f, api, consumerApi, material, genesis, keyId, device, client, options, state, memory, calls, audience, connect, ordinary, source, grantCopy,
    close: async () => { api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await f.db.close(); } };
}
