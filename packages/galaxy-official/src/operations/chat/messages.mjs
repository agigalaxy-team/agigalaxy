import {transaction} from "../../infrastructure/database.mjs";
import {ServiceError} from "../../shared/service-error.mjs";
import {operationsChatMessageTargetSchema,operationsChatMessageVisibilitySchema} from "../../shared/operations-chat-message-schema.mjs";
import {chatMessageOperationsBlockedWithin} from "../../chat/chat-message-operations-gate.mjs";

const fail=(code,status=409)=>{throw new ServiceError(code,status);};
const parse=(schema,input)=>{const result=schema.safeParse(input);if(!result.success)fail('invalid_chat_report_request',400);return result.data;};
const messageActions=new Set(['message-hide','message-restore','message-keep']);
const stamp=value=>new Date(value*1000).toISOString();

// This manual command path uses the same case disclosure and independent
// operations principal as the existing report workflow. No room/history grant,
// automated decision identity or independent evidence retention is created.
export class OperationsChatMessageVisibilityService{
 constructor({governance}){this.governance=governance;}
 headWithin(db,reportId,messageId){return db.query('SELECT * FROM operations_chat_message_visibility_v1 WHERE endpoint=$1 AND report_id=$2 AND message_id=$3',
  [this.governance.endpoint,reportId,messageId]).then(result=>result.rows[0]??null);}
 async caseBlockedWithin(db,reportId){return !!(await db.query('SELECT 1 FROM operations_chat_message_visibility_v1 WHERE endpoint=$1 AND report_id=$2 AND hidden LIMIT 1',
  [this.governance.endpoint,reportId])).rows.length;}
 async decisionWithin(db,reportId,eventId){
  if(!eventId)return null;const event=(await db.query('SELECT id,kind,actor_kind,operator_id,input,created_at FROM account_chat_governance_events_v1 WHERE id=$1 AND report_id=$2',[eventId,reportId])).rows[0];
  if(!event||!messageActions.has(event.kind))return null;
  return{eventId:event.id,actorKind:event.actor_kind,operatorId:event.operator_id,at:new Date(event.created_at).toISOString(),action:event.kind.slice('message-'.length),sourceRevision:event.input.messageRevision};
 }
 async viewWithin(db,row,context,material,{available=false}={}){
  const g=this.governance,head=await this.headWithin(db,row.id,material.message_id),ownHidden=!!head?.hidden,
   allowed=context.canModerate&&!g.expired(row)&&available,
   canHide=allowed&&context.permissions?.includes('chat-messages.hide')&&!ownHidden&&row.version<100&&['received','reviewing','appealed'].includes(row.state);
  return{hidden:await chatMessageOperationsBlockedWithin(db,{messageId:material.message_id}),ownHidden,revision:head?.revision??0,
   sourceRevision:head?.message_revision??null,appliesToCurrent:!!head&&available&&head.message_revision===material.revision,
   canHide,canRestore:allowed&&context.permissions?.includes('chat-messages.restore')&&ownHidden,canKeep:allowed&&context.permissions?.includes('chat-messages.keep')&&row.state!=='withdrawn'&&ownHidden&&row.version<100,
   initialDecision:await this.decisionWithin(db,row.id,head?.initial_event_id),currentDecision:await this.decisionWithin(db,row.id,head?.current_event_id)};
 }
 async command(operator,target,input,{authorize=null}={}){
  const g=this.governance,actor=g.operator(operator,{write:true}),keys=parse(operationsChatMessageTargetSchema,target),x=parse(operationsChatMessageVisibilitySchema,input),
   kind='message-'+x.action,recorded={...x,...keys,kind};
  if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);
  return transaction(g.db,async db=>{
   const current=async()=>{const fresh=await g.businessAdmin.authorizeAction(await authorize(),'chat-messages.'+x.action,{db});
    if(fresh.operatorId!==actor.operatorId||fresh.endpoint!==actor.endpoint)fail('business_admin_denied',403);return fresh;};
   let fresh=await current();
   if(g.businessAdmin.executorAuthority?.acceptsDuty(fresh)){
    await g.assertDutyCaseWithin(db,fresh,keys.reportId);
    await g.businessAdmin.executorAuthority.requireDutyOperation(fresh,['chat-messages.'+x.action],{id:keys.reportId,...x,messageId:keys.messageId},{db,action:'chat-report-event'});
   }
   await db.query('SELECT pg_advisory_xact_lock(734912326,hashtext($1))',[x.operationId]);
   const row=await g.row(db,keys.reportId,{write:true}),context=await g.contextWithin(db,row,fresh,{operator:true});
   if(!context.canModerate)fail('chat_report_moderation_denied',403);
   const prior=await g.priorWithin(db,fresh,recorded,{operator:true});
   if(prior){const receipt=(await db.query("SELECT e.version,(a.result->>'revision')::integer AS revision FROM account_chat_governance_events_v1 e JOIN business_admin_audit_v1 a ON a.endpoint=$1 AND a.operation_id=e.id AND a.action='chat-report-event' WHERE e.id=$2",[g.endpoint,x.operationId])).rows[0];await current();return{...prior,messageOperation:{operationId:x.operationId,replayed:true,revision:receipt?.revision??null,reportVersion:receipt?.version??null}};}
   if(g.expired(row))fail('chat_report_materials_expired',410);
   if(row.version!==x.expectedVersion)fail('chat_report_version_changed',409);
   // Withdrawing a report does not cancel a prior operations decision. Its
   // own active block must remain reversible without reopening the report.
   if(row.state==='withdrawn'&&x.action!=='restore')fail('chat_report_state',409);
   if(row.version>=100&&x.action!=='restore')fail('chat_report_event_limit',409);
   const message=(await db.query('SELECT * FROM chat_message_refs WHERE message_id=$1 AND room_id=$2 FOR UPDATE',[keys.messageId,row.room_id])).rows[0];
   const materials=(await db.query('SELECT * FROM account_chat_governance_materials_v1 WHERE report_id=$1 AND message_id=$2 AND revision=$3 AND room_id=$4 AND erased_at IS NULL ORDER BY event_id',
    [row.id,keys.messageId,x.messageRevision,row.room_id])).rows;
   if(!message||!materials.length)fail('chat_report_message_not_selected',404);
   if(message.revision!==x.messageRevision)fail('chat_report_source_changed',409);
   const material=materials[0];
   if(!await g.sourceStillAvailableWithin(db,material))fail('chat_report_source_unavailable',409);
   const head=await this.headWithin(db,row.id,keys.messageId);
   if((head?.revision??0)!==x.expectedRevision)fail('chat_report_message_version_changed',409);
   if(x.action==='hide'&&(head?.hidden||!['received','reviewing','appealed'].includes(row.state))
    ||x.action!=='hide'&&!head?.hidden)fail('chat_report_message_state',409);
   fresh=await current();
   await g.insertEventWithin(db,row,fresh,recorded,kind,row.version+1,{operator:true});
   const hidden=x.action!=='restore',revision=(head?.revision??0)+1,now=stamp(g.now());
   await db.query(`INSERT INTO operations_chat_message_visibility_v1(endpoint,report_id,message_id,message_revision,revision,hidden,initial_event_id,current_event_id,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(endpoint,report_id,message_id) DO UPDATE
    SET message_revision=$4,revision=$5,hidden=$6,current_event_id=$8,updated_at=$9`,
    [g.endpoint,row.id,keys.messageId,x.messageRevision,revision,hidden,head?.initial_event_id??x.operationId,x.operationId,now]);
   const updated=(await db.query("UPDATE account_chat_reports_v1 SET version=version+1,state=CASE WHEN state IN ('received','appealed') THEN 'reviewing' ELSE state END,updated_at=$2 WHERE id=$1 RETURNING *",[row.id,now])).rows[0];
   fresh=await current();
   if(!await g.sourceStillAvailableWithin(db,material))fail('chat_report_source_unavailable',409);
   const allHidden=await chatMessageOperationsBlockedWithin(db,{messageId:keys.messageId});
   await g.businessAdmin.recordWithin(db,fresh,'chat-report-event',{operationId:x.operationId,
    selection:{reportId:row.id,kind,roomId:row.room_id,messageId:keys.messageId,sourceRevision:x.messageRevision},
    result:{version:updated.version,state:updated.state,revision,hidden:allHidden,replayed:false}});
   return{...await g.viewWithin(db,updated,fresh,{operator:true}),messageOperation:{operationId:x.operationId,replayed:false,revision,reportVersion:updated.version}};
  });
 }
}
