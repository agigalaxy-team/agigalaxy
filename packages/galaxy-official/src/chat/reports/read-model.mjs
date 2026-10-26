import {transaction} from "../../infrastructure/database.mjs";
import {chatActorRef} from "../chat-actors.mjs";
import {operationsOperatorNamesWithin} from "../../operations/accounts/history-identities.mjs";
import {accountChatReportQuerySchema,accountChatReportReadSchema,accountChatReportReceiptSchema} from "../../shared/account-chat-governance-schema.mjs";
import {iso,parse,decisions} from './helpers.mjs';
import {ChatReportMaterials} from './materials.mjs';

// Current account/operator directories, history, metadata projections and original account receipts. Withheld material and expired-source names remain withheld.
export class ChatReportReadModel extends ChatReportMaterials{
 async viewWithin(db,row,actor,{operator=false,detail=true}={}){
  const context=await this.contextWithin(db,row,actor,{operator}),expired=this.expired(row),target=await this.currentTargetWithin(db,row);
  const effective=row.restriction_until&&Date.parse(row.restriction_until)>this.now()*1000;
  const messageRestricted=await this.messageVisibility.caseBlockedWithin(db,row.id);
  const materialCount=Number((await db.query('SELECT count(*) AS n FROM account_chat_governance_materials_v1 WHERE report_id=$1 AND erased_at IS NULL',[row.id])).rows[0].n);
  const base={reportId:row.id,target:{type:'room',id:row.room_id,version:row.target_version},currentTarget:target,category:row.category,materialCount,additionalMaterialCapacity:Math.max(0,20-materialCount),
   version:row.version,state:row.state,reporterAccountId:context.reporter||context.operator&&context.independent?row.reporter_account_id:null,
   createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),closedAt:iso(row.closed_at),handling:row.state==='received'?'awaiting-handler':'recorded',
   ownRestriction:effective?{scopes:row.restriction_scopes,until:iso(row.restriction_until),eventId:row.restriction_event_id}:null,
   canModerate:(context.operator?context.canManageCase:context.canModerate)&&!expired,canRespond:!context.operator&&context.party&&row.state!=='withdrawn'&&!expired,
   canWithdraw:context.reporter&&row.state!=='withdrawn'&&!expired,
   canAppeal:!context.operator&&context.party&&(row.state==='resolved'||effective||messageRestricted)&&row.appeal_count<3&&!expired,
   materialsExpired:expired,roomHistoryGranted:false,readExpiresAt:this.now()+60};
  if(!detail)return base;
  const events=(await db.query('SELECT * FROM account_chat_governance_events_v1 WHERE report_id=$1 ORDER BY version',[row.id])).rows;
  base.events=events.map(event=>{
   const visible=!expired&&!event.erased_at&&(context.reporter||context.operator&&context.independent&&context.canReadMaterials||!context.operator&&decisions.has(event.kind)||event.account_id===actor.accountId);
   return{eventId:event.id,kind:event.kind,version:event.version,at:iso(event.created_at),actorKind:event.actor_kind,
    accountId:visible?event.account_id:null,operatorId:visible?event.operator_id:null,summary:visible?event.summary:null,
    ...(visible&&['pause','resolve'].includes(event.kind)?{decision:{rule:event.input.rule,verdict:event.input.verdict??null,scopes:event.input.scopes??event.input.restriction?.scopes??[],until:event.input.until??event.input.restriction?.until??null}}:{}),
    ...(visible&&['message-hide','message-restore','message-keep'].includes(event.kind)?{decision:{message:{messageId:event.input.messageId,revision:event.input.messageRevision,action:event.input.action,hidden:event.input.action!=='restore'}}}:{})};
  });
  base.materials=await this.materialsWithin(db,row,context);
  if(context.operator){
   const selected=base.materials.filter(material=>material.state==='available').flatMap(material=>[material.moderation?.initialDecision,material.moderation?.currentDecision].filter(Boolean)),
    names=await operationsOperatorNamesWithin(db,{endpoint:this.endpoint,operatorIds:[...base.events.filter(event=>event.actorKind==='business-operator').map(event=>event.operatorId),...selected.map(decision=>decision.operatorId)]}),
    decisionName=(decision,available)=>decision?{...decision,operatorDisplayName:available?names.get(decision.operatorId)??null:null}:null;
   base.events=base.events.map(event=>({...event,operatorDisplayName:event.actorKind==='business-operator'?names.get(event.operatorId)??null:null}));
   base.materials=base.materials.map(material=>material.moderation?{...material,moderation:{...material.moderation,
    initialDecision:decisionName(material.moderation.initialDecision,material.state==='available'),currentDecision:decisionName(material.moderation.currentDecision,material.state==='available')}}:material);
  }
  if(base.materials.length)base.readExpiresAt=Math.min(base.readExpiresAt,...base.materials.filter(item=>item.state==='available').flatMap(item=>[Math.floor(Date.parse(item.sourceExpiresAt)/1000),...item.attachments.filter(file=>file.state==='available').map(file=>Math.floor(Date.parse(file.expiresAt)/1000))]));
  return base;
 }
 get(actor,input){const x=parse(accountChatReportReadSchema,input);return this.run(actor,false,async db=>this.viewWithin(db,await this.row(db,x.reportId),actor));}
 query(actor,input={}){const x=parse(accountChatReportQuerySchema,input);return this.run(actor,false,async db=>{
  const rows=(await db.query(`SELECT * FROM account_chat_reports_v1 r WHERE endpoint=$1 AND (reporter_account_id=$2 OR party_refs @> $3::jsonb OR EXISTS(SELECT 1 FROM chat_memberships m WHERE m.room_id=r.room_id AND m.subject_id=$4 AND m.left_at IS NULL))
   AND ($5::uuid IS NULL OR room_id=$5) AND ($6::text IS NULL OR state=$6) AND ($7::uuid IS NULL OR id>$7) ORDER BY id LIMIT $8`,[this.endpoint,actor.accountId,JSON.stringify([chatActorRef(actor)]),chatActorRef(actor),x.roomId??null,x.state??null,x.after??null,x.limit+1])).rows;
  const selected=rows.slice(0,x.limit);return{items:await Promise.all(selected.map(row=>this.viewWithin(db,row,actor,{detail:false}))),nextAfter:rows.length>x.limit?selected.at(-1).id:null,readExpiresAt:this.now()+60};
 });}
 receipt(actor,input){const x=parse(accountChatReportReceiptSchema,input);return this.run(actor,false,async db=>{
  const event=(await db.query("SELECT * FROM account_chat_governance_events_v1 WHERE id=$1 AND actor_kind='official-account' AND account_id=$2",[x.operationId,actor.accountId])).rows[0];
  if(!event)return{operationId:x.operationId,state:'absent'};const row=await this.row(db,event.report_id);await this.contextWithin(db,row,actor);
  return{operationId:x.operationId,state:'recorded',reportId:row.id,version:event.version,currentVersion:row.version};
 });}
 async operatorQuery(operator,input={}){this.operator(operator);const x=parse(accountChatReportQuerySchema,input);return transaction(this.db,async db=>{
  const actor=await this.businessAdmin.authorizeAction(operator,'chat-reports.read',{db});
  const rows=(await db.query(`SELECT * FROM account_chat_reports_v1 WHERE endpoint=$1 AND ($2::uuid IS NULL OR room_id=$2) AND ($3::text IS NULL OR state=$3) AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT $5`,[this.endpoint,x.roomId??null,x.state??null,x.after??null,x.limit+1])).rows;
  const selected=rows.slice(0,x.limit),items=[];for(const row of selected)items.push(await this.viewWithin(db,row,actor,{operator:true,detail:false}));
  await this.businessAdmin.recordWithin(db,actor,'chat-reports-query',{selection:{roomId:x.roomId??null,state:x.state??null,after:x.after??null,limit:x.limit},result:{reportIds:items.map(item=>item.reportId)}});
  return{items,nextAfter:rows.length>x.limit?selected.at(-1).id:null,readExpiresAt:this.now()+60};
 });}
 async operatorGet(operator,input){this.operator(operator);const x=parse(accountChatReportReadSchema,input);return transaction(this.db,async db=>{
  const actor=await this.businessAdmin.authorizeAction(operator,'chat-reports.read',{db});
  const row=await this.row(db,x.reportId),result=await this.viewWithin(db,row,actor,{operator:true});
  await this.businessAdmin.recordWithin(db,actor,'chat-report-read',{selection:{reportId:row.id},result:{materials:result.materials.length,canModerate:result.canModerate}});return result;
 });}
}
