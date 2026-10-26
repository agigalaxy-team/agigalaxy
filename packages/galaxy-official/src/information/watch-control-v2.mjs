import {ServiceError} from "../shared/service-error.mjs";
import {digest} from "../shared/digest.mjs";
import {bindingControl} from "../infrastructure/identity-control-repository.mjs";
import {watchControlRegisterSchema,watchControlTakeoverSchema,watchControlStopSchema,watchControlReadSchema,watchControlQuerySchema,watchControlReceiptSchema} from "../shared/watch-control-v2-schema.mjs";

const stamp=n=>new Date(n*1000).toISOString();
const fail=(code,status=409)=>{throw new ServiceError(code,status);};
const parse=(schema,input)=>{const x=schema.safeParse(input);if(!x.success)fail('invalid_watch_control_request',400);return x.data;};
const unavailable=e=>e instanceof ServiceError&&[401,403,404,409,422].includes(e.status);
// This is a selected control record, never an Agent scheduler or message store.
export class WatchControlV2Service {
 constructor(access,{chat,assistance}){Object.assign(this,{access,chat,assistance});}
 run(actor,write,fn){return write?this.access.runResourceWrite(actor,'binding',{},fn):this.access.runAuthorized(actor,'binding',fn);}
 async own(db,actor,id){const r=(await db.query('SELECT * FROM watch_controls_v2 WHERE watch_id=$1 AND subject_id=$2',[id,actor.subjectId])).rows[0];if(!r)fail('watch_control_not_found',404);return r;}
 async scope(db,actor,{room_id,task_id},{write=false}={}){
  if(task_id){const t=await this.assistance.readTaskWithin(db,actor,task_id);if(['closed','canceled'].includes(t.state))fail('watch_task_ended');}
  const ctx=await this.chat.requireRoom(db,actor,room_id,{write});
  if(['archived','owner-succession'].includes(ctx.room.state))fail('watch_room_inactive');
  return ctx;
 }
 async view(db,actor,row){
  let scopeAvailable=true;
  if(row.state==='stopped')await db.query('SELECT room_id FROM chat_rooms WHERE room_id=$1 FOR SHARE',[row.room_id]);
  else try{await this.scope(db,actor,row);}catch(e){if(!unavailable(e))throw e;scopeAvailable=false;
   await db.query('SELECT room_id FROM chat_rooms WHERE room_id=$1 FOR SHARE',[row.room_id]);}
  // Re-read after the Room lock: a transfer cannot mix an old revision with
  // its new grant in one response.
  row=await this.own(db,actor,row.watch_id);
  const grant=(await db.query('SELECT * FROM chat_agent_grants WHERE grant_id=$1 AND subject_id=$2',[row.current_grant_id,actor.subjectId])).rows[0];
  const binding=await bindingControl(db,(await db.query('SELECT * FROM bindings WHERE id=$1 AND subject_id=$2',[row.current_binding_id,actor.subjectId])).rows[0],{scope:'binding'});
  let state=row.state==='stopped'?'stopped':Date.parse(row.expires_at)<=this.access.now()*1000?'expired':!grant||grant.revoked_at?'permission-revoked'
   :!binding||binding.revoked_at||!binding.scopes.includes('binding')||Date.parse(binding.expires_at)<=this.access.now()*1000?'device-unavailable':'active';
  if(state==='active'&&!scopeAvailable)state='scope-unavailable';
  const c=(await db.query("SELECT sequence::text FROM chat_cursors WHERE room_id=$1 AND subject_id=$2 AND cursor_kind='agent' AND agent_ref=$3",
   [row.room_id,actor.subjectId,row.current_grant_id])).rows[0];
  return{watchId:row.watch_id,subjectId:row.subject_id,roomId:row.room_id,...(row.task_id?{taskId:row.task_id}:{}),purpose:row.purpose,
   revision:row.revision,state,agentGrantId:row.current_grant_id,bindingId:row.current_binding_id,installationId:binding?.installation_id??null,
   mode:grant?.mode??null,primaryResponder:grant?.primary_responder??false,expiresAt:Math.floor(Date.parse(row.expires_at)/1000),
   lastCursor:c?.sequence??'0',cursorMeaning:'server-acknowledged-agent-position; not-human-read',
   stored:'explicitly-selected-private-watch-control',runtimeLocation:'user-host',hostRuntimeState:'unverified',externalProcessStopped:'unconfirmed',cloudModel:false};
 }
 async operation(db,actor,x,kind){
  const row=(await db.query('SELECT * FROM watch_control_operations_v2 WHERE operation_id=$1',[x.operationId])).rows[0];
  if(!row)return null;
  if(row.subject_id!==actor.subjectId||row.watch_id!==x.watchId||row.kind!==kind||row.request_hash!==digest(JSON.stringify(x)))fail('watch_operation_conflict');
  return this.response(db,actor,row);
 }
 async response(db,actor,operation){return{operationId:operation.operation_id,requestHash:operation.request_hash,state:'recorded',
  receipt:operation.result,watch:await this.view(db,actor,await this.own(db,actor,operation.watch_id))};}
 async record(db,actor,x,kind,result){
  const op=(await db.query(`INSERT INTO watch_control_operations_v2(operation_id,watch_id,subject_id,binding_id,kind,request_hash,result,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[x.operationId,x.watchId,actor.subjectId,actor.bindingId,kind,digest(JSON.stringify(x)),JSON.stringify(result),stamp(this.access.now())])).rows[0];
  return this.response(db,actor,op);
 }
 register(actor,input){const x=parse(watchControlRegisterSchema,input);return this.run(actor,true,async db=>{
  // All writers use Task -> Room -> Watch. Room serialization also prevents an
  // old granted send/cursor write from committing after the transfer.
  await this.scope(db,actor,{room_id:x.roomId,task_id:x.taskId},{write:true});
  const old=await this.operation(db,actor,x,'register');if(old)return old;
  const grant=await this.chat.agent(db,actor,x.roomId,x.agentGrantId);
  if(x.expiresAt<=this.access.now()||x.expiresAt>Math.floor(Date.parse(grant.expires_at)/1000))fail('watch_exceeds_current_grant');
  const saved=await db.query(`INSERT INTO watch_controls_v2(watch_id,subject_id,room_id,task_id,purpose,current_grant_id,current_binding_id,expires_at,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) ON CONFLICT DO NOTHING RETURNING *`,
   [x.watchId,actor.subjectId,x.roomId,x.taskId??null,x.purpose,x.agentGrantId,actor.bindingId,stamp(x.expiresAt),stamp(this.access.now())]);
  if(!saved.rows.length)fail('watch_control_already_registered');
  // The selected watch deadline also bounds its exact Agent authorization.
  // Otherwise an old cached caller could use the source grant after the watch
  // expired. Other grants in the room are never shortened.
  await db.query('UPDATE chat_agent_grants SET expires_at=LEAST(expires_at,$2) WHERE grant_id=$1',[x.agentGrantId,stamp(x.expiresAt)]);
  return this.record(db,actor,x,'register',{revision:1,agentGrantId:x.agentGrantId,bindingId:actor.bindingId,metadataSyncOptedIn:true});
 });}
 get(actor,input){const x=parse(watchControlReadSchema,input);return this.run(actor,false,async db=>({watch:await this.view(db,actor,await this.own(db,actor,x.watchId))}));}
 query(actor,input={}){const x=parse(watchControlQuerySchema,input);return this.run(actor,false,async db=>{
  const rows=(await db.query('SELECT * FROM watch_controls_v2 WHERE subject_id=$1 AND ($2::uuid IS NULL OR watch_id>$2) ORDER BY watch_id LIMIT $3',
   [actor.subjectId,x.after,x.limit+1])).rows,items=[];
  for(const row of rows.slice(0,x.limit))items.push(await this.view(db,actor,row));
  return{items,next:rows.length>x.limit?items.at(-1).watchId:null,scope:'own-explicitly-registered-controls; local-only-watches-not-uploaded',cloudModel:false};
 });}
 receipt(actor,input){const x=parse(watchControlReceiptSchema,input);return this.run(actor,false,async db=>{
  const row=(await db.query('SELECT * FROM watch_control_operations_v2 WHERE operation_id=$1 AND subject_id=$2',[x.operationId,actor.subjectId])).rows[0];
  if(!row)return{operationId:x.operationId,state:'absent'};
  if(row.request_hash!==x.requestHash)fail('watch_operation_conflict');
  return this.response(db,actor,row);
 });}
 takeover(actor,input){const x=parse(watchControlTakeoverSchema,input);return this.run(actor,true,async db=>{
  const initial=await this.own(db,actor,x.watchId);await this.scope(db,actor,initial,{write:true});
  const replay=await this.operation(db,actor,x,'takeover');if(replay)return replay;
  const w=(await db.query('SELECT * FROM watch_controls_v2 WHERE watch_id=$1 FOR UPDATE',[x.watchId])).rows[0];
  if(w.revision!==x.expectedRevision||w.current_grant_id!==x.expectedGrantId)fail('watch_control_revision_conflict');
  if(w.state!=='active'||Date.parse(w.expires_at)<=this.access.now()*1000)fail('watch_control_inactive');
  if(x.targetBindingId!==actor.bindingId||x.targetBindingId===w.current_binding_id||x.newGrantId===w.current_grant_id)fail('watch_target_device_required');
  const target=await bindingControl(db,(await db.query('SELECT * FROM bindings WHERE id=$1 AND subject_id=$2',[x.targetBindingId,actor.subjectId])).rows[0],{scope:'binding'});
  if(!target||target.revoked_at||!target.scopes.includes('binding')||Date.parse(target.expires_at)<=this.access.now()*1000)fail('watch_target_device_unavailable',403);
  const grant=(await db.query('SELECT * FROM chat_agent_grants WHERE grant_id=$1 AND room_id=$2 AND subject_id=$3 FOR UPDATE',
   [w.current_grant_id,w.room_id,actor.subjectId])).rows[0];
  // A lost device's binding may be revoked by recovery, but explicit source
  // grant revocation is never treated as permission to resume it.
  if(!grant||grant.revoked_at||Date.parse(grant.expires_at)<=this.access.now()*1000)fail('watch_source_grant_revoked',403);
  const cursor=(await db.query("SELECT sequence::text FROM chat_cursors WHERE room_id=$1 AND subject_id=$2 AND cursor_kind='agent' AND agent_ref=$3",
   [w.room_id,actor.subjectId,w.current_grant_id])).rows[0]?.sequence??'0';
  const expiresAt=Math.min(Date.parse(w.expires_at),Date.parse(target.expires_at));
  const created=await db.query(`INSERT INTO chat_agent_grants(grant_id,room_id,subject_id,binding_id,mode,primary_responder,expires_at,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING grant_id`,
   [x.newGrantId,w.room_id,actor.subjectId,x.targetBindingId,grant.mode,grant.primary_responder,new Date(expiresAt).toISOString(),stamp(this.access.now())]);
  if(!created.rows.length)fail('watch_target_grant_exists');
  await db.query('UPDATE chat_agent_grants SET revoked_at=$2 WHERE grant_id=$1',[w.current_grant_id,stamp(this.access.now())]);
  await db.query(`INSERT INTO chat_cursors(room_id,subject_id,cursor_kind,agent_ref,sequence,updated_at) VALUES($1,$2,'agent',$3,$4,$5)`,
   [w.room_id,actor.subjectId,x.newGrantId,cursor,stamp(this.access.now())]);
  await db.query('UPDATE watch_controls_v2 SET current_grant_id=$2,current_binding_id=$3,revision=revision+1,expires_at=$4,updated_at=$5 WHERE watch_id=$1',
   [x.watchId,x.newGrantId,x.targetBindingId,new Date(expiresAt).toISOString(),stamp(this.access.now())]);
  return this.record(db,actor,x,'takeover',{revision:w.revision+1,agentGrantId:x.newGrantId,bindingId:x.targetBindingId,
   previousGrantId:w.current_grant_id,previousInstallationState:'revoked-for-this-watch',lastCursor:cursor,externalProcessStopped:'unconfirmed'});
 });}
 stop(actor,input){const x=parse(watchControlStopSchema,input);return this.run(actor,true,async db=>{
  const initial=await this.own(db,actor,x.watchId);
  // Stop remains possible after leaving a room. It grants no room read and
  // revokes only the current version explicitly named by this control action.
  await db.query('SELECT room_id FROM chat_rooms WHERE room_id=$1 FOR UPDATE',[initial.room_id]);
  const replay=await this.operation(db,actor,x,'stop');if(replay)return replay;
  const w=(await db.query('SELECT * FROM watch_controls_v2 WHERE watch_id=$1 FOR UPDATE',[x.watchId])).rows[0];
  if(w.revision!==x.expectedRevision||w.current_grant_id!==x.expectedGrantId)fail('watch_control_revision_conflict');
  await db.query('UPDATE chat_agent_grants SET revoked_at=COALESCE(revoked_at,$2) WHERE grant_id=$1 AND subject_id=$3',[w.current_grant_id,stamp(this.access.now()),actor.subjectId]);
  await db.query("UPDATE watch_controls_v2 SET state='stopped',revision=revision+1,stopped_at=COALESCE(stopped_at,$2),updated_at=$2 WHERE watch_id=$1",[x.watchId,stamp(this.access.now())]);
  return this.record(db,actor,x,'stop',{revision:w.revision+1,agentGrantId:w.current_grant_id,state:'stopped',externalProcessStopped:'unconfirmed'});
 });}
}
