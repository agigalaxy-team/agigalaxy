import {isDeepStrictEqual} from "node:util";
import {transaction} from "../../infrastructure/database.mjs";
import {chatActorRef} from "../chat-actors.mjs";
import {accountChatReportSchema,accountChatReportEventSchema} from "../../shared/account-chat-governance-schema.mjs";
import {stamp,fail,parse,decisions,terminal} from './helpers.mjs';
import {ChatReportReadModel} from './read-model.mjs';

// Formal service and original report/event commands, CAS, stable replay, per-case message contribution and existing worker lifecycle.
export class AccountChatGovernanceService extends ChatReportReadModel{
 constructor(options){super(options);}

 async priorWithin(db,actor,input,{operator=false}={}){
  const event=(await db.query('SELECT * FROM account_chat_governance_events_v1 WHERE id=$1 FOR SHARE',[input.operationId])).rows[0];
  if(!event)return null;
  if(event.actor_kind!==(operator?actor.kind:'official-account')||(operator?event.operator_id!==actor.operatorId:event.account_id!==actor.accountId)||!isDeepStrictEqual(event.input,input))fail('chat_report_operation_conflict',409);
  return this.viewWithin(db,await this.row(db,event.report_id),actor,{operator});
 }
 async report(actor,input){const x=parse(accountChatReportSchema,input);return this.run(actor,true,async db=>{
  await db.query('SELECT pg_advisory_xact_lock(734912326,hashtext($1))',[x.operationId]);
  const old=await this.priorWithin(db,actor,x);if(old)return old;
  const source=await this.sourceWithin(db,actor,{roomId:x.roomId,messageIds:x.materials.map(item=>item.messageId)},{write:true});
  if(source.ctx.room.revision!==x.roomVersion)fail('chat_report_target_changed',409,{version:source.ctx.room.revision});
  if(Number((await db.query("SELECT count(*) AS n FROM account_chat_reports_v1 WHERE reporter_account_id=$1 AND room_id=$2 AND state NOT IN ('resolved','withdrawn')",[actor.accountId,x.roomId])).rows[0].n)>=3)fail('chat_report_open_limit',409);
  const materials=await this.captureWithin(db,actor,x.roomId,x.materials,{source}),now=stamp(this.now());
  const parties=[...new Set([...source.ctx.members.map(member=>member.subject_id),...source.ctx.parties,...materials.map(material=>material.authorRef),chatActorRef(actor)])];
  const row=(await db.query(`INSERT INTO account_chat_reports_v1(id,endpoint,room_id,reporter_account_id,target_version,category,party_refs,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,[x.operationId,this.endpoint,x.roomId,actor.accountId,x.roomVersion,x.category,JSON.stringify(parties),now])).rows[0];
  await this.insertEventWithin(db,row,actor,x,'report',1);
  await this.saveMaterialsWithin(db,row,x.operationId,materials);
  return this.viewWithin(db,row,actor);
 });}
 async insertEventWithin(db,row,actor,input,kind,version,{operator=false}={}){
  await db.query(`INSERT INTO account_chat_governance_events_v1(id,report_id,actor_kind,account_id,operator_id,http_request_id,version,kind,input,summary,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[input.operationId,row.id,operator?actor.kind:'official-account',operator?null:actor.accountId,operator?actor.operatorId:null,actor.httpRequestId??null,version,kind,JSON.stringify(input),input.summary,stamp(this.now())]);
 }
 restriction(input,maximum){if(!input.scopes.length||input.until<=this.now()||input.until>this.now()+maximum)fail('chat_report_restriction_invalid',400);}
 async applyEventWithin(db,actor,x,{operator=false}={}){
  if(operator)actor=await this.businessAdmin.authorizeOperation(actor,'chat-report-event',{kind:x.kind},{db});
  await db.query('SELECT pg_advisory_xact_lock(734912326,hashtext($1))',[x.operationId]);
  const old=await this.priorWithin(db,actor,x,{operator});if(old)return old;
  const row=await this.row(db,x.reportId,{write:true}),context=await this.contextWithin(db,row,actor,{operator});
  if(this.expired(row))fail('chat_report_materials_expired',410);
  if(row.version!==x.expectedVersion)fail('chat_report_version_changed',409,{version:row.version,state:row.state});
  if(decisions.has(x.kind)){if(!context.canModerate)fail('chat_report_moderation_denied',403);}
  else if(operator||!context.party)fail('chat_report_response_denied',403);
  if(x.materials?.length&&!['supplement','appeal'].includes(x.kind))fail('invalid_chat_report_request',400);
  if(row.version>=100&&!['resume','withdraw-report'].includes(x.kind))fail('chat_report_event_limit',409);
  const restricted=!!row.restriction_until&&Date.parse(row.restriction_until)>this.now()*1000;
  const messageRestricted=await this.messageVisibility.caseBlockedWithin(db,row.id);
  let state=row.state,scopes=row.restriction_scopes,until=row.restriction_until,restrictionEvent=row.restriction_event_id,decision=row.decision_event_id,closed=row.closed_at,appeals=row.appeal_count;
  if(x.kind==='supplement'){if(state==='withdrawn')fail('chat_report_state',409);}
  else if(x.kind==='withdraw-report'){if(!context.reporter||state==='withdrawn')fail('chat_report_state',409);state='withdrawn';closed=stamp(this.now());}
  else if(x.kind==='appeal'){if(!(state==='resolved'||restricted||messageRestricted)||appeals>=3)fail('chat_report_state',409);state='appealed';closed=null;appeals++;}
  else if(x.kind==='review'){if(!['received','appealed','reviewing'].includes(state))fail('chat_report_state',409);state='reviewing';}
  else if(x.kind==='resume'){if(!restricted)fail('chat_report_state',409);scopes=[];until=null;restrictionEvent=null;}
  else if(x.kind==='pause'||x.kind==='resolve'){
   if(terminal.has(state))fail('chat_report_state',409);
   const target=await this.currentTargetWithin(db,row);if(!target||target.version!==x.targetVersion)fail('chat_report_target_changed',409,{version:target?.version??null});
   if(x.kind==='pause'){this.restriction(x,7*86400);state='reviewing';scopes=x.scopes;until=stamp(x.until);restrictionEvent=x.operationId;}
   else{
    if(x.verdict==='dismissed'&&x.restriction)fail('chat_report_restriction_invalid',400);
    if(x.restriction)this.restriction(x.restriction,30*86400);
    state='resolved';closed=stamp(this.now());decision=x.operationId;scopes=x.restriction?.scopes??[];until=x.restriction?stamp(x.restriction.until):null;restrictionEvent=x.restriction?x.operationId:null;
   }
  }
  const materials=x.materials?.length?await this.captureWithin(db,actor,row.room_id,x.materials):[];
  await this.insertEventWithin(db,row,actor,x,x.kind,row.version+1,{operator});
  const parties=[...new Set([...row.party_refs,...materials.map(material=>material.authorRef)])];
  const updated=(await db.query(`UPDATE account_chat_reports_v1 SET version=version+1,state=$2,restriction_scopes=$3,restriction_until=$4,restriction_event_id=$5,decision_event_id=$6,closed_at=$7,appeal_count=$8,updated_at=$9,party_refs=$10 WHERE id=$1 RETURNING *`,[row.id,state,JSON.stringify(scopes),until,restrictionEvent,decision,closed,appeals,stamp(this.now()),JSON.stringify(parties)])).rows[0];
  await this.saveMaterialsWithin(db,row,x.operationId,materials);
  if(operator)await this.businessAdmin.recordWithin(db,actor,'chat-report-event',{operationId:x.operationId,selection:{reportId:row.id,kind:x.kind,roomId:row.room_id},result:{version:updated.version,state:updated.state}});
  return this.viewWithin(db,updated,actor,{operator});
 }
 event(actor,input){const x=parse(accountChatReportEventSchema,input);if(decisions.has(x.kind))fail('chat_report_moderation_denied',403);return this.run(actor,true,db=>this.applyEventWithin(db,actor,x));}
 operatorEvent(operator,input){const actor=this.operator(operator,{write:true}),x=parse(accountChatReportEventSchema,input);if(!decisions.has(x.kind))fail('chat_report_moderation_denied',403);return transaction(this.db,db=>this.applyEventWithin(db,actor,x,{operator:true}));}
 operatorMessageVisibility(operator,target,input,options){return this.messageVisibility.command(operator,target,input,options);}
 async purgeExpired({limit=100}={}){
  if(!Number.isInteger(limit)||limit<1||limit>500)fail('invalid_chat_report_request',400);
  return transaction(this.db,async db=>{
   const ids=(await db.query('SELECT r.id FROM account_chat_reports_v1 r WHERE closed_at<=$1 AND EXISTS(SELECT 1 FROM account_chat_governance_events_v1 e WHERE e.report_id=r.id AND e.erased_at IS NULL) ORDER BY closed_at LIMIT $2 FOR UPDATE',[stamp(this.now()-180*86400),limit])).rows.map(row=>row.id);
   if(!ids.length)return{erasedCases:0};
   await db.query("UPDATE account_chat_governance_materials_v1 SET text='',attachments='[]',erased_at=COALESCE(erased_at,$2) WHERE report_id=ANY($1::uuid[])",[ids,stamp(this.now())]);
   await db.query("UPDATE account_chat_governance_events_v1 SET summary='',input=jsonb_build_object('operationId',id,'reportId',report_id,'kind',kind),erased_at=COALESCE(erased_at,$2) WHERE report_id=ANY($1::uuid[])",[ids,stamp(this.now())]);
   return{erasedCases:ids.length};
  });
 }
}
