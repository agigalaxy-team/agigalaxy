import {identityGroupIntentSchema,identityGroupSignatureType} from './shared/identity-group-v2-schema.mjs';
import {sha256Hex} from './shared/web-primitives.mjs';
const fail=code=>Object.assign(new Error(code),{code});
export function createIdentityGroupClientV2({api,sign,getLocal,putLocal,subjectId,now=()=>Math.floor(Date.now()/1000),locks=globalThis.navigator?.locks}){
 const key=`identity-group-v2:${api.endpoint}:${subjectId}`,previews=new WeakMap();let queue=Promise.resolve();
 const current=()=>api.call('/v2/identity-groups/current',undefined,{method:'GET'});
 const load=async()=>await getLocal(key)??{pending:[],receipts:[]},save=x=>putLocal(key,x);
 const withLock=fn=>{const run=()=>locks?locks.request(key,fn):fn();const p=queue.then(run,run);queue=p.catch(()=>{});return p;};
 function binding(){const b=api.snapshot();if(!b||b.subjectId!==subjectId)throw fail('identity_group_identity_changed');return b.bindingId;}
 const check=id=>{if(binding()!==id)throw fail('identity_group_identity_changed');};
 async function prepareBytes(payloadJson,decision){const before=binding(),p=identityGroupIntentSchema.parse(JSON.parse(payloadJson)),c=await current();check(before);
  if(c.subjectId!==subjectId||p.endpoint!==api.endpoint)throw fail('identity_group_identity_changed');
  const proof={schemaVersion:2,id:crypto.randomUUID(),operationId:p.operationId,groupId:p.groupId,payloadHash:await sha256Hex(payloadJson),endpoint:api.endpoint,
   subjectId,keyId:c.keyId,epoch:c.epoch,decision,issuedAt:now(),expiresAt:p.expiresAt};
  const preview={payload:p,payloadHash:proof.payloadHash,subjectId,decision,scope:'canonical-display-only; original-source-permissions-remain',control:{keyId:c.keyId,epoch:c.epoch}};
  previews.set(preview,{bindingId:before,payloadJson,proofJson:JSON.stringify(proof),serialized:JSON.stringify(preview),used:false});return preview;
 }
 async function reconcileRow(row){const result=await api.call('/v2/identity-groups/receipt',{operationId:row.operationId,payloadHash:row.payloadHash});
  const own=result.approvals?.some(a=>a.id===row.proofId&&a.subjectId===subjectId),accepted=own||['committed','declined','cancelled','conflict','expired'].includes(result.state)&&result.state!=='conflict';
  if(accepted){const state=await load();state.pending=state.pending.filter(x=>x.proofId!==row.proofId);state.receipts=[{operationId:row.operationId,groupId:row.groupId,proofId:row.proofId,result},...state.receipts].slice(0,50);await save(state);}
  return{...result,ownApprovalAcknowledged:!!own,serverCancellationConfirmed:result.state==='cancelled',operationClosed:accepted};
 }
 return Object.freeze({current,
  source:x=>api.call('/v2/identity-groups/source',x),
  async prepare(input){return prepareBytes(JSON.stringify(identityGroupIntentSchema.parse(input)),'approve');},
  async prepareResponse(operationId,decision='approve'){if(!['approve','decline','cancel'].includes(decision))throw fail('invalid_identity_group');
   const p=await api.call('/v2/identity-groups/operations/'+operationId,undefined,{method:'GET'});if(!p.payloadJson)throw fail('identity_group_source_unavailable');return prepareBytes(p.payloadJson,decision);},
  execute(preview,{confirmed}={}){return withLock(async()=>{const p=previews.get(preview);if(confirmed!==true||!p||p.used||p.serialized!==JSON.stringify(preview))throw fail('identity_group_preview_required');check(p.bindingId);p.used=true;
   const proof=JSON.parse(p.proofJson),row={operationId:proof.operationId,groupId:proof.groupId,proofId:proof.id,payloadHash:proof.payloadHash,payloadJson:p.payloadJson,proofJson:p.proofJson,signature:null,state:'prepared'};
   const state=await load();state.pending.push(row);await save(state);
   row.signature=await sign(row.proofJson,identityGroupSignatureType,{subjectId,keyId:proof.keyId,epoch:proof.epoch});check(p.bindingId);await save(state);
   const result=await api.call('/v2/identity-groups/submit',{payloadJson:row.payloadJson,proofJson:row.proofJson,signature:row.signature});
   await reconcileRow(row);return result;
  });},
  pending:async()=>(await load()).pending.map(({signature,payloadJson,proofJson,...row})=>row),
  reviewPending(proofId){return withLock(async()=>{const row=(await load()).pending.find(x=>x.proofId===proofId);if(!row)throw fail('identity_group_local_operation_unavailable');
   const result=await reconcileRow(row);if(result.ownApprovalAcknowledged||result.operationClosed)throw fail('identity_group_operation_closed');
   if(!['absent','pending'].includes(result.state))throw fail('identity_group_operation_conflict');
   // A new explicit confirmation signs the same operation bytes using current
   // control. The previous unknown receipt stays available for reconciliation.
   return prepareBytes(row.payloadJson,JSON.parse(row.proofJson).decision);});},
  reconcile(proofId){return withLock(async()=>{const row=(await load()).pending.find(x=>x.proofId===proofId);if(!row)throw fail('identity_group_local_operation_unavailable');return reconcileRow(row);});},
  retry(proofId){return withLock(async()=>{const row=(await load()).pending.find(x=>x.proofId===proofId);if(!row)throw fail('identity_group_local_operation_unavailable');const status=await reconcileRow(row);
   if(status.ownApprovalAcknowledged||status.operationClosed)return status;
   if(row.state==='stopped-local')throw fail('identity_group_local_retry_stopped');if(!row.signature)throw fail('identity_group_explicit_new_approval_required');
   const p=JSON.parse(row.proofJson),c=await current();if(c.subjectId!==subjectId||c.keyId!==p.keyId||c.epoch!==p.epoch)throw fail('identity_group_explicit_new_approval_required');
   const result=await api.call('/v2/identity-groups/submit',{payloadJson:row.payloadJson,proofJson:row.proofJson,signature:row.signature});await reconcileRow(row);return result;
  });},
  stopLocalRetry(proofId,{confirmed}={}){return withLock(async()=>{if(confirmed!==true)throw fail('identity_group_preview_required');const state=await load(),row=state.pending.find(x=>x.proofId===proofId);if(!row)throw fail('identity_group_local_operation_unavailable');
   const r=await reconcileRow(row);if(r.ownApprovalAcknowledged||r.operationClosed)return r;row.state='stopped-local';await save(state);return{...r,localRetryStopped:true,serverCancellationConfirmed:false};});},
  proposal:id=>api.call('/v2/identity-groups/operations/'+id,undefined,{method:'GET'}),
  read:id=>api.call('/v2/identity-groups/'+id,undefined,{method:'GET'}),
  query:x=>api.call('/v2/identity-groups/query',x??{}),resolve:subjectId=>api.call('/v2/identity-groups/resolve',{subjectId}),
 });
}
