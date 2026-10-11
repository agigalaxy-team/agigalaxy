import {verifyTrustIdentity,trustHash} from './shared/trust-package-crypto.mjs';
import {signIdentityPayload} from '../../galaxy-core/src/domain/identity-material.mjs';
import {signTrustPackageVcJose} from './shared/trust-package-vc-jose.mjs';

const types=new Set(['galaxy-trust-package-v1+jws','galaxy-trust-source-permission-v1+jws']);
const fail=code=>Object.assign(new Error(code),{code});

// A local current-device adapter shared by web and native clients. Reading the
// cached signed control history never claims a fresh remote revocation check.
export function createTrustPackageDeviceAdapter({endpoint,getMaterial,readIdentity,writeIdentity,fetchIdentity,getBinding=()=>null,now=()=>Math.floor(Date.now()/1000)}){
 async function remember(state){
  if(state?.authority!==endpoint||!Number.isSafeInteger(state.checkedAt)||state.checkedAt<0||!Array.isArray(state.events))throw fail('trust_identity_authority_changed');
  const identity={subjectId:state.subjectId,genesisProof:state.genesisProof,events:state.events,authority:state.authority,checkedAt:state.checkedAt};
  const verified=await verifyTrustIdentity(identity);
  if(verified.epoch!==state.epoch)throw fail('trust_identity_epoch_mismatch');
  const previous=await readIdentity(identity.subjectId);
  if(previous){const prior=await verifyTrustIdentity(previous);
   if(prior.sequence>verified.sequence||prior.sequence===verified.sequence&&prior.chainHead!==verified.chainHead)throw fail('trust_identity_snapshot_rollback');}
  await writeIdentity(identity.subjectId,identity);return identity;
 }
 async function context(){
  const local=await getMaterial();if(!local?.subjectId||!local.material?.privateKey)throw fail('trust_identity_required');
  let identity=await readIdentity(local.subjectId);
  if(!identity){
   if(!local.localGenesis)throw fail('trust_identity_snapshot_required');
   identity={subjectId:local.subjectId,genesisProof:local.genesisProof,events:[],authority:null,checkedAt:now()};
  }
  if(identity.subjectId!==local.subjectId||!Array.isArray(identity.events)||identity.authority!==null&&identity.authority!==endpoint)throw fail('trust_identity_authority_changed');
  const verified=await verifyTrustIdentity(identity),keyId=await trustHash(local.material.publicKeyPem);
  if(!verified.devices.some(d=>d.keyId===keyId&&d.publicKey===local.material.publicKeyPem&&d.epoch===verified.epoch))throw fail('trust_device_not_in_cached_control');
  const binding=getBinding();
  if(binding?.subjectId&&binding.subjectId!==identity.subjectId)throw fail('trust_identity_changed');
  return{identity,keyId,epoch:verified.epoch,bindingId:binding?.bindingId??null,generation:binding?.generation??null,
   endpoint,material:local.material};
 }
 const publicContext=({material:_material,...value})=>value;
 async function current(){return publicContext(await context());}
 async function refreshIdentity(){
  const before=await getMaterial();if(!before?.subjectId)throw fail('trust_identity_required');
  await remember(await fetchIdentity(before.subjectId));
  const after=await getMaterial();
  if(after?.subjectId!==before.subjectId||after.material?.publicKeyPem!==before.material.publicKeyPem)throw fail('trust_identity_changed');
  return current();
 }
 async function sign(text,type,expected){
  if(!types.has(type))throw fail('trust_signature_type_forbidden');
  const before=await context();
  if(!expected||before.identity.subjectId!==expected.subjectId||before.keyId!==expected.keyId||before.epoch!==expected.epoch)throw fail('trust_identity_changed');
  const signed=await signIdentityPayload(text,before.material.privateKey,{type});
  const after=await current();
  if(after.identity.subjectId!==expected.subjectId||after.keyId!==expected.keyId||after.epoch!==expected.epoch)throw fail('trust_identity_changed');
  return signed;
 }
 const sameVc=(value,expected)=>expected&&value.identity.subjectId===expected.subjectId&&value.keyId===expected.keyId&&value.epoch===expected.epoch
  &&value.endpoint===expected.endpoint&&value.bindingId===expected.bindingId&&value.generation===expected.generation;
 async function signVc(preview,expected){
  const before=await context();if(!sameVc(before,expected))throw fail('trust_vc_identity_changed');
  const manifest=JSON.parse(preview.package.manifestJson);
  if(manifest.subjectId!==expected.subjectId||manifest.keyId!==expected.keyId||manifest.epoch!==expected.epoch)throw fail('trust_vc_signer_mismatch');
  const signed=await signTrustPackageVcJose(preview,before.material.privateKey,{now:now()});
  if(!sameVc(await current(),expected))throw fail('trust_vc_identity_changed');return signed;
 }
 return Object.freeze({current,sign,signVc,remember,refreshIdentity});
}
