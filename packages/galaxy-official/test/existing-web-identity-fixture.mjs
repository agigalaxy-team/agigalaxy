import { createWebRuntime } from '../../galaxy-web/src/runtime.mjs';
import { createBrowserClient, browserScopes } from '../src/browser-client.mjs';
import { createBrowserGenesis } from '../../galaxy-core/src/domain/guid-browser-adapter.mjs';
import { createIdentityControlClient } from '../../galaxy-core/src/domain/identity-control-client.mjs';
import { createIdentityDeviceHandoff } from '../../galaxy-core/src/domain/identity-device-handoff.mjs';
import { createDeviceMaterial, identityKeyId, signIdentityPayload } from '../../galaxy-core/src/domain/identity-material.mjs';
import { identityIntentSchema } from '../src/shared/identity-link-schema.mjs';

const scopes = ['manage-identity', ...browserScopes];
const runtimeStores = new WeakMap();
const runtimeOptions = new WeakMap();
export const existingWebFixtureWebsite = 'https://galaxy.example.org';
function memoryStore() {
  const rows = new Map();
  return { get: async key => structuredClone(rows.get(key)), put: async (key, value) => { rows.set(key, structuredClone(value)); },
    update:async(key,change)=>{const value=change(structuredClone(rows.get(key)));if(value&&typeof value.then==='function')throw Error('local_update_async_callback');rows.set(key,structuredClone(value));return structuredClone(value);} };
}

export async function nativeOwner(endpoint,send,now){
  const store=memoryStore(),material=await createDeviceMaterial(),genesis=await createBrowserGenesis({publicKeyPem:material.publicKeyPem,originCode:'5'});
  const owner={subjectId:genesis.id,deviceId:material.deviceId,genesisProof:genesis.genesisProof,installationId:crypto.randomUUID()};
  const sign=payload=>signIdentityPayload(payload,material.privateKey);
  const control=createIdentityControlClient({endpoint,send,store,now,signController:sign,signNewDevice:sign});
  await control.confirm(await control.prepare({version:2,kind:'bootstrap',operationId:crypto.randomUUID(),subjectId:genesis.id,expectedEpoch:0,previousEventHash:null,
    signerKeyId:await identityKeyId(material.publicKeyPem),genesisProof:genesis.genesisProof,
    newDevice:{deviceId:material.deviceId,publicKeyPem:material.publicKeyPem,scopes}}),{confirmed:true});
  await store.put(`device:${owner.subjectId}:${owner.deviceId}`,material);
  return{store,material,owner,sign};
}

// A raw historical browser selection deliberately contains no Native handoff.
// Retired-selection boundary tests can retain this data without making it a
// valid current identity. Positive business fixtures use the wrapper below.
export async function seedExistingWebIdentity(config, { store, fetch, now = () => Math.floor(Date.now() / 1000) }) {
  const activeKey = `galaxy-web:${config.endpoint}:active`, existing = await store.get(activeKey);
  if (existing) return existing;
  const api = createBrowserClient({ ...config, fetch, now,sign:()=>{throw Error('Raw fixture transport does not own a browser signer.');} });
  try {
    const {owner,material}=await nativeOwner(config.endpoint,api.send,now);
    await store.put(`device:${owner.subjectId}:${owner.deviceId}`, material);
    await store.put(activeKey, owner);
    return owner;
  } finally { api.close(); }
}

export async function createExistingWebRuntime(config, options) {
  const selected={...options,website:options.website??existingWebFixtureWebsite};
  const runtime = await createWebRuntime(config, selected);
  runtimeStores.set(runtime, selected.store);runtimeOptions.set(runtime,selected);
  try{
    if((await runtime.status()).identity)await runtime.agentContinuity.requireCurrent();
    else await handoffExistingWebIdentity(runtime,selected);
    return runtime;
  }catch(error){runtime.close();throw error;}
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
export async function handoffExistingWebIdentity(runtime, { now = () => Math.floor(Date.now() / 1000),website=runtimeOptions.get(runtime)?.website??existingWebFixtureWebsite,native=null } = {}) {
  if((await runtime.status()).identity)throw Error('Fixture requires an empty or retired Web selection.');
  const endpoint=runtime.api.endpoint,{store,material,owner}=native??await nativeOwner(endpoint,runtime.api.send,now);
  const source = createIdentityDeviceHandoff({ endpoint, send: runtime.api.send, store, now, allowedScopes: scopes,
    getActive: async () => owner, activate: async () => { throw Error('Fixture source must not change identity.'); } });
  const control=await runtime.publicControl(owner.subjectId),handoffId=crypto.randomUUID(),navigationId=crypto.randomUUID(),nonce=crypto.randomUUID(),bridgeOrigin='http://127.0.0.1:39841';
  const context={endpoint,website,subjectId:owner.subjectId,controller:{deviceId:owner.deviceId,keyId:await identityKeyId(material.publicKeyPem),epoch:control.epoch,chainHead:control.chainHead},
    scopes,expiresAt:now()+120,targetPath:'/app/publish',existingDevice:null};
  const payloadJson=JSON.stringify({protocol:'galaxy-web-identity-handoff',version:1,handoffId,navigationId,nonce,bridgeOrigin,context});
  const signature=await signIdentityPayload(payloadJson,material.privateKey,{type:'galaxy-web-identity-handoff-v1+jws'});
  const offer = await runtime.deviceHandoff.createOffer(owner.subjectId, { scopes, confirmed: true });
  const approval = await source.approveOffer(offer, { scopes, confirmed: true });
  await runtime.agentContinuity.retainHandoff({handoffId,navigationId,context:{...context,nonce,bridgeOrigin,proof:{payloadJson,signature}},offer,approval});
  const joined=await runtime.deviceHandoff.acceptApproval(approval, { confirmed: true });
  await runtime.agentContinuity.retainReceipt(joined.receipt);
  return runtime.status();
}
