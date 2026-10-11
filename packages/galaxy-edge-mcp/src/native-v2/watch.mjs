import {randomUUID,createHash} from 'node:crypto';
import * as z from 'zod/v4';
import {isAbsolute} from 'node:path';
const scope=z.strictObject({roomId:z.uuid(),agentGrantId:z.uuid(),purpose:z.string().min(1).max(500),expiresAt:z.number().int().positive().optional(),taskId:z.uuid().optional()});
export const nativeWatchStartSchema=scope;
export const nativeWatchResumeSchema=z.strictObject({id:z.uuid(),agentGrantId:z.uuid(),expiresAt:z.number().int().positive()});
export const nativeWatchHostSchema=z.strictObject({model:z.string().min(1).max(200),cwd:z.string().min(1).max(4000).refine(isAbsolute)});
// Host-driven checks, no timer or model provider. A lease lets one actual host
// process fetch work; an unchanged stream never invokes a model. Work is acked
// separately after the user's Agent really processes it.
export function createNativeWatch({store,api,subjectId,now=()=>Math.floor(Date.now()/1000),instanceId=randomUUID()}){
 const key='native-watch:'+api.endpoint+':'+subjectId;
 const initial=()=>({version:1,watches:{}}),read=async()=>await store.get(key)??initial();
 const update=change=>store.update(key,s=>change(s??initial()));
 async function start(input,{confirmed=false}={}){input=scope.parse(input);if(!confirmed)throw new Error('watch_choice_required');if(input.expiresAt!==undefined&&input.expiresAt<=now())throw new Error('watch_expired');
  const before=lease(),grants=await api.call('/v2/chat/rooms/'+input.roomId+'/agent-grants',{grantId:input.agentGrantId});
  if(!sameLease(before,lease()))throw Error('watch_binding_changed');
  const grant=grants.items?.find(g=>g.grantId===input.agentGrantId&&g.state==='active');if(!grant)throw new Error('active_room_agent_grant_required');
  if(grant.bindingId!==api.snapshot()?.bindingId)throw new Error('watch_current_binding_grant_required');
  input={...input,expiresAt:input.expiresAt??Math.min(now()+86400,grant.expiresAt)};
  if(!Number.isSafeInteger(input.expiresAt)||input.expiresAt<=now())throw Error('watch_expired');
  if(input.expiresAt>grant.expiresAt)throw new Error('watch_exceeds_agent_grant');
  const id=randomUUID();await update(s=>{if(Object.values(s.watches).some(w=>w.roomId===input.roomId&&w.state==='active'&&w.expiresAt>now()))throw new Error('watch_already_active');
   if(!sameLease(before,lease()))throw Error('watch_binding_changed');
   s.watches[id]={id,...input,bindingLease:before,state:'active',revision:1,after:'0',pending:null,failures:0,nextCheckAt:now(),lease:null};return s;});
  if(!sameLease(before,lease()))throw Error('watch_binding_changed');return status(id);
 }
 async function status(id){const s=await read();const rows=id?[s.watches[id]].filter(Boolean):Object.values(s.watches);
  return{items:rows.map(w=>({...w,state:w.state==='active'&&w.expiresAt<=now()?'expired':w.state,lease:undefined,
   hostRuntimeState:w.lease?.owner===instanceId&&w.lease.until>now()?'checking':'awaiting-host-check',modelRunning:false})),scheduledBy:'user-host',cloudModel:false,continuesAfterHostExit:false};}
 async function halt(id,final,{agentGrantId}={}){let target;await update(s=>{const w=s.watches[id];if(!w)throw new Error('watch_missing');
   if(agentGrantId&&w.agentGrantId!==agentGrantId)throw Error('watch_grant_changed');
   if(w.pending?.hostExecution){
    w.lastHostExecution={workId:w.pending.workId,...w.pending.hostExecution,localRetryStopped:true};
    w.hostStopReceipts??={};w.hostStopReceipts[w.pending.workId]={...w.lastHostExecution,agentGrantId:w.agentGrantId,
     cancellation:{state:'unknown',cancellationConfirmed:false,executionEnded:false,requestedAt:now()}};
   }
   if(w.state!==final){w.state=final;w.revision++;}w.lease=null;w.pending=null;
   w.stopAuthorization??={state:'pending',grantId:w.agentGrantId,roomId:w.roomId};target=structuredClone(w.stopAuthorization);return s;});
  // Stop locally before I/O. A missing ACK must not leave a live responder
  // permission or cause a stopped watch to skip retrying this exact revocation.
  if(target.state!=='revoked'){
   try{const receipt=await api.call('/v2/chat/rooms/'+target.roomId+'/agent-revoke',{grantId:target.grantId});
    if(receipt?.revoked!==true)throw new Error('watch_revocation_receipt_unconfirmed');
    target={...target,state:'revoked',confirmedAt:now()};
   }catch{target={...target,state:'unconfirmed',lastAttemptAt:now()};}
   await update(s=>{const w=s.watches[id];if(['paused','stopped','expired'].includes(w?.state)&&w.agentGrantId===target.grantId&&w.roomId===target.roomId){
    // A concurrent retry with an acknowledged revoke wins over a late failure.
    if(w.stopAuthorization?.state!=='revoked')w.stopAuthorization=target;
    target=structuredClone(w.stopAuthorization);}return s;});
  }
  return{id,state:final,furtherGalaxyChecks:false,externalModelCancellation:'host-must-confirm',remoteGrantRevoked:target.state==='revoked',
   authorizationState:target.state,retryStopRequired:target.state!=='revoked'};}
 async function stop(id,options){return halt(id,'stopped',options);}
 async function pause(id,options){return halt(id,'paused',options);}
 async function expire(id,options){const w=(await read()).watches[id];if(!w||w.expiresAt>now())throw Error('watch_not_expired');return halt(id,'expired',options);}
 async function resume(input,{confirmed=false}={}){const x=nativeWatchResumeSchema.parse(input);if(!confirmed)throw new Error('watch_choice_required');
  const before=lease(),previous=(await read()).watches[x.id];if(!sameLease(before,lease()))throw Error('watch_binding_changed');if(!previous||previous.state!=='paused')throw new Error('watch_not_paused');
  if(previous.stopAuthorization?.state!=='revoked')throw new Error('watch_revocation_unconfirmed');
  if(x.agentGrantId===previous.agentGrantId)throw new Error('watch_new_agent_grant_required');
  if(x.expiresAt<=now())throw new Error('watch_expired');
  const bindingId=api.snapshot()?.bindingId;
  const grants=await api.call('/v2/chat/rooms/'+previous.roomId+'/agent-grants',{grantId:x.agentGrantId});const grant=grants.items?.find(g=>g.grantId===x.agentGrantId&&g.state==='active');
  if(!sameLease(before,lease())||!bindingId||api.snapshot()?.bindingId!==bindingId||!grant||grant.bindingId!==bindingId||x.expiresAt>grant.expiresAt)throw new Error('watch_current_binding_grant_required');
  // Never expose active state before the new permission is validated. A
  // failed read leaves the original paused grant/receipt and cursor intact.
  await update(s=>{const current=s.watches[x.id];if(!sameLease(before,lease()))throw Error('watch_binding_changed');if(current?.state!=='paused'||current.revision!==previous.revision||current.agentGrantId!==previous.agentGrantId||current.stopAuthorization?.state!=='revoked')throw new Error('watch_resume_changed');
   s.watches[x.id]={...current,agentGrantId:x.agentGrantId,bindingLease:before,expiresAt:x.expiresAt,state:'active',revision:current.revision+1,after:current.after,pending:null,failures:0,nextCheckAt:now(),lease:null,stopAuthorization:undefined};return s;});
  if(!sameLease(before,lease()))throw Error('watch_binding_changed');
  return status(x.id);
 }
 async function check(id,{force=false,host=false}={}){const before=lease();let capture;await update(s=>{const w=s.watches[id];if(!w)throw new Error('watch_missing');
   if(w.state!=='active'||w.expiresAt<=now()){capture={state:'inactive'};return s;}
   if(w.lease&&w.lease.until>now()){capture={state:w.lease.owner===instanceId?'already-checking':'leased-elsewhere'};return s;}
   // A host event is an explicit signal that the cursor may have changed and
   // may bypass the transport fallback interval. The interval itself never
   // invokes a model; it only asks the service for a newer cursor.
   // The host that produced pending work may continue to process the exact
   // work item. A different host must re-read the current authorized source;
   // otherwise a revoked message body could be replayed from the local
   // locator. Cross-host checks deliberately bypass the fallback due time.
   if(w.pending?.hostExecution){capture={state:w.pending.hostExecution.state==='completed'?'work-completed-pending-ack':'host-result-pending',workId:w.pending.workId,hostExecution:w.pending.hostExecution,nextCheckAt:w.nextCheckAt};return s;}
   if(w.pending?.owner===instanceId&&!host){capture={state:'work-pending',workId:w.pending.workId,nextCheckAt:w.nextCheckAt};return s;}
   if(!force&&w.nextCheckAt>now()&&!w.pending){capture={state:'not-due',nextCheckAt:w.nextCheckAt};return s;}
   w.lease={owner:instanceId,until:now()+120};capture={state:'fetch',watch:structuredClone(w)};return s;});
  if(!sameLease(before,lease()))throw Error('watch_binding_changed');
  if(capture.state!=='fetch')return{...capture,modelCalls:0};const w=capture.watch;
  try{
   const grants=await api.call('/v2/chat/rooms/'+w.roomId+'/agent-grants',{grantId:w.agentGrantId});
   if(!sameLease(before,lease()))throw Error('watch_binding_changed');
   const grant=grants.items?.find(g=>g.grantId===w.agentGrantId&&g.state==='active');
   if(!grant){await stop(id,{agentGrantId:w.agentGrantId});return{state:'grant-unavailable',modelCalls:0};}
   if(grant.bindingId!==api.snapshot()?.bindingId||w.bindingLease&&!sameLease(w.bindingLease,before)){await stop(id,{agentGrantId:w.agentGrantId});return{state:'binding-changed',modelCalls:0,newGrantRequiresUserChoice:true};}
   if(w.taskId){const task=await api.call('/v2/tasks/'+w.taskId,undefined,{method:'GET'});if(!sameLease(before,lease()))throw Error('watch_binding_changed');if(['closed','canceled'].includes(task.state)){await stop(id,{agentGrantId:w.agentGrantId});return{state:'task-ended',modelCalls:0};}}
   const page=await api.call('/v2/chat/rooms/'+w.roomId+'/history',{after:w.after,limit:50,agentGrantId:w.agentGrantId});
   if(!sameLease(before,lease()))throw Error('watch_binding_changed');
   if(!Array.isArray(page.messages)||!/^\d+$/.test(page.scannedThrough))throw new Error('chat_history_response_invalid');
   const items=page.messages.filter(m=>m.subjectId!==subjectId&&m.agentGrantId!==w.agentGrantId&&m.state==='accepted'&&typeof m.text==='string'
    &&(!w.pending||(/^\d+$/.test(String(m.sequence))&&BigInt(m.sequence)<=BigInt(w.pending.next))));
   if(host&&w.pending&&(!w.pending.sourceHash||sourceHash(items)!==w.pending.sourceHash))throw Error('watch_source_changed');
   const work={workId:w.pending?.workId??randomUUID(),roomId:w.roomId,items,next:w.pending?.next??page.scannedThrough,complete:page.complete};let accepted=false;
   await update(s=>{const current=s.watches[id];if(current?.state!=='active'||current.revision!==w.revision||current.lease?.owner!==instanceId)return s;
    current.failures=0;current.nextCheckAt=now()+(page.next?0:900);current.lease=null;
    // Persist locators only. Every retry reads current authorized source bodies.
    if(items.length)current.pending={workId:work.workId,next:work.next,owner:instanceId,sourceHash:sourceHash(items),after:w.after};else{current.after=page.scannedThrough;current.pending=null;}accepted=true;return s;});
   if(!sameLease(before,lease()))throw Error('watch_binding_changed');
   return accepted?{state:items.length?'work-ready':'unchanged',...(items.length?{work}:{}),modelCalls:0,invokeUserAgent:items.length>0}:{state:'stopped-during-check',modelCalls:0};
  }catch(error){await update(s=>{const c=s.watches[id];if(c?.state==='active'&&c.revision===w.revision){c.lease=null;c.failures++;c.nextCheckAt=now()+Math.min(1800,60*2**Math.min(c.failures-1,5));}return s;});throw error;}
 }
 const sourceHash=items=>createHash('sha256').update(JSON.stringify(items)).digest('hex');
 const lease=()=>({subjectId,endpoint:api.endpoint,bindingId:api.snapshot()?.bindingId,generation:api.snapshot()?.generation??null});
 const sameLease=(a,b)=>!!a&&!!b&&['subjectId','endpoint','bindingId','generation'].every(key=>a[key]===b[key]);
 async function verifyHostWork(id,workId){
  const before=lease(),w=(await read()).watches[id];
  if(!sameLease(before,lease())||!w||w.state!=='active'||w.expiresAt<=now()||w.pending?.workId!==workId||!w.pending.sourceHash)throw Error('watch_work_changed');
  const grants=await api.call('/v2/chat/rooms/'+w.roomId+'/agent-grants',{grantId:w.agentGrantId});
  if(!sameLease(before,lease())||!grants.items?.some(g=>g.grantId===w.agentGrantId&&g.state==='active'&&g.bindingId===before.bindingId))throw Error('watch_current_binding_grant_required');
  if(w.taskId){const task=await api.call('/v2/tasks/'+w.taskId,undefined,{method:'GET'});if(!sameLease(before,lease())||['closed','canceled'].includes(task.state))throw Error('watch_task_ended');}
  const page=await api.call('/v2/chat/rooms/'+w.roomId+'/history',{after:w.pending.after,limit:50,agentGrantId:w.agentGrantId});
  if(!sameLease(before,lease())||!Array.isArray(page.messages))throw Error('watch_source_changed');
  const items=page.messages.filter(m=>m.subjectId!==subjectId&&m.agentGrantId!==w.agentGrantId&&m.state==='accepted'&&typeof m.text==='string'&&/^\d+$/.test(String(m.sequence))&&BigInt(m.sequence)<=BigInt(w.pending.next));
  const current=(await read()).watches[id];
  if(!sameLease(before,lease())||current?.state!=='active'||current.revision!==w.revision||current.pending?.workId!==workId||sourceHash(items)!==w.pending.sourceHash)throw Error('watch_source_changed');
  return{roomId:w.roomId,purpose:w.purpose,agentGrantId:w.agentGrantId,lease:before};
 }
 async function recordHostExecution(id,workId,execution){
  if(!['dispatching','completed','failed','interrupted','unknown'].includes(execution.state))throw Error('watch_host_result_invalid');
  await update(s=>{const w=s.watches[id];if(w?.state!=='active'||w.expiresAt<=now()||w.pending?.workId!==workId)throw Error('watch_work_changed');
   const prior=w.pending.hostExecution;
   if(prior?.state==='completed'&&execution.state!=='completed')throw Error('watch_host_result_changed');
   if(execution.agentGrantId&&execution.agentGrantId!==w.agentGrantId)throw Error('watch_host_scope_changed');
   const reason=['host_reader_configuration_unconfirmed','selected-model-unavailable','host-operation-unconfirmed','host-disconnected','completion-timeout','scope-inactive'].includes(execution.reason)?execution.reason:undefined;
   w.pending.hostExecution={state:execution.state,reason,model:execution.model,threadId:execution.threadId,turnId:execution.turnId,
    lease:execution.lease,scopeKey:execution.scopeKey,agentGrantId:w.agentGrantId,recordedAt:now()};return s;});
 }
 async function recordHostCancellation(id,reference,result){
  if(!reference?.workId||!reference.agentGrantId||!reference.scopeKey)return;
  const known=['completed','interrupted','failed'].includes(result?.state);
  const cancellation={state:known?result.state:'unknown',cancellationConfirmed:result?.state==='interrupted'&&result.cancellationConfirmed===true,
   executionEnded:known&&result.executionEnded===true,recordedAt:now()};
  await update(s=>{const w=s.watches[id],old=w?.hostStopReceipts?.[reference.workId];
   if(!old||old.agentGrantId!==reference.agentGrantId||old.scopeKey!==reference.scopeKey)return s;
   if(old.threadId&&reference.threadId!==old.threadId||old.turnId&&reference.turnId!==old.turnId)return s;
   if(old.cancellation?.executionEnded&&!cancellation.executionEnded)return s;
   old.cancellation=cancellation;
   if(w.lastHostExecution?.workId===reference.workId&&w.lastHostExecution.scopeKey===reference.scopeKey)w.lastHostExecution.cancellation=cancellation;
   return s;});
 }
 async function ack(id,workId){const before=lease();let ack;await update(s=>{const w=s.watches[id];if(!w||w.state!=='active'||w.expiresAt<=now()||w.pending?.workId!==workId)throw new Error('watch_work_changed');
   if(w.pending.hostExecution){if(w.pending.hostExecution.state!=='completed'||!sameLease(w.pending.hostExecution.lease,lease()))throw Error('watch_host_completion_required');}
   ack={roomId:w.roomId,agentGrantId:w.agentGrantId,sequence:w.pending.next,revision:w.revision};return s;});
  if(!sameLease(before,lease()))throw Error('watch_binding_changed');
  // Failure here does not claim a human read or a successful external model stop.
  const receipt=await api.call('/v2/chat/rooms/'+ack.roomId+'/cursor',{kind:'agent',agentGrantId:ack.agentGrantId,sequence:ack.sequence});
  if(!sameLease(before,lease()))throw Error('watch_binding_changed');
  if(receipt?.kind!=='agent'||receipt.agentGrantId!==ack.agentGrantId||!/^\d+$/.test(receipt.sequence)||BigInt(receipt.sequence)<BigInt(ack.sequence))throw Error('watch_cursor_receipt_unconfirmed');
  await update(s=>{const w=s.watches[id];if(w?.state==='active'&&w.revision===ack.revision&&w.pending?.workId===workId){w.after=ack.sequence;w.pending=null;w.revision++;}return s;});
  if(!sameLease(before,lease()))throw Error('watch_binding_changed');
  return{state:'processed',humanRead:false,receipt};}
 return{start,status,stop,pause,resume,expire,check,ack,verifyHostWork,recordHostExecution,recordHostCancellation};
}
