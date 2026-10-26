import {prepareTrustPackage,sealTrustPackage,verifyTrustPackage} from "../verification/trust-package.mjs";
import {trustCanonical,trustHash,verifyTrustIdentity} from "../shared/trust-package-crypto.mjs";
import {trustPermissionSchema} from "../shared/trust-package-schema.mjs";
import {prepareTrustPackageVcJose,sealTrustPackageVcJose,verifyTrustPackageVcJose} from "../shared/trust-package-vc-jose.mjs";
const fail=code=>Object.assign(new Error(code),{code}),copy=x=>structuredClone(x);
const lanes=new Map();
const permissionType='galaxy-trust-source-permission-v1+jws',packageType='galaxy-trust-package-v1+jws';

// current() and sign() are purpose-limited adapters over the host's EXISTING
// device keys. No new identity, issuer key, remote inference or auto upload.
export function createTrustPackageClient({api,current,sign,signVc,getLocal,putLocal,captureLease,now=()=>Math.floor(Date.now()/1000),locks=globalThis.navigator?.locks}) {
 const previews=new WeakMap(),continuations=new WeakMap(),index='trust-package:pending';
 function assertLease(guard,code='trust_identity_changed'){try{guard?.assertCurrent();}catch{throw fail(code);}}
 async function lease(){
  // Capture before the first device/IDB await. A disconnected local genesis is
  // valid; the host fence also detects owner/device and null-binding ABA.
  const guard=captureLease?.();assertLease(guard);
  const c=await current();assertLease(guard);if(!c?.identity?.subjectId)throw fail('trust_identity_required');
  if(guard?.subjectId&&guard.subjectId!==c.identity.subjectId)throw fail('trust_identity_changed');
  return {...c,identity:copy(c.identity),endpoint:c.endpoint??api?.endpoint??null,guard};
 }
 async function same(c,{binding=false}={}){assertLease(c.guard);const n=await lease();assertLease(c.guard);
  if(n.identity.subjectId!==c.identity.subjectId||n.keyId!==c.keyId||n.epoch!==c.epoch||n.endpoint!==c.endpoint
   ||n.generation!==c.generation||(binding||c.guard||c.generation!=null)&&n.bindingId!==c.bindingId)throw fail('trust_identity_changed');return n;}
 async function serial(c,fn){const name='galaxy-trust:'+c.identity.subjectId;
  const work=async()=>{await same(c);const value=await fn();await same(c);return value;};
  if(locks?.request)return locks.request(name,{mode:'exclusive'},work);
  const result=(lanes.get(name)??Promise.resolve()).catch(()=>{}).then(work);lanes.set(name,result);
  return result.finally(()=>{if(lanes.get(name)===result)lanes.delete(name);});}
 function network(){if(!api?.snapshot?.())throw fail('trust_connection_required');}
 /** @param {{claims?:import('zod/v4').infer<typeof import('../shared/trust-package-schema.mjs').trustClaimSchema>[],selections?:{ref:import('zod/v4').infer<typeof import('../shared/trust-package-schema.mjs').trustSourceRefSchema>,mode:'reference'|'copy',permissionId?:string}[],audience:import('zod/v4').infer<typeof import('../shared/trust-package-schema.mjs').trustAudienceSchema>,expiresAt?:number}} input */
 async function prepare({claims=[],selections=[],audience,expiresAt=now()+86400}){
  ({claims,selections,audience}=copy({claims,selections,audience}));
  const c=await lease();let sources=[];
  if(selections.length){network();const response=await api.call('/v2/trust-package/sources',{selections,audience,expiresAt});await same(c);
   if(response.items.some(i=>i.state!=='available'))return {state:'sources-unavailable',items:response.items};sources=response.items.map(i=>i.snapshot);}
  const value=await prepareTrustPackage({identity:c.identity,keyId:c.keyId,epoch:c.epoch,audience,issuedAt:now(),expiresAt,claims,sources},{now:now()});
  await same(c);const hash=await trustHash(trustCanonical(value));await same(c);
  const preview=Object.freeze({...value,state:'ready'});previews.set(preview,{kind:'package',c,value:copy(value),hash,used:false});return preview;
 }
 /** @param {any} preview @param {{confirmed?:boolean,onJournal?:(locator:any)=>Promise<void>|void}} [options] */
 async function exportPackage(preview,{confirmed=false,onJournal}={}){
  const p=previews.get(preview);if(!confirmed||!p||p.kind!=='package'||p.used)throw fail('trust_preview_required');
  const{state:_state,...shown}=preview,hash=await trustHash(trustCanonical(shown));await same(p.c);if(hash!==p.hash)throw fail('trust_preview_changed');
  return serial(p.c,async()=>{await same(p.c);if(p.used)throw fail('trust_preview_required');p.used=true;
   // A source-bearing preview is refreshed on export, but no source text or
   // complete package is uploaded. A changed exact record requires review.
   const objects=JSON.parse(p.value.files['objects.json']);
   if(objects.sources.length){network();const selections=objects.sources.map(s=>({ref:s.ref,mode:s.mode,
     ...(s.permission?{permissionId:JSON.parse(atob(s.permission.signed.split('.')[1].replaceAll('-','+').replaceAll('_','/'))).id}:{})}));
    const checked=await api.call('/v2/trust-package/sources',{selections,audience:objects.audience,expiresAt:objects.expiresAt});await same(p.c);
    if(checked.items.length!==objects.sources.length||checked.items.some((v,i)=>v.state!=='available'||v.snapshot.sourceHash!==objects.sources[i].sourceHash
      ||v.snapshot.sourceState!==objects.sources[i].sourceState))throw fail('trust_source_changed');}
   const signature=await sign(p.value.manifestJson,packageType,{subjectId:p.c.identity.subjectId,keyId:p.c.keyId,epoch:p.c.epoch});await same(p.c);
   const container=await sealTrustPackage(p.value,signature);await same(p.c);
   if(onJournal){await onJournal(Object.freeze({kind:'trust-package-export',packageId:p.value.packageId,subjectId:p.c.identity.subjectId,endpoint:p.c.endpoint}));await same(p.c);}
   await putLocal('trust-package:last-export',{packageId:p.value.packageId,createdAt:now(),container},p.c.identity.subjectId);await same(p.c);
   return {container,packageId:p.value.packageId,remotePublished:false,localSaved:true};
  });
 }
 async function permissionPreview(input,{revoke=false}={}){
  input=copy(input);
  network();const c=await lease(),value=await api.call('/v2/trust-package/permissions/'+(revoke?'revoke-preview':'preview'),input);await same(c,{binding:true});
  if(value.signatureType!==permissionType)throw fail('trust_signature_type_changed');
  const payload=trustPermissionSchema.parse(JSON.parse(value.payloadJson));
  if(payload.subjectId!==c.identity.subjectId||payload.bindingId!==c.bindingId||payload.endpoint!==api.endpoint||payload.keyId!==c.keyId||payload.epoch!==c.epoch)throw fail('trust_signer_context_changed');
  const hash=await trustHash(trustCanonical(value));await same(c,{binding:true});
  const preview=Object.freeze({...value,state:'ready'});previews.set(preview,{kind:'permission',c,value:copy(value),hash,used:false});return preview;
 }
 async function load(c,operationId){const r=await getLocal('trust-package:permission:'+operationId,c.identity.subjectId);await same(c);
  if(!r||r.subjectId!==c.identity.subjectId||r.endpoint!==api.endpoint)throw fail('trust_operation_unavailable');
  const hash=await trustHash(r.signed);await same(c);if(hash!==r.signatureHash)throw fail('trust_operation_unavailable');original(r);return r;}
 function original(r){
  try{
   const parts=r.signed.split('.');if(parts.length!==3)throw 0;
   const decode=text=>new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(text.replaceAll('-','+').replaceAll('_','/')),ch=>ch.charCodeAt(0)));
   const header=JSON.parse(decode(parts[0]));if(header.alg!=='Ed25519'||header.typ!==permissionType)throw 0;
   const payloadJson=decode(parts[1]),payload=trustPermissionSchema.parse(JSON.parse(payloadJson));
   if(['id','operationId','kind','subjectId','endpoint','bindingId','keyId','epoch'].some(key=>payload[key]!==r[key]))throw 0;
   return {payloadJson,payload};
  }catch{throw fail('trust_operation_unavailable');}
 }
 function locator(r){return{kind:'trust-package-permission',operationKind:r.kind,operationId:r.operationId,id:r.id,
  signatureHash:r.signatureHash,subjectId:r.subjectId,endpoint:r.endpoint};}
 const definiteRejection=e=>e?.outcome==='rejected'&&Number.isInteger(e.status)&&e.status>=400&&e.status<500
  &&![401,408,429].includes(e.status)&&!['access_denied','connection_required','binding_required','binding_expired','invalid_token'].includes(e.code);
 async function record(c,r){await same(c);await putLocal('trust-package:permission:'+r.operationId,r,c.identity.subjectId);await same(c);
  const ids=await getLocal(index,c.identity.subjectId)??[];await same(c);if(!ids.includes(r.operationId)){await putLocal(index,[...ids,r.operationId],c.identity.subjectId);await same(c);}}
 function receiptMatches(r,receipt){return receipt.state==='recorded'&&(r.kind==='grant'?receipt.operationId===r.operationId&&receipt.signatureHash===r.signatureHash:
   receipt.revokeOperationId===r.operationId&&receipt.revokeSignatureHash===r.signatureHash);}
 async function reconcileWithin(c,r){network();const receipt=await api.call('/v2/trust-package/permissions/receipt',{id:r.id});await same(c);
  if(receipt.id!==r.id)throw fail('trust_receipt_mismatch');
  if(receiptMatches(r,receipt)){r.state='acknowledged';r.receipt=receipt;await record(c,r);return {...receipt,reconciled:true};}
  if(receipt.state==='absent'||r.kind==='revoke'&&receipt.state==='recorded'&&!receipt.revokeOperationId)return {id:r.id,state:'absent',operationId:r.operationId};
  throw fail('trust_operation_conflict');}
 function retryReason(c,r){const {payload}=original(r);
  if(payload.expiresAt<=now())return'authorization-expired';
  if(Math.abs(payload.issuedAt-now())>300)return'original-signature-stale';
  // A local session generation fences in-flight work; it is not part of the
  // saved permission's authority. Refresh can resume the same valid binding.
  if(r.bindingId!==c.bindingId||r.keyId!==c.keyId||r.epoch!==c.epoch)return'original-binding-changed';
  return null;
 }
 async function send(c,r){await same(c,{binding:true});network();r.state='result-unknown';await record(c,r);
  try{const receipt=await api.call('/v2/trust-package/permissions/submit',{signed:r.signed});await same(c);
   if(!receiptMatches(r,receipt))throw fail('trust_result_unknown');r.state='acknowledged';r.receipt=receipt;await record(c,r);return receipt;
  }catch(error){await same(c);if(error&&typeof error==='object')error.operationId=r.operationId;if(definiteRejection(error)){r.automaticRetryBlock={code:error.code,status:error.status,rejectedAt:now()};await record(c,r);}throw error;}
 }
 async function resumeWithin(c,r,{explicitRetry=false}={}){
  const receipt=await reconcileWithin(c,r);if(receipt.state!=='absent')return receipt;
  if(r.state==='stopped-local'&&!explicitRetry)return{...receipt,reason:'stopped-local'};
  const reason=retryReason(c,r);if(reason)return{...receipt,reason};
  if(r.automaticRetryBlock&&!explicitRetry)return{...receipt,reason:'business-rejected',rejection:copy(r.automaticRetryBlock)};
  if(explicitRetry){if(r.automaticRetryBlock)r.rejections=[...(r.rejections??[]),r.automaticRetryBlock];delete r.automaticRetryBlock;}
  return send(c,r);
 }
 async function reviewPending(operationId){const c=await lease();return serial(c,async()=>{
  const r=await load(c,operationId),receipt=await reconcileWithin(c,r),{payloadJson,payload}=original(r);
  const reason=receipt.state==='recorded'?null:retryReason(c,r)??(r.state==='stopped-local'?'stopped-local':r.automaticRetryBlock?'business-rejected':null);
  return {...locator(r),state:receipt.state==='recorded'?'acknowledged':r.state,payloadJson,payload,expiresAt:payload.expiresAt,
   audience:copy(payload.audience),grantee:payload.grantee,source:copy(payload.source),reason,
   canContinue:receipt.state==='absent'&&!retryReason(c,r),serverCancellationConfirmed:false};
 });}
 async function reviewAuthorization(operationId){const c=await lease();return serial(c,async()=>{
  const r=await load(c,operationId),receipt=await reconcileWithin(c,r),{payloadJson,payload}=original(r);
  const shown={...locator(r),payloadJson,payload,expiresAt:payload.expiresAt,audience:copy(payload.audience),grantee:payload.grantee,source:copy(payload.source)};
  if(receipt.state==='recorded')return{...shown,state:'acknowledged',receipt,canContinue:false};
  const reason=retryReason(c,r);
  if(!reason)return{...shown,state:'reuse-original-authorization',reason:r.automaticRetryBlock?'business-rejected':r.state==='stopped-local'?'stopped-local':null,canContinue:true};
  if(reason==='authorization-expired')return{...shown,state:'authorization-expired',reason,canContinue:false};
  // This is a new author signature only after the author sees the unchanged
  // scope. A lapsed grant is never extended to create this continuation.
  let prepared=await permissionPreview(r.kind==='grant'?{id:r.id,operationId:r.operationId,source:payload.source,
    grantee:payload.grantee,audience:payload.audience,expiresAt:payload.expiresAt}:{id:r.id,operationId:r.operationId},{revoke:r.kind==='revoke'});
  await same(c,{binding:true});let next=trustPermissionSchema.parse(JSON.parse(prepared.payloadJson));
  if(r.kind==='revoke'){
   // revoke-preview proposes its usual five-minute window. This author already
   // chose a shorter, still-valid absolute deadline; retain that earlier end.
   if(payload.expiresAt>next.expiresAt)throw fail('trust_permission_time_changed');
   next={...next,expiresAt:payload.expiresAt};const value={...previews.get(prepared).value,payloadJson:trustCanonical(next)},hash=await trustHash(trustCanonical(value));await same(c,{binding:true});
   prepared=Object.freeze({...value,state:'ready'});previews.set(prepared,{kind:'permission',c,value:copy(value),hash,used:false});
  }
  if(['id','operationId','kind','source','sourceHash','grantee','audience','originalSignatureHash','expiresAt'].some(key=>trustCanonical(next[key])!==trustCanonical(payload[key])))throw fail('trust_source_changed');
  const review=Object.freeze({...shown,state:'reauthorization-required',reason,canContinue:true,newPayloadJson:prepared.payloadJson});
  const hash=await trustHash(trustCanonical(review));await same(c,{binding:true});
  continuations.set(review,{c,operationId,signatureHash:r.signatureHash,payloadJson,prepared,hash,used:false});return review;
 });}
 /** @param {any} review @param {{confirmed?:boolean,onJournal?:(locator:any)=>Promise<void>|void}} [options] */
 async function reauthorize(review,{confirmed=false,onJournal}={}){
  const p=continuations.get(review);if(!confirmed||!p||p.used)throw fail('trust_preview_required');
  const hash=await trustHash(trustCanonical(review));await same(p.c,{binding:true});if(hash!==p.hash)throw fail('trust_preview_changed');
  return serial(p.c,async()=>{if(p.used)throw fail('trust_preview_required');const r=await load(p.c,p.operationId),receipt=await reconcileWithin(p.c,r);
   if(receipt.state==='recorded')return receipt;
   if(r.signatureHash!==p.signatureHash||original(r).payloadJson!==p.payloadJson)throw fail('trust_preview_changed');
   const prepared=previews.get(p.prepared);if(!prepared||prepared.used)throw fail('trust_preview_required');
   const old=original(r).payload,next=trustPermissionSchema.parse(JSON.parse(prepared.value.payloadJson));
   if(old.expiresAt<=now()||next.expiresAt!==old.expiresAt)throw fail('trust_permission_time_changed');
   p.used=true;prepared.used=true;
   const signed=await sign(prepared.value.payloadJson,permissionType,{subjectId:p.c.identity.subjectId,keyId:p.c.keyId,epoch:p.c.epoch});await same(p.c,{binding:true});
   const signatureHash=await trustHash(signed);await same(p.c,{binding:true});
   const revised={...r,bindingId:next.bindingId,keyId:next.keyId,epoch:next.epoch,generation:p.c.generation??null,signed,signatureHash,state:'prepared',
    signatureHistory:[...(r.signatureHistory??[]),{signed:r.signed,signatureHash:r.signatureHash,bindingId:r.bindingId,keyId:r.keyId,epoch:r.epoch}]};
   if(r.automaticRetryBlock)revised.rejections=[...(r.rejections??[]),r.automaticRetryBlock];delete revised.automaticRetryBlock;
   await record(p.c,revised);if(onJournal){await onJournal(Object.freeze(locator(revised)));await same(p.c,{binding:true});}return send(p.c,revised);
  });
 }
 async function receiptFor(selected){const c=await lease();return serial(c,async()=>{
  if(selected?.kind!=='trust-package-permission'||selected.subjectId!==c.identity.subjectId||selected.endpoint!==c.endpoint
   ||!['grant','revoke'].includes(selected.operationKind)||typeof selected.signatureHash!=='string'||!/^[a-f0-9]{64}$/.test(selected.signatureHash))throw fail('trust_operation_unavailable');
  const receipt=await api.call('/v2/trust-package/permissions/receipt',{id:selected.id});await same(c);
  if(receipt.id!==selected.id)throw fail('trust_receipt_mismatch');
  const matched=receipt.state==='recorded'&&(selected.operationKind==='grant'?receipt.operationId===selected.operationId&&receipt.signatureHash===selected.signatureHash:
   receipt.revokeOperationId===selected.operationId&&receipt.revokeSignatureHash===selected.signatureHash);
  return {...receipt,state:matched?'acknowledged':receipt.state==='recorded'&&(selected.operationKind==='grant'||receipt.revokeOperationId)?'conflict':'absent',businessState:receipt.state,operationId:selected.operationId,
   signatureHash:selected.signatureHash,exactOperationConfirmed:matched,externalCopiesDeleted:false};
 });}
 /** @param {any} preview @param {{confirmed?:boolean,onJournal?:(locator:any)=>Promise<void>|void}} [options] */
 async function executePermission(preview,{confirmed=false,onJournal}={}){
  const p=previews.get(preview);if(!confirmed||!p||p.kind!=='permission'||p.used)throw fail('trust_preview_required');
  const{state:_state,...shown}=preview,hash=await trustHash(trustCanonical(shown));await same(p.c,{binding:true});if(hash!==p.hash)throw fail('trust_preview_changed');
  return serial(p.c,async()=>{await same(p.c,{binding:true});if(p.used)throw fail('trust_preview_required');p.used=true;
   const payload=trustPermissionSchema.parse(JSON.parse(p.value.payloadJson)),signed=await sign(p.value.payloadJson,permissionType,
     {subjectId:p.c.identity.subjectId,keyId:p.c.keyId,epoch:p.c.epoch});await same(p.c,{binding:true});
   const signatureHash=await trustHash(signed);await same(p.c,{binding:true});
   const r={operationId:payload.operationId,id:payload.id,kind:payload.kind,subjectId:payload.subjectId,endpoint:payload.endpoint,
     bindingId:payload.bindingId,generation:p.c.generation??null,keyId:payload.keyId,epoch:payload.epoch,signed,signatureHash,state:'prepared'};
   await record(p.c,r);
   if(onJournal){await onJournal(Object.freeze(locator(r)));await same(p.c,{binding:true});}
   return send(p.c,r);
  });
 }
 async function pending(){const c=await lease(),ids=await getLocal(index,c.identity.subjectId)??[];await same(c);const out=[];
  for(const id of ids){const r=await load(c,id);if(r.state!=='acknowledged')out.push({operationId:id,id:r.id,kind:r.kind,state:r.state});}return out;}
 async function reconcile(operationId){const c=await lease();return serial(c,async()=>reconcileWithin(c,await load(c,operationId)));}
 async function retry(operationId){const c=await lease();return serial(c,async()=>{
  const r=await load(c,operationId);return resumeWithin(c,r,{explicitRetry:true});
 });}
 async function resumePending(){const c=await lease();return serial(c,async()=>{
  const ids=await getLocal(index,c.identity.subjectId)??[];await same(c);const results=[];
  for(const operationId of ids){const r=await load(c,operationId);if(r.state==='acknowledged')continue;
   results.push(await resumeWithin(c,r));
  }
  return results;
 });}
 async function stopRetry(operationId){const c=await lease();return serial(c,async()=>{const r=await load(c,operationId),receipt=await reconcileWithin(c,r);
  if(receipt.state!=='absent')return receipt;r.state='stopped-local';await record(c,r);return {state:'stopped-local',id:r.id,operationId,
    serverCancellationConfirmed:false,lateReceiptCanBeReconciled:true};});}
 async function checkOnline(container,{selectedEndpoint}={}){
  container=copy(container);const c=await lease(),offline=await verifyTrustPackage(container,{now:now()});await same(c);
  network();if(selectedEndpoint!==api.endpoint)throw fail('trust_selected_endpoint_required');
  const objects=JSON.parse(container.files['objects.json']),items=[];
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
  await same(c);return {offline,online:{selectedEndpoint,checkedAt:now(),control,items,capabilityVerified:false},uploadedPackage:false};
 }
 async function vcLease(){
  const c=await lease(),binding=api?.snapshot?.();
  if(binding?.subjectId&&binding.subjectId!==c.identity.subjectId)throw fail('trust_vc_identity_changed');
  return {...c,endpoint:c.endpoint??api?.endpoint??null,bindingId:c.bindingId??binding?.bindingId??null,generation:c.generation??binding?.generation??null};
 }
 async function sameVc(c){assertLease(c.guard,'trust_vc_identity_changed');const next=await vcLease();assertLease(c.guard,'trust_vc_identity_changed');
  if(next.identity.subjectId!==c.identity.subjectId||next.keyId!==c.keyId||next.epoch!==c.epoch||next.endpoint!==c.endpoint
    ||next.bindingId!==c.bindingId||next.generation!==c.generation)throw fail('trust_vc_identity_changed');return next;}
 async function serialVc(c,fn){const name='galaxy-trust:'+c.identity.subjectId;
  const work=async()=>{await sameVc(c);const value=await fn();await sameVc(c);return value;};
  if(locks?.request)return locks.request(name,{mode:'exclusive'},work);
  const result=(lanes.get(name)??Promise.resolve()).catch(()=>{}).then(work);lanes.set(name,result);
  return result.finally(()=>{if(lanes.get(name)===result)lanes.delete(name);});
 }
 async function checkVcSources(c,container){
  const objects=JSON.parse(container.files['objects.json']);if(!objects.sources.length)return;
  await sameVc(c);network();if(api.endpoint!==c.endpoint)throw fail('trust_selected_endpoint_required');
  const selections=objects.sources.map(source=>({ref:source.ref,mode:source.mode,
   ...(source.permission?{permissionId:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(source.permission.signed.split('.')[1]
    .replaceAll('-','+').replaceAll('_','/')),ch=>ch.charCodeAt(0)))).id}:{})}));
  const checked=await api.call('/v2/trust-package/sources',{selections,audience:objects.audience,expiresAt:objects.expiresAt});await sameVc(c);
  if(checked.items.length!==objects.sources.length||checked.items.some((item,index)=>item.state!=='available'
    ||item.snapshot.sourceHash!==objects.sources[index].sourceHash||item.snapshot.sourceState!==objects.sources[index].sourceState
    ||item.snapshot.authorId!==objects.sources[index].authorId))throw fail('trust_source_changed');
 }
 async function prepareVcPackage(container){
  const c=await vcLease(),value=await prepareTrustPackageVcJose(container,{now:now()});await sameVc(c);
  const manifest=JSON.parse(value.package.manifestJson);
  if(manifest.subjectId!==c.identity.subjectId||manifest.keyId!==c.keyId||manifest.epoch!==c.epoch)throw fail('trust_vc_signer_mismatch');
  await checkVcSources(c,value.package);await sameVc(c);
  const hash=await trustHash(trustCanonical(value));await sameVc(c);
  const preview=Object.freeze({...value,state:'ready'});previews.set(preview,{kind:'vc-package',c,value:copy(value),hash,used:false});return preview;
 }
 async function exportVcPackage(preview,{confirmed=false}={}){
  const p=previews.get(preview);if(!confirmed||!p||p.kind!=='vc-package'||p.used)throw fail('trust_preview_required');
  const{state:_state,...shown}=preview,hash=await trustHash(trustCanonical(shown));await sameVc(p.c);
  if(hash!==p.hash)throw fail('trust_preview_changed');if(typeof signVc!=='function')throw fail('trust_vc_signer_unavailable');
  return serialVc(p.c,async()=>{if(p.used)throw fail('trust_preview_required');await checkVcSources(p.c,p.value.package);await sameVc(p.c);p.used=true;
   const signature=await signVc(p.value,{subjectId:p.c.identity.subjectId,keyId:p.c.keyId,epoch:p.c.epoch,endpoint:p.c.endpoint,
    bindingId:p.c.bindingId,generation:p.c.generation});await sameVc(p.c);
   const bundle=await sealTrustPackageVcJose(p.value,signature,{now:now()});await sameVc(p.c);
   await putLocal('trust-package:last-vc-export',{subjectId:p.c.identity.subjectId,endpoint:p.c.endpoint,packageId:p.value.packageId,createdAt:now(),bundle},p.c.identity.subjectId);await sameVc(p.c);
   return {bundle,packageId:p.value.packageId,remotePublished:false,localSaved:true};
  });
 }
 async function lastVcExport(){const c=await vcLease(),value=await getLocal('trust-package:last-vc-export',c.identity.subjectId);await sameVc(c);
  if(!value)return null;const manifest=JSON.parse(value.bundle.package.manifestJson);
  return manifest.subjectId===c.identity.subjectId&&value.subjectId===c.identity.subjectId&&value.endpoint===c.endpoint?value:null;
 }
 return Object.freeze({prepare,exportPackage,permissionPreview,executePermission,pending,reconcile,retry,resumePending,reviewPending,reviewAuthorization,reauthorize,receiptFor,stopRetry,checkOnline,
  prepareVcPackage,exportVcPackage,importVcPackage:verifyTrustPackageVcJose,lastVcExport,
  importPackage:(input,options)=>verifyTrustPackage(input,options),
  lastExport:async()=>{const c=await lease(),value=await getLocal('trust-package:last-export',c.identity.subjectId);await same(c);
   if(!value)return null;return JSON.parse(value.container.manifestJson).subjectId===c.identity.subjectId?value:null;},
  deleteLocalExport:async()=>{const c=await lease();return serial(c,async()=>{await putLocal('trust-package:last-export',null,c.identity.subjectId);await same(c);});}});
}
