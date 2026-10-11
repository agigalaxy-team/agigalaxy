import {randomUUID} from 'node:crypto';
import * as z from 'zod/v4';
import {nativeResult} from '../../packages/galaxy-edge-mcp/src/native-v2/choice.mjs';

export const nativeDeviceManagementReadSchema=z.discriminatedUnion('action',[
 z.strictObject({action:z.enum(['current','list','pending'])}),
 z.strictObject({action:z.literal('reconcile'),operationId:z.uuid()}),
]);
export const nativeDeviceManagementPrepareSchema=z.strictObject({deviceId:z.uuid()});
export const nativeDeviceManagementConfirmSchema=z.strictObject({previewId:z.uuid()});
export const nativeDeviceManagementStopSchema=z.strictObject({operationId:z.uuid()});
const fail=(condition,code)=>{if(!condition)throw Object.assign(new Error(code),{code});};
const terminal=result=>['committed','canceled','expired'].includes(result?.receipt?.state??result?.state);

// MCP receives an opaque reference, never the ability to invent a local
// confirmation. The original WeakMap preview remains in this process.
export function registerNativeDeviceManagementTools(server,{runtime,review,now=()=>Date.now()}){
 fail(typeof review==='function'&&runtime?.deviceManagement&&typeof runtime?.receiptStatus?.captureLease==='function'
  &&typeof runtime?.api?.snapshot==='function','device_management_native_dependencies_required');
 const endpoint=runtime.api.endpoint,client=runtime.deviceManagement,previews=new Map(),inFlight=new Set();
 let closed=false,closing,reservedPreviews=0;
 const authorizationContext=lease=>({subjectId:lease.subjectId,deviceId:lease.deviceId,endpoint,
  bindingId:lease.bindingId??null,generation:lease.generation??null});
 const check=lease=>{
  fail(!closed,'device_management_native_closed');lease.assertCurrent();const s=runtime.api.snapshot();
  fail(runtime.deviceManagement===client&&runtime.api.endpoint===endpoint&&lease.endpoint===endpoint
   &&(s?.subjectId??lease.subjectId)===lease.subjectId&&(s?.bindingId??null)===(lease.bindingId??null)
   &&(s?.generation??null)===(lease.generation??null),'device_management_native_connection_changed');
 };
 const capture=()=>{fail(!closed,'device_management_native_closed');const lease=runtime.receiptStatus.captureLease();
  fail(lease?.subjectId&&lease.deviceId&&typeof lease.assertCurrent==='function','device_management_native_identity_required');check(lease);return lease;};
 const current=async(lease,fn)=>{check(lease);let value;try{value=await fn();}catch(error){check(lease);throw error;}check(lease);return value;};
 const prune=()=>{for(const[id,p]of previews)if(p.state!=='running'){
  let stale=false;try{check(p.lease);}catch{stale=true;}
  if(stale||p.expiresAt<=now()||p.state==='completed')previews.delete(id);
 }};
 const releaseOriginal=operationId=>{for(const[id,p]of previews)if(p.original.operationId===operationId&&p.state!=='running')previews.delete(id);};
 const errorResult=error=>{const code=error.code??error.message;return{isError:true,...nativeResult({
  error:/^[a-z0-9_-]{1,100}$/.test(code)?code:'device_management_native_incomplete',
  originalOperationRetained:true,recoverWith:'galaxy_identity_device_native_read',privateResultWithheld:true})};};
 const run=fn=>{let lease;try{lease=capture();}catch(error){return Promise.resolve(errorResult(error));}
  const pending=Promise.resolve().then(()=>current(lease,()=>fn(lease))).catch(error=>errorResult(error));
  inFlight.add(pending);pending.then(()=>inFlight.delete(pending),()=>inFlight.delete(pending));return pending;};
 const register=(name,inputSchema,description,readOnlyHint,handler)=>server.registerTool(name,
  {inputSchema,description,annotations:{readOnlyHint}},(input,context)=>run(lease=>handler(inputSchema.parse(input),context,lease)));

 register('galaxy_identity_device_native_read',nativeDeviceManagementReadSchema,
  'Read devices controlled by this local identity on this authority, or original pending/receipt metadata. Reconcile only the original operation; no signing, device approval, binding, retry, recovery or data restoration.',true,
  async(input,_context,lease)=>{
   const result=await current(lease,()=>input.action==='reconcile'?client.reconcile(input.operationId):client[input.action]());
   if(input.action==='reconcile'&&terminal(result))releaseOriginal(input.operationId);
   return nativeResult(result);
  });
 register('galaxy_identity_device_native_prepare_revoke',nativeDeviceManagementPrepareSchema,
  'Prepare the exact target device, signer, epoch/head, original operation/challenge hashes, expiry and revocation effects. This registers an unsigned challenge only; no signature or device revocation. Device handoff cancellation is a separate action.',false,
  async(input,_context,lease)=>{
   prune();fail(previews.size+reservedPreviews<32,'device_management_native_preview_capacity');
   // Admission is synchronous: an awaiting prepare already owns one slot.
   // Convert that reservation to a saved preview without another await.
   reservedPreviews++;
   try{
    const original=await current(lease,()=>client.prepareRevoke(input));
    fail(original.subjectId===lease.subjectId&&original.initiatorDeviceId===lease.deviceId&&original.endpoint===endpoint
     &&original.kind==='revoke-device'&&Number.isSafeInteger(original.expiresAt),'device_management_native_preview_invalid');
    const expiresAt=Math.min(now()+180000,original.expiresAt*1000);
    fail(expiresAt>now(),'device_management_native_preview_expired');
    const previewId=randomUUID();previews.set(previewId,{original,lease,expiresAt,state:'prepared'});
    return nativeResult({previewId,operationId:original.operationId,state:'prepared',expiresAt,preview:original,
     signed:false,challengeRegistered:true,controlCommitted:false,privateKeyExported:false});
   }finally{reservedPreviews--;}
  });
 register('galaxy_identity_device_native_confirm',nativeDeviceManagementConfirmSchema,
  'Show the complete saved device-revocation preview on the actual native user-choice surface. Only that current original preview may sign once. Unknown results require original receipt reconciliation; a model confirmed field is forbidden.',false,
  async(input,context,lease)=>{
   prune();const p=previews.get(input.previewId);
   fail(p&&p.expiresAt>now(),'device_management_native_preview_expired_or_unavailable');check(p.lease);
   const retained=()=>({operationId:p.original.operationId,state:p.state,originalOperationRetained:true,
    remoteResent:false,currentAccessGranted:false,recoverWith:'galaxy_identity_device_native_read'});
   if(p.state!=='prepared')return nativeResult(retained());
   return current(lease,()=>review('galaxy_identity_device_native_confirm',{
    previewId:input.previewId,operationId:p.original.operationId,preview:structuredClone(p.original),authorizationContext:authorizationContext(lease),
   },context,async()=>{
    check(lease);check(p.lease);fail(previews.get(input.previewId)===p&&p.expiresAt>now(),'device_management_native_preview_expired_or_unavailable');
    if(p.state!=='prepared')return retained();
    p.state='running';
    try{const result=await current(lease,()=>client.confirm(p.original,{confirmed:true}));p.state='completed';
     releaseOriginal(p.original.operationId);return result;
    }catch(error){p.state='original-operation-needs-reconciliation';throw error;}
   }));
  });
 register('galaxy_identity_device_native_stop_retry',nativeDeviceManagementStopSchema,
  'Ask the actual user to stop only local retry of this exact original device operation. Keep its unknown proof/locator for read-only reconciliation. This does not cancel the server operation, restore device access or revoke another device.',false,
  async(input,context,lease)=>{
   const pending=await current(lease,()=>client.pending()),original=pending.active;
   fail(original?.operationId===input.operationId,'device_management_native_operation_unavailable');
   const exact=JSON.stringify(original);
   return current(lease,()=>review('galaxy_identity_device_native_stop_retry',{
    operationId:input.operationId,original,authorizationContext:authorizationContext(lease),scope:{localRetryStopped:true,serverCancellationConfirmed:false,
     currentAccessGranted:false,originalProofRetained:true},
   },context,async()=>{
    check(lease);const latest=await current(lease,()=>client.pending());
    fail(JSON.stringify(latest.active)===exact,'device_management_native_pending_changed');
    const result=await current(lease,()=>client.stopRetry(input.operationId,{confirmed:true}));
    releaseOriginal(input.operationId);return result;
   }));
  });
 return Object.freeze({close(){
  // Invalidate every saved/user-choice preview synchronously. Already started
  // authorized operations drain; their independent durable journal survives.
  closed=true;closing??=Promise.resolve().then(async()=>{await Promise.allSettled(inFlight);previews.clear();});return closing;
 }});
}
