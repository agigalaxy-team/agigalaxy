import { createWebRuntime } from '../../galaxy-web/src/runtime.mjs';
import { createBrowserClient, browserScopes } from '../src/browser-client.mjs';
import { createBrowserGenesis } from '../../galaxy-core/src/domain/guid-browser-adapter.mjs';
import { createIdentityControlClient } from '../../galaxy-core/src/domain/identity-control-client.mjs';
import { createIdentityDeviceHandoff } from '../../galaxy-core/src/domain/identity-device-handoff.mjs';
import { createDeviceMaterial, identityKeyId, signIdentityPayload } from '../../galaxy-core/src/domain/identity-material.mjs';
import { identityIntentSchema } from '../src/shared/identity-link-schema.mjs';

const scopes = ['manage-identity', ...browserScopes];
const runtimeStores = new WeakMap();
function memoryStore() {
  const rows = new Map();
  return { get: async key => structuredClone(rows.get(key)), put: async (key, value) => { rows.set(key, structuredClone(value)); } };
}

// Test setup represents an ID already created by the installed local client.
// Register its actual signed control chain before opening the production Web
// runtime. No runtime method, browser creation rule or authority is replaced.
export async function seedExistingWebIdentity(config, { store, fetch, now = () => Math.floor(Date.now() / 1000) }) {
  const activeKey = `galaxy-web:${config.endpoint}:active`, existing = await store.get(activeKey);
  if (existing) return existing;
  const material = await createDeviceMaterial(), genesis = await createBrowserGenesis({ publicKeyPem: material.publicKeyPem, originCode: '5' });
  const owner = { subjectId: genesis.id, deviceId: material.deviceId, genesisProof: genesis.genesisProof, installationId: crypto.randomUUID() };
  const sign = payload => signIdentityPayload(payload, material.privateKey);
  const api = createBrowserClient({ ...config, fetch, now, sign });
  try {
    const control = createIdentityControlClient({ endpoint: config.endpoint, send: api.send, store: memoryStore(), now, signController: sign, signNewDevice: sign });
    const request = { version: 2, kind: 'bootstrap', operationId: crypto.randomUUID(), subjectId: genesis.id, expectedEpoch: 0, previousEventHash: null,
      signerKeyId: await identityKeyId(material.publicKeyPem), genesisProof: genesis.genesisProof,
      newDevice: { deviceId: material.deviceId, publicKeyPem: material.publicKeyPem, scopes } };
    await control.confirm(await control.prepare(request), { confirmed: true });
    await store.put(`device:${owner.subjectId}:${owner.deviceId}`, material);
    await store.put(activeKey, owner);
    return owner;
  } finally { api.close(); }
}

export async function createExistingWebRuntime(config, options) {
  await seedExistingWebIdentity(config, options);
  const runtime = await createWebRuntime(config, options);
  runtimeStores.set(runtime, options.store);
  return runtime;
}

// The Node fixture represents the local installed client's signing side. Its
// real registered key approves the original OIDC intent through signed HTTP;
// WebRuntime.confirmAccountLink remains unavailable and no Account quota is stubbed.
export async function confirmFixtureAccountLink(runtime, id, { store = runtimeStores.get(runtime) } = {}) {
  const identity = (await runtime.status()).identity, session = runtime.api.snapshot();
  if (!identity || !session || !store) throw Error('Fixture local identity and connection required.');
  const active = await store.get(`galaxy-web:${runtime.api.endpoint}:active`);
  if (active?.subjectId !== identity.subjectId || active.deviceId !== identity.deviceId || session.subjectId !== identity.subjectId)
    throw Error('Fixture local identity changed.');
  const status = await runtime.api.call('/v1/identity/status', { id });
  const intent = identityIntentSchema.parse(JSON.parse(status.payloadJson));
  if (status.id !== id || !['awaiting-local-signature', 'linked'].includes(status.state) || intent.id !== id
    || intent.subjectId !== identity.subjectId || intent.bindingId !== session.bindingId || intent.endpoint !== runtime.api.endpoint)
    throw Error('Fixture account association intent mismatch.');
  const material = await store.get(`device:${identity.subjectId}:${identity.deviceId}`);
  if (!material?.privateKey) throw Error('Fixture local device material unavailable.');
  const signed = await signIdentityPayload(status.payloadJson, material.privateKey, { type: 'galaxy-identity-link+jws' });
  const receipt = await runtime.api.call('/v1/identity/confirm', { id, signed });
  if (receipt.id !== id || receipt.state !== 'linked' || receipt.galaxyAuthorization !== false) throw Error('Fixture account association not confirmed.');
  return receipt;
}

// Identity-change boundary tests start with an actually empty production
// runtime. Select an independently registered ID through the real device
// handoff rather than resurrecting Web createIdentity or changing its methods.
export async function handoffExistingWebIdentity(runtime, { now = () => Math.floor(Date.now() / 1000) } = {}) {
  const store = memoryStore(), config = { endpoint: runtime.api.endpoint };
  const material = await createDeviceMaterial(), genesis = await createBrowserGenesis({ publicKeyPem: material.publicKeyPem, originCode: '5' });
  const owner = { subjectId: genesis.id, deviceId: material.deviceId, genesisProof: genesis.genesisProof, installationId: crypto.randomUUID() };
  const sign = payload => signIdentityPayload(payload, material.privateKey);
  const control = createIdentityControlClient({ endpoint: config.endpoint, send: runtime.api.send, store, now, signController: sign, signNewDevice: sign });
  await control.confirm(await control.prepare({ version: 2, kind: 'bootstrap', operationId: crypto.randomUUID(), subjectId: genesis.id,
    expectedEpoch: 0, previousEventHash: null, signerKeyId: await identityKeyId(material.publicKeyPem), genesisProof: genesis.genesisProof,
    newDevice: { deviceId: material.deviceId, publicKeyPem: material.publicKeyPem, scopes } }), { confirmed: true });
  await store.put(`device:${owner.subjectId}:${owner.deviceId}`, material);
  const source = createIdentityDeviceHandoff({ endpoint: config.endpoint, send: runtime.api.send, store, now, allowedScopes: scopes,
    getActive: async () => owner, activate: async () => { throw Error('Fixture source must not change identity.'); } });
  const offer = await runtime.deviceHandoff.createOffer(owner.subjectId, { scopes: browserScopes, confirmed: true });
  const approval = await source.approveOffer(offer, { scopes: browserScopes, confirmed: true });
  await runtime.deviceHandoff.acceptApproval(approval, { confirmed: true });
  return runtime.status();
}
