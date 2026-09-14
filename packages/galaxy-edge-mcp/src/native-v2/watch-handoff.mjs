import {createHash} from 'node:crypto';
import {watchControlRegisterSchema,watchControlTakeoverSchema,watchControlStopSchema} from '../../../galaxy-official/src/shared/watch-control-v2-schema.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
// All writes are selected control metadata. No transcript or model settings are
// copied; returned work still requires the actual user host to execute it.
export function createNativeWatchHandoff({store,api,subjectId,now=()=>Math.floor(Date.now()/1000)}){
 const key='native-watch:'+api.endpoint+':'+subjectId,pendingKey='native-watch-handoffs:'+api.endpoint+':'+subjectId;
 const read=async()=>await store.get(key)??{version:1,watches:{}};
 const update=fn=>store.update(key,s=>fn(s??{version:1,watches:{}}));
 async function adopt(response,kind){
  const w=response.watch;if(!w||w.subjectId!==subjectId)throw Error('watch_control_receipt_invalid');
  await update(s=>{const local=s.watches[w.watchId];
   if(kind==='stop'){if(local?.agentGrantId===response.receipt.agentGrantId){local.state='stopped';local.pending=null;local.lease=null;local.revision++;
    local.stopAuthorization={state:'revoked',roomId:local.roomId,grantId:local.agentGrantId,confirmedAt:now()};}return s;}
   if(w.state!=='active'||w.bindingId!==api.snapshot()?.bindingId){
    if(local){local.state=w.bindingId!==api.snapshot()?.bindingId?'superseded':w.state;local.lease=null;local.pending=null;}
    return s;
   }
   // Reconciling an earlier commit never undoes a later local stop of the
   // same grant. A newly selected takeover has a different exact grant ID.
   if(local?.agentGrantId===w.agentGrantId&&(kind==='register'||local.state==='stopped')){local.cloudControl={revision:w.revision};return s;}
   if(Object.values(s.watches).some(other=>other.id!==w.watchId&&other.roomId===w.roomId&&other.state==='active'&&other.expiresAt>now()))
    throw Error('watch_local_room_conflict');
   s.watches[w.watchId]={id:w.watchId,roomId:w.roomId,agentGrantId:w.agentGrantId,purpose:w.purpose,expiresAt:w.expiresAt,
    ...(w.taskId?{taskId:w.taskId}:{}),state:'active',revision:(local?.revision??0)+1,after:w.lastCursor,pending:null,failures:0,nextCheckAt:now(),lease:null,
    cloudControl:{revision:w.revision}};
   return s;
  });
  return response;
 }
 async function send(kind,input,{confirmed=false}={}){
  const schema={register:watchControlRegisterSchema,takeover:watchControlTakeoverSchema,stop:watchControlStopSchema}[kind],x=schema.parse(input),requestHash=hash(x);
  const existing=(await store.get(pendingKey)??{})[x.operationId];
  if(existing&&(existing.kind!==kind||existing.requestHash!==requestHash))throw Error('watch_operation_changed');
  if(!existing&&!confirmed&&kind!=='stop')throw Error('watch_choice_required');
  if(kind==='register'&&!existing){const w=(await read()).watches[x.watchId];
   if(!w||w.state!=='active'||w.roomId!==x.roomId||w.agentGrantId!==x.agentGrantId||w.purpose!==x.purpose||w.expiresAt!==x.expiresAt||(w.taskId??null)!==(x.taskId??null))
    throw Error('watch_local_scope_changed');
  }
  if(kind==='takeover'&&!existing){if(x.targetBindingId!==api.snapshot()?.bindingId)throw Error('watch_target_device_required');
   const {watch}=await api.call('/v2/watch-controls/read',{watchId:x.watchId});
   if(Object.values((await read()).watches).some(other=>other.id!==x.watchId&&other.roomId===watch.roomId&&other.state==='active'&&other.expiresAt>now()))
    throw Error('watch_local_room_conflict');
  }
  await store.update(pendingKey,s=>({...s,[x.operationId]:existing??{kind,input:x,requestHash,state:'pending'}}));
  const response=await api.call('/v2/watch-controls/'+kind,x);
  if(response.operationId!==x.operationId||response.requestHash!==requestHash||response.state!=='recorded')throw Error('watch_control_receipt_invalid');
  await adopt(response,kind);
  await store.update(pendingKey,s=>({...s,[x.operationId]:{...s[x.operationId],state:'recorded'}}));
  return response;
 }
 async function reconcile(operationId,{retry=false}={}){
  const p=(await store.get(pendingKey)??{})[operationId];if(!p)throw Error('watch_operation_missing');
  const response=await api.call('/v2/watch-controls/receipt',{operationId,requestHash:p.requestHash});
  if(response.state==='absent')return retry?send(p.kind,p.input,{confirmed:true}):{operationId,state:'unconfirmed',retryOriginalOperation:true};
  if(response.operationId!==operationId||response.requestHash!==p.requestHash||response.state!=='recorded')throw Error('watch_control_receipt_invalid');
  await adopt(response,p.kind);await store.update(pendingKey,s=>({...s,[operationId]:{...s[operationId],state:'recorded'}}));return response;
 }
 return{enable:(x,o)=>send('register',x,o),takeover:(x,o)=>send('takeover',x,o),stop:x=>send('stop',x),
  query:x=>api.call('/v2/watch-controls/query',x??{}),get:watchId=>api.call('/v2/watch-controls/read',{watchId}),reconcile,
  pending:async()=>Object.values(await store.get(pendingKey)??{}).filter(x=>x.state==='pending').map(x=>({operationId:x.input.operationId,watchId:x.input.watchId,kind:x.kind,requestHash:x.requestHash}))};
}
