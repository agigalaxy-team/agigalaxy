import {randomUUID} from 'node:crypto';
import * as z from 'zod/v4';
const scope=z.strictObject({roomId:z.uuid(),agentGrantId:z.uuid(),purpose:z.string().min(1).max(500),expiresAt:z.number().int().positive(),taskId:z.uuid().optional()});
export const nativeWatchStartSchema=scope;
export const nativeWatchResumeSchema=z.strictObject({id:z.uuid(),agentGrantId:z.uuid(),expiresAt:z.number().int().positive()});
// Host-driven checks, no timer or model provider. A lease lets one actual host
// process fetch work; an unchanged stream never invokes a model. Work is acked
// separately after the user's Agent really processes it.
export function createNativeWatch({store,api,subjectId,now=()=>Math.floor(Date.now()/1000),instanceId=randomUUID()}){
 const key='native-watch:'+api.endpoint+':'+subjectId;
 const initial=()=>({version:1,watches:{}}),read=async()=>await store.get(key)??initial();
 const update=change=>store.update(key,s=>change(s??initial()));
 async function start(input,{confirmed=false}={}){scope.parse(input);if(!confirmed)throw new Error('watch_choice_required');if(input.expiresAt<=now())throw new Error('watch_expired');
  const grants=await api.call('/v2/chat/rooms/'+input.roomId+'/agent-grants',{grantId:input.agentGrantId});
  const grant=grants.items?.find(g=>g.grantId===input.agentGrantId&&g.state==='active');if(!grant)throw new Error('active_room_agent_grant_required');
  if(grant.bindingId!==api.snapshot()?.bindingId)throw new Error('watch_current_binding_grant_required');
  if(input.expiresAt>grant.expiresAt)throw new Error('watch_exceeds_agent_grant');
  const id=randomUUID();await update(s=>{if(Object.values(s.watches).some(w=>w.roomId===input.roomId&&w.state==='active'&&w.expiresAt>now()))throw new Error('watch_already_active');
   s.watches[id]={id,...input,state:'active',revision:1,after:'0',pending:null,failures:0,nextCheckAt:now(),lease:null};return s;});return status(id);
 }
 async function status(id){const s=await read();const rows=id?[s.watches[id]].filter(Boolean):Object.values(s.watches);
  return{items:rows.map(w=>({...w,state:w.state==='active'&&w.expiresAt<=now()?'expired':w.state,lease:undefined,
   hostRuntimeState:w.lease?.owner===instanceId&&w.lease.until>now()?'checking':'awaiting-host-check',modelRunning:false})),scheduledBy:'user-host',cloudModel:false,continuesAfterHostExit:false};}
 async function halt(id,final){let target;await update(s=>{const w=s.watches[id];if(!w)throw new Error('watch_missing');
   if(w.state!==final){w.state=final;w.revision++;}w.lease=null;w.pending=null;
   w.stopAuthorization??={state:'pending',grantId:w.agentGrantId,roomId:w.roomId};target=structuredClone(w.stopAuthorization);return s;});
  // Stop locally before I/O. A missing ACK must not leave a live responder
  // permission or cause a stopped watch to skip retrying this exact revocation.
  if(target.state!=='revoked'){
   try{const receipt=await api.call('/v2/chat/rooms/'+target.roomId+'/agent-revoke',{grantId:target.grantId});
    if(receipt?.revoked!==true)throw new Error('watch_revocation_receipt_unconfirmed');
    target={...target,state:'revoked',confirmedAt:now()};
   }catch{target={...target,state:'unconfirmed',lastAttemptAt:now()};}
   await update(s=>{const w=s.watches[id];if(w?.state==='stopped'&&w.agentGrantId===target.grantId&&w.roomId===target.roomId){
    // A concurrent retry with an acknowledged revoke wins over a late failure.
    if(w.stopAuthorization?.state!=='revoked')w.stopAuthorization=target;
    target=structuredClone(w.stopAuthorization);}return s;});
  }
  return{id,state:final,furtherGalaxyChecks:false,externalModelCancellation:'host-must-confirm',remoteGrantRevoked:target.state==='revoked',
   authorizationState:target.state,retryStopRequired:target.state!=='revoked'};}
 async function stop(id){return halt(id,'stopped');}
 async function pause(id){return halt(id,'paused');}
 async function resume(input,{confirmed=false}={}){const x=nativeWatchResumeSchema.parse(input);if(!confirmed)throw new Error('watch_choice_required');
  let previous;await update(s=>{previous=s.watches[x.id];if(!previous||previous.state!=='paused')throw new Error('watch_not_paused');
   if(previous.stopAuthorization?.state!=='revoked')throw new Error('watch_revocation_unconfirmed');
   if(x.expiresAt<=now())throw new Error('watch_expired');
   s.watches[x.id]={...previous,agentGrantId:x.agentGrantId,expiresAt:x.expiresAt,state:'active',revision:previous.revision+1,after:previous.after,pending:null,failures:0,nextCheckAt:now(),lease:null,stopAuthorization:undefined};return s;});
  try{const grants=await api.call('/v2/chat/rooms/'+previous.roomId+'/agent-grants',{grantId:x.agentGrantId});const grant=grants.items?.find(g=>g.grantId===x.agentGrantId&&g.state==='active');
   if(!grant||grant.bindingId!==api.snapshot()?.bindingId||x.expiresAt>grant.expiresAt)throw new Error('watch_current_binding_grant_required');
   return status(x.id);
  }catch(error){await update(s=>{const w=s.watches[x.id];if(w?.state==='active'&&w.agentGrantId===x.agentGrantId){w.state='paused';w.revision++;}return s;});throw error;}
 }
 async function check(id,{force=false}={}){let capture;await update(s=>{const w=s.watches[id];if(!w)throw new Error('watch_missing');
   if(w.state!=='active'||w.expiresAt<=now()){capture={state:'inactive'};return s;}
   if(w.lease&&w.lease.until>now()){capture={state:w.lease.owner===instanceId?'already-checking':'leased-elsewhere'};return s;}
   // A host event is an explicit signal that the cursor may have changed and
   // may bypass the transport fallback interval. The interval itself never
   // invokes a model; it only asks the service for a newer cursor.
   // The host that produced pending work may continue to process the exact
   // work item. A different host must re-read the current authorized source;
   // otherwise a revoked message body could be replayed from the local
   // locator. Cross-host checks deliberately bypass the fallback due time.
   if(w.pending?.owner===instanceId){capture={state:'work-pending',workId:w.pending.workId,nextCheckAt:w.nextCheckAt};return s;}
   if(!force&&w.nextCheckAt>now()&&!w.pending){capture={state:'not-due',nextCheckAt:w.nextCheckAt};return s;}
   w.lease={owner:instanceId,until:now()+120};capture={state:'fetch',watch:structuredClone(w)};return s;});
  if(capture.state!=='fetch')return{...capture,modelCalls:0};const w=capture.watch;
  try{
   const grants=await api.call('/v2/chat/rooms/'+w.roomId+'/agent-grants',{grantId:w.agentGrantId});
   const grant=grants.items?.find(g=>g.grantId===w.agentGrantId&&g.state==='active');
   if(!grant){await stop(id);return{state:'grant-unavailable',modelCalls:0};}
   if(grant.bindingId!==api.snapshot()?.bindingId){await stop(id);return{state:'binding-changed',modelCalls:0,newGrantRequiresUserChoice:true};}
   if(w.taskId){const task=await api.call('/v2/tasks/'+w.taskId,undefined,{method:'GET'});if(['closed','canceled'].includes(task.state)){await stop(id);return{state:'task-ended',modelCalls:0};}}
   const page=await api.call('/v2/chat/rooms/'+w.roomId+'/history',{after:w.after,limit:50,agentGrantId:w.agentGrantId});
   if(!Array.isArray(page.messages)||!/^\d+$/.test(page.scannedThrough))throw new Error('chat_history_response_invalid');
   const items=page.messages.filter(m=>m.subjectId!==subjectId&&m.agentGrantId!==w.agentGrantId&&m.state==='accepted'&&typeof m.text==='string');
   const work={workId:w.pending?.workId??randomUUID(),roomId:w.roomId,items,next:page.scannedThrough,complete:page.complete};let accepted=false;
   await update(s=>{const current=s.watches[id];if(current?.state!=='active'||current.revision!==w.revision||current.lease?.owner!==instanceId)return s;
    current.failures=0;current.nextCheckAt=now()+(page.next?0:900);current.lease=null;
    // Persist locators only. Every retry reads current authorized source bodies.
    if(items.length)current.pending={workId:work.workId,next:work.next,owner:instanceId};else{current.after=page.scannedThrough;current.pending=null;}accepted=true;return s;});
   return accepted?{state:items.length?'work-ready':'unchanged',...(items.length?{work}:{}),modelCalls:0,invokeUserAgent:items.length>0}:{state:'stopped-during-check',modelCalls:0};
  }catch(error){await update(s=>{const c=s.watches[id];if(c?.state==='active'&&c.revision===w.revision){c.lease=null;c.failures++;c.nextCheckAt=now()+Math.min(1800,60*2**Math.min(c.failures-1,5));}return s;});throw error;}
 }
 async function ack(id,workId){let ack;await update(s=>{const w=s.watches[id];if(!w||w.state!=='active'||w.expiresAt<=now()||w.pending?.workId!==workId)throw new Error('watch_work_changed');
   ack={roomId:w.roomId,agentGrantId:w.agentGrantId,sequence:w.pending.next,revision:w.revision};return s;});
  // Failure here does not claim a human read or a successful external model stop.
  const receipt=await api.call('/v2/chat/rooms/'+ack.roomId+'/cursor',{kind:'agent',agentGrantId:ack.agentGrantId,sequence:ack.sequence});
  await update(s=>{const w=s.watches[id];if(w?.state==='active'&&w.revision===ack.revision&&w.pending?.workId===workId){w.after=ack.sequence;w.pending=null;w.revision++;}return s;});
  return{state:'processed',humanRead:false,receipt};}
 return{start,status,stop,pause,resume,check,ack};
}
