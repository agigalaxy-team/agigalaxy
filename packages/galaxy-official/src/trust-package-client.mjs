import {prepareTrustPackage,sealTrustPackage,verifyTrustPackage} from './trust-package.mjs';
import {trustCanonical,trustHash,verifyTrustIdentity} from './shared/trust-package-crypto.mjs';
import {trustPermissionSchema} from './shared/trust-package-schema.mjs';
const fail=code=>Object.assign(new Error(code),{code}),copy=x=>structuredClone(x);
const lanes=new Map();
const permissionType='galaxy-trust-source-permission-v1+jws',packageType='galaxy-trust-package-v1+jws';

// current() and sign() are purpose-limited adapters over the host's EXISTING
// device keys. No new identity, issuer key, remote inference or auto upload.
export function createTrustPackageClient({api,current,sign,getLocal,putLocal,now=()=>Math.floor(Date.now()/1000),locks=globalThis.navigator?.locks}) {
 const previews=new WeakMap(),index='trust-package:pending';
 async function lease(){const c=await current();if(!c?.identity?.subjectId)throw fail('trust_identity_required');return c;}
 async function same(c,{binding=false}={}){const n=await lease();if(n.identity.subjectId!==c.identity.subjectId||n.keyId!==c.keyId||n.epoch!==c.epoch
   ||binding&&n.bindingId!==c.bindingId)throw fail('trust_identity_changed');return n;}
 async function serial(c,fn){const name='galaxy-trust:'+c.identity.subjectId;
  if(locks?.request)return locks.request(name,{mode:'exclusive'},async()=>{await same(c);return fn();});
  const result=(lanes.get(name)??Promise.resolve()).catch(()=>{}).then(async()=>{await same(c);return fn();});lanes.set(name,result);
  return result.finally(()=>{if(lanes.get(name)===result)lanes.delete(name);});}
 function network(){if(!api?.snapshot?.())throw fail('trust_connection_required');}
 async function prepare({claims=[],selections=[],audience,expiresAt=now()+86400}){
  const c=await lease();let sources=[];
  if(selections.length){network();const response=await api.call('/v2/trust-package/sources',{selections,audience,expiresAt});await same(c);
   if(response.items.some(i=>i.state!=='available'))return {state:'sources-unavailable',items:response.items};sources=response.items.map(i=>i.snapshot);}
  const value=await prepareTrustPackage({identity:c.identity,keyId:c.keyId,epoch:c.epoch,audience,issuedAt:now(),expiresAt,claims,sources},{now:now()});
  const preview=Object.freeze({...value,state:'ready'});previews.set(preview,{kind:'package',c,value:copy(value),hash:await trustHash(trustCanonical(value)),used:false});return preview;
 }
 async function exportPackage(preview,{confirmed=false}={}){
  const p=previews.get(preview);if(!confirmed||!p||p.kind!=='package'||p.used)throw fail('trust_preview_required');
  const{state,...shown}=preview;if(await trustHash(trustCanonical(shown))!==p.hash)throw fail('trust_preview_changed');
  return serial(p.c,async()=>{await same(p.c);p.used=true;
   // A source-bearing preview is refreshed on export, but no source text or
   // complete package is uploaded. A changed exact record requires review.
   const objects=JSON.parse(p.value.files['objects.json']);
   if(objects.sources.length){network();const selections=objects.sources.map(s=>({ref:s.ref,mode:s.mode,
     ...(s.permission?{permissionId:JSON.parse(atob(s.permission.signed.split('.')[1].replaceAll('-','+').replaceAll('_','/'))).id}:{})}));
    const checked=await api.call('/v2/trust-package/sources',{selections,audience:objects.audience,expiresAt:objects.expiresAt});await same(p.c);
    if(checked.items.length!==objects.sources.length||checked.items.some((v,i)=>v.state!=='available'||v.snapshot.sourceHash!==objects.sources[i].sourceHash
      ||v.snapshot.sourceState!==objects.sources[i].sourceState))throw fail('trust_source_changed');}
   const signature=await sign(p.value.manifestJson,packageType,{subjectId:p.c.identity.subjectId,keyId:p.c.keyId,epoch:p.c.epoch});await same(p.c);
   const container=await sealTrustPackage(p.value,signature);await putLocal('trust-package:last-export',{packageId:p.value.packageId,createdAt:now(),container});await same(p.c);
   return {container,packageId:p.value.packageId,remotePublished:false,localSaved:true};
  });
 }
 async function permissionPreview(input,{revoke=false}={}){
  network();const c=await lease(),value=await api.call('/v2/trust-package/permissions/'+(revoke?'revoke-preview':'preview'),input);await same(c,{binding:true});
  if(value.signatureType!==permissionType)throw fail('trust_signature_type_changed');
  const payload=trustPermissionSchema.parse(JSON.parse(value.payloadJson));
  if(payload.subjectId!==c.identity.subjectId||payload.bindingId!==c.bindingId||payload.endpoint!==api.endpoint||payload.keyId!==c.keyId||payload.epoch!==c.epoch)throw fail('trust_signer_context_changed');
  const preview=Object.freeze({...value,state:'ready'});previews.set(preview,{kind:'permission',c,value:copy(value),hash:await trustHash(trustCanonical(value)),used:false});return preview;
 }
 async function load(c,operationId){const r=await getLocal('trust-package:permission:'+operationId);await same(c);
  if(!r||r.subjectId!==c.identity.subjectId||r.endpoint!==api.endpoint||await trustHash(r.signed)!==r.signatureHash)throw fail('trust_operation_unavailable');return r;}
 async function record(c,r){await same(c);await putLocal('trust-package:permission:'+r.operationId,r);await same(c);
  const ids=await getLocal(index)??[];await same(c);if(!ids.includes(r.operationId)){await putLocal(index,[...ids,r.operationId]);await same(c);}}
 function receiptMatches(r,receipt){return receipt.state==='recorded'&&(r.kind==='grant'?receipt.operationId===r.operationId&&receipt.signatureHash===r.signatureHash:
   receipt.revokeOperationId===r.operationId&&receipt.revokeSignatureHash===r.signatureHash);}
 async function reconcileWithin(c,r){network();const receipt=await api.call('/v2/trust-package/permissions/receipt',{id:r.id});await same(c);
  if(receipt.id!==r.id)throw fail('trust_receipt_mismatch');
  if(receiptMatches(r,receipt)){r.state='acknowledged';r.receipt=receipt;await record(c,r);return {...receipt,reconciled:true};}
  if(receipt.state==='absent'||r.kind==='revoke'&&receipt.state==='recorded'&&!receipt.revokeOperationId)return {id:r.id,state:'absent',operationId:r.operationId};
  throw fail('trust_operation_conflict');}
 async function send(c,r){await same(c,{binding:true});network();r.state='result-unknown';await record(c,r);
  const receipt=await api.call('/v2/trust-package/permissions/submit',{signed:r.signed});await same(c);
  if(!receiptMatches(r,receipt))throw fail('trust_result_unknown');r.state='acknowledged';r.receipt=receipt;await record(c,r);return receipt;}
 async function executePermission(preview,{confirmed=false}={}){
  const p=previews.get(preview);if(!confirmed||!p||p.kind!=='permission'||p.used)throw fail('trust_preview_required');
  const{state,...shown}=preview;if(await trustHash(trustCanonical(shown))!==p.hash)throw fail('trust_preview_changed');
  return serial(p.c,async()=>{await same(p.c,{binding:true});p.used=true;
   const payload=trustPermissionSchema.parse(JSON.parse(p.value.payloadJson)),signed=await sign(p.value.payloadJson,permissionType,
     {subjectId:p.c.identity.subjectId,keyId:p.c.keyId,epoch:p.c.epoch});await same(p.c,{binding:true});
   const r={operationId:payload.operationId,id:payload.id,kind:payload.kind,subjectId:payload.subjectId,endpoint:payload.endpoint,
     bindingId:payload.bindingId,keyId:payload.keyId,epoch:payload.epoch,signed,signatureHash:await trustHash(signed),state:'prepared'};
   await record(p.c,r);return send(p.c,r);
  });
 }
 async function pending(){const c=await lease(),ids=await getLocal(index)??[];await same(c);const out=[];
  for(const id of ids){const r=await load(c,id);if(r.state!=='acknowledged')out.push({operationId:id,id:r.id,kind:r.kind,state:r.state});}return out;}
 async function reconcile(operationId){const c=await lease();return serial(c,async()=>reconcileWithin(c,await load(c,operationId)));}
 async function retry(operationId){const c=await lease();return serial(c,async()=>{const r=await load(c,operationId),receipt=await reconcileWithin(c,r);
  if(receipt.state!=='absent')return receipt;if(r.state==='stopped-local')throw fail('trust_retry_stopped');
  if(r.bindingId!==c.bindingId||r.keyId!==c.keyId||r.epoch!==c.epoch)throw fail('trust_original_authorization_stale');
  return send(c,r);});}
 async function stopRetry(operationId){const c=await lease();return serial(c,async()=>{const r=await load(c,operationId),receipt=await reconcileWithin(c,r);
  if(receipt.state!=='absent')return receipt;r.state='stopped-local';await record(c,r);return {state:'stopped-local',id:r.id,operationId,
    serverCancellationConfirmed:false,lateReceiptCanBeReconciled:true};});}
 async function checkOnline(container,{selectedEndpoint}={}){
  const offline=await verifyTrustPackage(container,{now:now()});network();if(selectedEndpoint!==api.endpoint)throw fail('trust_selected_endpoint_required');
  const c=await lease(),objects=JSON.parse(container.files['objects.json']),items=[];
  for(const source of objects.sources){
   if(source.ref.endpoint!==selectedEndpoint){items.push({ref:source.ref,status:'not-checked',reason:'different-selected-service'});continue;}
   if(!source.permission){items.push({ref:source.ref,status:'not-checked',reason:'reference-only-no-online-source-access-granted'});continue;}
   const verified=offline.sources.find(s=>trustCanonical(s.ref)===trustCanonical(source.ref));
   if(verified?.reproductionPermission.status!=='signature-and-scope-valid'){items.push({ref:source.ref,status:'not-checked',reason:'included-license-invalid-or-expired'});continue;}
   const grant=trustPermissionSchema.parse(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(source.permission.signed.split('.')[1].replaceAll('-','+').replaceAll('_','/')),ch=>ch.charCodeAt(0)))));
   try{const result=await api.call('/v2/trust-package/permissions/status',{id:grant.id});await same(c);items.push({ref:source.ref,...result});}
   catch(error){await same(c);items.push({ref:source.ref,status:'not-checked',reason:error?.code??'service-unavailable'});}
  }
  let control={status:'not-checked',reason:'different-selected-service'};
  const identity=JSON.parse(container.files['identity.json']);
  if(identity.authority===selectedEndpoint){
   try {const remote=await api.call('/v2/identity/'+encodeURIComponent(offline.subjectId)+'/control',undefined,{method:'GET'});await same(c);
    const manifest=JSON.parse(container.manifestJson),verified=await verifyTrustIdentity(remote);control={status:verified.epoch===manifest.epoch&&verified.devices.some(d=>d.keyId===manifest.keyId)?'included-signer-current':'control-changed',checkedAt:remote.checkedAt};}
   catch(error){await same(c);control={status:'not-checked',reason:error?.code??'service-unavailable'};}
  }
  return {offline,online:{selectedEndpoint,checkedAt:now(),control,items,capabilityVerified:false},uploadedPackage:false};
 }
 return Object.freeze({prepare,exportPackage,permissionPreview,executePermission,pending,reconcile,retry,stopRetry,checkOnline,
  importPackage:(input,options)=>verifyTrustPackage(input,options),lastExport:()=>getLocal('trust-package:last-export'),
  deleteLocalExport:()=>putLocal('trust-package:last-export',null)});
}
