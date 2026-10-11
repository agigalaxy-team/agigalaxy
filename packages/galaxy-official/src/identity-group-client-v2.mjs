import {identityGroupIntentSchema,identityGroupProofSchema,identityGroupSignatureType} from './shared/identity-group-v2-schema.mjs';
import {equalJson,sha256Hex} from './shared/web-primitives.mjs';
const fail=code=>Object.assign(new Error(code),{code}),copy=value=>structuredClone(value);
const closedStates=new Set(['committed','declined','cancelled','conflict','expired']);
export function createIdentityGroupClientV2({api,sign,getLocal,putLocal,updateLocal=null,captureLease=null,subjectId,now=()=>Math.floor(Date.now()/1000),locks=globalThis.navigator?.locks}){
 const endpoint=api.endpoint,key='identity-group-v2:'+endpoint+':'+subjectId,previews=new WeakMap();let queue=Promise.resolve();
 const stamp=()=>{const b=api.snapshot();return JSON.stringify([api.endpoint,b?.subjectId??null,b?.bindingId??null,b?.generation??null,b?.control?.deviceId??null,b?.control?.keyId??null,b?.control?.epoch??null]);};
 function capture(){const tag=stamp(),outer=captureLease?.(),b=api.snapshot();
  const check=()=>{outer?.assertCurrent();if(api.endpoint!==endpoint||stamp()!==tag||!b||b.subjectId!==subjectId||outer&&(outer.endpoint!==endpoint||outer.subjectId!==subjectId))throw fail('identity_group_identity_changed');};
  check();return{check,bindingId:b.bindingId};}
 async function guard(lease,fn){lease.check();try{const value=await fn();lease.check();return value;}catch(error){lease.check();throw error;}}
 const serial=fn=>{let lease;try{lease=capture();}catch(error){return Promise.reject(error);}const invoke=()=>guard(lease,()=>fn(lease)),run=()=>locks?.request?locks.request(key,{mode:'exclusive'},invoke):invoke();const next=queue.then(run,run);queue=next.catch(()=>{});return next;};
 const call=(lease,path,input,options)=>guard(lease,()=>api.call(path,input,options));
 const read=(path,input,options)=>call(capture(),path,input,options);
 const currentWithin=lease=>call(lease,'/v2/identity-groups/current',undefined,{method:'GET'});
 const load=lease=>guard(lease,async()=>await getLocal(key)??{pending:[],receipts:[],originals:[]});
 const update=(lease,change)=>guard(lease,async()=>{
  if(updateLocal)return updateLocal(key,value=>{lease.check();return change(value??{pending:[],receipts:[],originals:[]});});
  // Existing SDK consumers retain their serial lock. The Web adapter always
  // supplies the atomic store update; no read/put fallback runs in that path.
  const value=await load(lease),next=change(value);await guard(lease,()=>putLocal(key,next));return next;
 });
 const locatorFor=row=>({endpoint,ownerId:subjectId,operationId:row.operationId,groupId:row.groupId,proofId:row.proofId,payloadHash:row.payloadHash});
 function locator(input){if(!input||input.endpoint!==endpoint||input.ownerId!==subjectId||!input.groupId||!input.operationId||!input.proofId||!/^[a-f0-9]{64}$/.test(input.payloadHash))throw fail('identity_group_locator_mismatch');return copy(input);}
 const matches=(row,id)=>row&&row.operationId===id.operationId&&row.groupId===id.groupId&&row.proofId===id.proofId&&row.payloadHash===id.payloadHash;
 async function exact(row,lease){let p,proof;try{p=identityGroupIntentSchema.parse(JSON.parse(row.payloadJson));proof=identityGroupProofSchema.parse(JSON.parse(row.proofJson));}catch{throw fail('identity_group_original_changed');}
  if(p.endpoint!==endpoint||proof.endpoint!==endpoint||proof.subjectId!==subjectId||p.operationId!==row.operationId||p.groupId!==row.groupId||proof.operationId!==p.operationId||proof.groupId!==p.groupId||proof.id!==row.proofId||proof.payloadHash!==row.payloadHash||proof.expiresAt!==p.expiresAt||await guard(lease,()=>sha256Hex(row.payloadJson))!==row.payloadHash)throw fail('identity_group_original_changed');
  return{payload:p,proof};
 }
 async function replace(lease,row,change){let saved;await update(lease,state=>{const found=state.pending.find(item=>item.proofId===row.proofId);if(!equalJson(found,row))throw fail('identity_group_operation_changed');
  if(found.state==='stopped-local'&&change.state!=='stopped-local')throw fail('identity_group_local_retry_stopped');saved={...row,...change,journalRevision:(row.journalRevision??0)+1};return{...state,pending:state.pending.map(item=>item.proofId===row.proofId?saved:item)};});return copy(saved);}
 function statusFor(result,id){if(result.operationId!==id.operationId||result.state!=='absent'&&(result.groupId!==id.groupId||result.payloadHash!==id.payloadHash))throw fail('identity_group_receipt_mismatch');
  const own=result.acknowledgedProofIds?.includes(id.proofId)??result.approvals?.some(a=>a.id===id.proofId&&a.subjectId===subjectId)??false;
  return{...result,locator:id,operationState:result.state,ownApprovalAcknowledged:!!own,operationClosed:closedStates.has(result.state),serverCancellationConfirmed:result.state==='cancelled'};
 }
 const normalized=result=>({...result,state:result.ownApprovalAcknowledged?'acknowledged':result.operationState??result.state});
 async function receiptWithin(input,lease){const id=locator(input),result=await call(lease,'/v2/identity-groups/receipt',{operationId:id.operationId,payloadHash:id.payloadHash});return statusFor(result,id);}
 async function settle(lease,row,result){if(!result.ownApprovalAcknowledged&&!result.operationClosed)return result;
  await update(lease,state=>{const found=state.pending.find(item=>matches(item,locatorFor(row)));if(!found)return state;
   const original={...found,receipt:result,state:found.state==='stopped-local'?'stopped-local':result.ownApprovalAcknowledged?'acknowledged':'operation-closed'};
   return{...state,pending:state.pending.filter(item=>!matches(item,locatorFor(row))),originals:[original,...(state.originals??[]).filter(item=>item.proofId!==row.proofId)],receipts:[{...locatorFor(row),result},...(state.receipts??[]).filter(item=>item.proofId!==row.proofId)].slice(0,50)};
  });return result;}
 async function reconcileRow(row,lease){await exact(row,lease);return settle(lease,row,await receiptWithin(locatorFor(row),lease));}
 async function find(proofId,lease,{archive=false}={}){const state=await load(lease),row=state.pending.find(item=>item.proofId===proofId)??(archive?(state.originals??[]).find(item=>item.proofId===proofId):null);if(!row)throw fail('identity_group_local_operation_unavailable');return row;}
 async function blocked(row,lease,reason,error=null){const businessFailure=error?{code:error.code??'request_failed',status:error.status??null}:row.businessFailure;
  if(row.blockedReason!==reason||!equalJson(row.businessFailure,businessFailure))row=await replace(lease,row,{blockedReason:reason,...(error?{businessFailure}:{})});
  return{state:'blocked',reason,locator:locatorFor(row),operationState:null,ownApprovalAcknowledged:false,operationClosed:false,...(businessFailure?{businessFailure}:{})};}
 const businessRejected=error=>error?.outcome==='rejected'&&Number.isInteger(error.status)&&error.status>=400&&error.status<500&&![401,408,429].includes(error.status)
  &&!['unauthorized','binding_revoked','binding_unavailable','invalid_session','session_expired','access_denied','connection_required','browser_origin_not_enabled','browser_preflight_denied','identity_group_control_changed','identity_control_stale'].includes(error.code);
 async function availability(row,lease){const {payload,proof}=await exact(row,lease);if(payload.expiresAt<=now()||proof.expiresAt<=now())return'proposal-expired';
  if(!row.signature)return'explicit-approval-required';if(!row.bindingId)return'original-binding-unavailable';if(row.bindingId!==lease.bindingId)return'binding-changed';
  const c=await currentWithin(lease);if(c.subjectId!==subjectId||c.keyId!==proof.keyId||c.epoch!==proof.epoch)return'control-changed';return null;}
 async function send(row,lease){await exact(row,lease);row=await replace(lease,row,{attempted:true});let result;
  try{result=await call(lease,'/v2/identity-groups/submit',{payloadJson:row.payloadJson,proofJson:row.proofJson,signature:row.signature});}
  catch(error){if(businessRejected(error))await blocked(row,lease,'business-declined',error);throw error;}
  const status=statusFor(result,locatorFor(row));if(!status.ownApprovalAcknowledged&&!status.operationClosed)throw fail('identity_group_receipt_mismatch');return settle(lease,row,status);}
 async function prepareBytes(payloadJson,decision,lease,renewal=null){const p=identityGroupIntentSchema.parse(JSON.parse(payloadJson)),c=await currentWithin(lease);
  if(c.subjectId!==subjectId||p.endpoint!==endpoint)throw fail('identity_group_identity_changed');if(p.expiresAt<=now())throw fail('identity_group_proposal_expired');
  const proof={schemaVersion:2,id:crypto.randomUUID(),operationId:p.operationId,groupId:p.groupId,payloadHash:await guard(lease,()=>sha256Hex(payloadJson)),endpoint,subjectId,keyId:c.keyId,epoch:c.epoch,decision,issuedAt:now(),expiresAt:p.expiresAt};
  const preview={payload:p,payloadHash:proof.payloadHash,subjectId,decision,scope:'canonical-display-only; original-source-permissions-remain',control:{keyId:c.keyId,epoch:c.epoch}};
  previews.set(preview,{lease,payloadJson,proofJson:JSON.stringify(proof),serialized:JSON.stringify(preview),used:false,renewal});return preview;}
 async function resumeRow(row,lease,{explicitRetry=false}={}){const status=await reconcileRow(row,lease);if(status.ownApprovalAcknowledged||status.operationClosed)return normalized(status);
  if(row.state==='stopped-local')return{...normalized(status),localRetryStopped:true,reason:'stopped-local'};
  if(row.businessFailure&&!explicitRetry)return blocked(row,lease,'business-declined');
  const reason=await availability(row,lease);if(reason)return blocked(row,lease,reason);
  row=await replace(lease,row,{blockedReason:null,...(explicitRetry?{businessFailure:null}:{})});return normalized(await send(row,lease));}
 const methods={
  current:()=>currentWithin(capture()),source:input=>read('/v2/identity-groups/source',input),
  prepare:input=>{const value=copy(input);return serial(lease=>prepareBytes(JSON.stringify(identityGroupIntentSchema.parse(value)),'approve',lease));},
  prepareResponse:(operationId,decision='approve')=>serial(async lease=>{if(!['approve','decline','cancel'].includes(decision))throw fail('invalid_identity_group');
   const p=await call(lease,'/v2/identity-groups/operations/'+operationId,undefined,{method:'GET'});if(!p.payloadJson)throw fail('identity_group_source_unavailable');if(Array.isArray(p.availableActions)&&!p.availableActions.includes(decision))throw fail('identity_group_action_unavailable');return prepareBytes(p.payloadJson,decision,lease);}),
  execute(preview,{confirmed=false,onJournal=/** @type {null|((locator:any)=>unknown)} */(null)}={}){return serial(async lease=>{
   const token=previews.get(preview);if(!confirmed||!token||token.used||token.serialized!==JSON.stringify(preview))throw fail('identity_group_preview_required');token.lease.check();
   if(token.renewal){const original=await find(token.renewal.proofId,lease);if(!equalJson(original,token.renewal))throw fail('identity_group_operation_changed');const result=await reconcileRow(original,lease);if(result.ownApprovalAcknowledged||result.operationClosed)return result;}
   const proof=identityGroupProofSchema.parse(JSON.parse(token.proofJson)),row={operationId:proof.operationId,groupId:proof.groupId,proofId:proof.id,payloadHash:proof.payloadHash,payloadJson:token.payloadJson,proofJson:token.proofJson,signature:null,state:'prepared',bindingId:lease.bindingId,journalRevision:1};await exact(row,lease);
   await update(lease,state=>{const previous=state.pending.find(item=>item.operationId===row.operationId);if(previous&&!token.renewal)throw fail('identity_group_operation_pending');if(token.renewal&&!equalJson(previous,token.renewal))throw fail('identity_group_operation_changed');
    if((state.originals??[]).some(item=>item.proofId===row.proofId))throw fail('identity_group_operation_changed');
    return{...state,pending:[...state.pending.filter(item=>item.proofId!==previous?.proofId),row],originals:[...(previous?[{...previous,supersededBy:row.proofId}]:[]),...(state.originals??[])]};});token.used=true;
   if(onJournal)await guard(lease,()=>onJournal(locatorFor(row)));
   const signature=await guard(lease,()=>sign(row.proofJson,identityGroupSignatureType,{subjectId,keyId:proof.keyId,epoch:proof.epoch}));
   const signed=await replace(lease,row,{signature});return send(signed,lease);
  });},
  pending:()=>serial(async lease=>(await load(lease)).pending.map(({signature:_signature,payloadJson:_payloadJson,proofJson:_proofJson,...row})=>({...row,locator:locatorFor(row)}))),
  receiptFor:input=>{const chosen=copy(input);return serial(async lease=>normalized(await receiptWithin(chosen,lease)));},
  resumePending:({explicitRetry=false}={})=>serial(async lease=>{const rows=(await load(lease)).pending,items=[];for(const original of rows){try{const latest=(await load(lease)).pending.find(item=>item.proofId===original.proofId);if(!latest)continue;items.push(await resumeRow(latest,lease,{explicitRetry}));}catch(error){lease.check();items.push({state:'blocked',reason:'read-or-send-unavailable',locator:locatorFor(original),error:{code:error.code??'request_failed',status:error.status??null}});}}return{items};}),
  reviewPending:proofId=>serial(async lease=>{const row=await find(proofId,lease);if(row.state==='stopped-local')throw fail('identity_group_local_retry_stopped');const result=await reconcileRow(row,lease);if(result.ownApprovalAcknowledged||result.operationClosed)throw fail('identity_group_operation_closed');
   if(!['absent','pending'].includes(result.state))throw fail('identity_group_operation_conflict');return prepareBytes(row.payloadJson,JSON.parse(row.proofJson).decision,lease,copy(row));}),
  reconcile:proofId=>serial(async lease=>reconcileRow(await find(proofId,lease,{archive:true}),lease)),
  retry:(proofId,{explicitRetry=false}={})=>serial(async lease=>{const row=await find(proofId,lease,{archive:true}),status=await reconcileRow(row,lease);if(status.ownApprovalAcknowledged||status.operationClosed)return status;
   if(row.state==='stopped-local')throw fail('identity_group_local_retry_stopped');if(row.supersededBy)throw fail('identity_group_explicit_new_approval_required');
   if(row.businessFailure&&!explicitRetry)return blocked(row,lease,'business-declined');const reason=await availability(row,lease);if(reason)throw fail(reason==='proposal-expired'?'identity_group_proposal_expired':'identity_group_explicit_new_approval_required');
   return send(explicitRetry?await replace(lease,row,{businessFailure:null,blockedReason:null}):row,lease);}),
  stopLocalRetry:(proofId,{confirmed=false}={})=>serial(async lease=>{if(!confirmed)throw fail('identity_group_preview_required');const row=await find(proofId,lease),status=await reconcileRow(row,lease);if(status.ownApprovalAcknowledged||status.operationClosed)return status;
   if(row.state!=='stopped-local')await replace(lease,row,{state:'stopped-local'});return{...status,localRetryStopped:true,serverCancellationConfirmed:false};}),
  proposal:id=>read('/v2/identity-groups/operations/'+id,undefined,{method:'GET'}),read:id=>read('/v2/identity-groups/'+id,undefined,{method:'GET'}),
  query:input=>read('/v2/identity-groups/query',input??{}),resolve:id=>read('/v2/identity-groups/resolve',{subjectId:id}),
  invitations:({after,limit=20,direction='all'}={})=>serial(async lease=>{const result=await call(lease,'/v2/identity-groups/query',{includeProposals:true,proposalLimit:limit,proposalDirection:direction,...(after?{proposalAfter:after}:{})});return{items:result.proposals??[],next:result.proposalNext??null};}),
  withContinuity:({updateLocal:atomic,captureLease:lease,now:clock=now,locks:lockManager=locks}={})=>{if(typeof atomic!=='function'||typeof lease!=='function')throw fail('identity_group_atomic_continuity_required');return createIdentityGroupClientV2({api,sign,getLocal,putLocal,updateLocal:atomic,captureLease:lease,subjectId,now:clock,locks:lockManager});},
 };
 return Object.freeze(methods);
}
