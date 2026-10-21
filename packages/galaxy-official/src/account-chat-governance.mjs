import {isDeepStrictEqual} from 'node:util';
import {transaction} from './database.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {chatActorRef} from './chat-actors.mjs';
import {lockControllerMappingsWithin} from './controller-mapping-lock.mjs';
import {accountChatReportSchema,accountChatReportSourceSchema,accountChatReportQuerySchema,accountChatReportReadSchema,accountChatReportReceiptSchema,accountChatReportEventSchema,accountChatReportAttachmentSchema} from './shared/account-chat-governance-schema.mjs';

const stamp=value=>new Date(value*1000).toISOString(),iso=value=>value?new Date(value).toISOString():null;
const fail=(code,status=409,details)=>{throw new ServiceError(code,status,details);};
const parse=(schema,input)=>{const result=schema.safeParse(input);if(!result.success)fail('invalid_chat_report_request',400);return result.data;};
const decisions=new Set(['review','pause','resume','resolve']);
const terminal=new Set(['resolved','withdrawn']);
const deletionStates="('requested','review-needed','approved','partial','primary-erased')";

// Account participation, Native identity control and operations authority are
// distinct principals. Case material is a selected disclosure, not room access.
export class AccountChatGovernanceService {
 constructor({chat,businessAdmin,now=chat.now}){Object.assign(this,{chat,businessAdmin,now});this.db=chat.db;this.endpoint=chat.access.endpoint;}
 account(actor){if(actor?.kind!=='official-account'||actor.endpoint!==this.endpoint)fail('chat_report_account_required',401);return actor;}
 run(actor,write,fn){this.account(actor);return this.chat.run(actor,write,fn,{control:true});}
 operator(actor,{write=false}={}){if(!this.businessAdmin)fail('business_admin_unavailable',503);return this.businessAdmin.require(actor,{write});}
 configuration(){return{categories:['advertising','harassment','privacy','misrepresentation','other'],maxMaterials:20,maxAttachmentsPerMessage:16,maxSummaryLength:1600,materialDisclosure:'explicitly-selected-messages-and-attachments',roomHistoryGranted:false};}
 expired(row){return !!row.closed_at&&new Date(row.closed_at).getTime()+180*86400000<=this.now()*1000;}
 async row(db,id,{write=false}={}){const row=(await db.query(`SELECT * FROM account_chat_reports_v1 WHERE id=$1 AND endpoint=$2 FOR ${write?'UPDATE':'SHARE'}`,[id,this.endpoint])).rows[0];if(!row)fail('chat_report_unavailable',404);return row;}
 async currentTargetWithin(db,row){const room=(await db.query('SELECT room_id,revision,state FROM chat_rooms WHERE room_id=$1 FOR SHARE',[row.room_id])).rows[0];return room?{type:'room',id:room.room_id,version:room.revision,state:room.state}:null;}
 async partyWithin(db,row,actor){
  const ref=chatActorRef(actor);if(row.reporter_account_id===actor.accountId||row.party_refs.includes(ref))return true;
  return !!(await db.query('SELECT 1 FROM chat_memberships WHERE room_id=$1 AND subject_id=$2 AND left_at IS NULL',[row.room_id,ref])).rows.length;
 }
 async independentWithin(db,row,operator){
  // This is an authorization predicate for known case relationships, not a
  // claim about a person's real-world independence. A management principal is
  // required; a normal Galaxy account is not. Only exact issuer+subject keys
  // can identify an existing business relationship here. Equal email addresses
  // or equal subject strings from different realms never create one.
  const principal=(await db.query('SELECT issuer,external_subject FROM operations_operator_principals_v1 WHERE operator_id=$1 AND endpoint=$2 FOR SHARE',[operator.operatorId,this.endpoint])).rows[0];
  if(!principal)fail('business_admin_denied',403);
  await db.query('SELECT room_id FROM chat_rooms WHERE room_id=$1 FOR SHARE',[row.room_id]);
  const refs=[...row.party_refs,...(await db.query('SELECT subject_id,controller_ref FROM chat_memberships WHERE room_id=$1 AND left_at IS NULL',[row.room_id])).rows.flatMap(member=>[member.subject_id,member.controller_ref]).filter(Boolean)];
  await lockControllerMappingsWithin(db,this.endpoint,refs.filter(ref=>/^GUID[A-Z0-9]{28}$/.test(ref)));
  const accounts=(await db.query('SELECT id FROM community_accounts WHERE endpoint=$1 AND issuer=$2 AND external_subject=$3',[this.endpoint,principal.issuer,principal.external_subject])).rows;
  for(const account of accounts){
   if(account.id===row.reporter_account_id||refs.includes('account:'+account.id))return false;
   const linked=(await db.query(`SELECT l.subject_id FROM community_account_links l JOIN external_identity_links e ON e.id=l.identity_link_id WHERE l.account_id=$1 AND e.endpoint=$2 AND e.revoked_at IS NULL`,[account.id,this.endpoint])).rows;
   if(linked.some(link=>refs.includes(link.subject_id)||refs.includes('subject:'+link.subject_id)))return false;
  }
  return true;
 }
 async contextWithin(db,row,actor,{operator=false}={}){
  if(operator){const actual=this.operator(actor),independent=await this.independentWithin(db,row,actual);return{operator:true,independent,reporter:false,party:!independent,canModerate:actual.role==='administrator'&&independent};}
  this.account(actor);const party=await this.partyWithin(db,row,actor);if(!party)fail('chat_report_unavailable',404);
  return{operator:false,independent:false,reporter:row.reporter_account_id===actor.accountId,party,canModerate:false};
 }
 async sourceWithin(db,actor,{roomId,messageIds},{write=false}={}){
  const ctx=await this.chat.requireRoom(db,actor,roomId,{write});
  if(!messageIds.length)return{ctx,messages:[],readExpiresAt:this.now()+60};
  const rows=await this.chat.messageRowsWithin(db,actor,roomId,'m.message_id=ANY($3::uuid[])',[messageIds]);
  const reading=await this.chat.readMessagesWithin(db,actor,ctx,rows,{});
  if(messageIds.some(id=>!reading.messages.some(message=>message.messageId===id&&message.state==='accepted')))fail('chat_report_source_unavailable',409);
  return{ctx,...reading};
 }
 async source(actor,input){const x=parse(accountChatReportSourceSchema,input);return this.run(actor,false,async db=>{
  const source=await this.sourceWithin(db,actor,x);
  const messages=[];for(const message of source.messages)messages.push({...message,...await this.authorWithin(db,message.subjectId)});
  return{roomId:x.roomId,roomVersion:source.ctx.room.revision,title:source.ctx.room.title,readExpiresAt:source.readExpiresAt,
   authors:source.ctx.members.map(member=>({authorRef:member.subject_id,authorDisplayName:member.display_name??null,authorUid:member.uid??null})),
   messages:messages.map(message=>({messageId:message.messageId,revision:message.revision,authorRef:message.subjectId,authorDisplayName:message.authorDisplayName,authorUid:message.authorUid,sentAt:message.sentAt,expiresAt:message.expiresAt,text:message.text,
    attachments:(message.attachments??[]).filter(file=>file.state==='available').map(file=>({attachmentId:file.attachmentId,name:file.name,mediaType:file.mediaType,size:file.size,expiresAt:file.expiresAt,state:'available'}))}))};
 });}
 async authorWithin(db,ref){
  if(!ref.startsWith('account:'))return{authorDisplayName:null,authorUid:null};
  const account=(await db.query('SELECT a.uid,p.display_name FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=$1 AND a.endpoint=$2',[ref.slice(8),this.endpoint])).rows[0];
  return{authorDisplayName:account?.display_name??null,authorUid:account?.uid??null};
 }
 async captureWithin(db,actor,roomId,selections,{source=null}={}){
  if(!selections.length)return[];
  const reading=source??await this.sourceWithin(db,actor,{roomId,messageIds:selections.map(item=>item.messageId)},{write:true});
  const captured=[];
  for(const selection of selections){
   const message=reading.messages.find(item=>item.messageId===selection.messageId);
   if(!message||message.revision!==selection.revision)fail('chat_report_source_changed',409);
   const attachments=[];
   for(const id of selection.attachmentIds){
    const file=message.attachments?.find(item=>item.attachmentId===id&&item.state==='available');
    if(!file)fail('chat_report_attachment_unavailable',409);
    const row=await this.chat.attachments.row(db,id);
    if(!row||row.room_id!==roomId||row.message_id!==message.messageId)fail('chat_report_attachment_unavailable',409);
    await this.chat.attachments.readableWithin(db,actor,row);
    attachments.push({attachmentId:id,name:file.name,mediaType:file.mediaType,size:file.size,expiresAt:iso(file.expiresAt)});
   }
   captured.push({messageId:message.messageId,revision:message.revision,roomId,authorRef:message.subjectId,sentAt:iso(message.sentAt),sourceExpiresAt:iso(message.expiresAt),text:message.text??'',attachments});
  }
  // The archive and attachment reads may wait on external storage. Compare the
  // exact selected versions again; never silently attach their replacement.
  const current=await this.chat.messageRowsWithin(db,actor,roomId,'m.message_id=ANY($3::uuid[])',[selections.map(item=>item.messageId)]);
  for(const selected of captured)if(!this.chat.visibleRows(current).some(row=>row.message_id===selected.messageId&&row.state==='accepted'&&row.revision===selected.revision))fail('chat_report_source_changed',409);
  return captured;
 }
 async saveMaterialsWithin(db,row,eventId,materials){
  const count=Number((await db.query('SELECT count(*) AS n FROM account_chat_governance_materials_v1 WHERE report_id=$1 AND erased_at IS NULL',[row.id])).rows[0].n);
  // Bound the whole case, not each round of supplements, so its current
  // authorized projection remains readable by ordinary bounded clients.
  if(count+materials.length>20)fail('chat_report_material_limit',409,{available:Math.max(0,20-count)});
  for(const item of materials){
   await db.query(`INSERT INTO account_chat_governance_materials_v1(report_id,event_id,message_id,revision,room_id,author_ref,sent_at,source_expires_at,text,attachments)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[row.id,eventId,item.messageId,item.revision,item.roomId,item.authorRef,item.sentAt,item.sourceExpiresAt,item.text,JSON.stringify(item.attachments)]);
  }
 }
 async sourceStillAvailableWithin(db,material){
  if(material.erased_at||Date.parse(material.source_expires_at)<=this.now()*1000)return false;
  const message=(await db.query(`SELECT m.* FROM chat_message_refs m WHERE m.message_id=$1 AND m.room_id=$2 FOR SHARE`,[material.message_id,material.room_id])).rows[0];
  if(!message||message.state!=='accepted'||message.revision!==material.revision||Date.parse(message.expires_at)<=this.now()*1000)return false;
  if((await db.query(`SELECT id FROM deletion_requests WHERE subject_id=$1 AND state IN ${deletionStates} LIMIT 1`,[material.author_ref])).rows.length)return false;
  return true;
 }
 async materialsWithin(db,row,context){
  if(this.expired(row)||!(context.reporter||context.operator&&context.independent))return[];
  const materials=(await db.query('SELECT * FROM account_chat_governance_materials_v1 WHERE report_id=$1 ORDER BY event_id,sent_at,message_id',[row.id])).rows,result=[];
  for(const material of materials){
   const available=await this.sourceStillAvailableWithin(db,material),attachments=[];
   if(available)for(const selected of material.attachments){
    const file=await this.chat.attachments?.row(db,selected.attachmentId);
    const readable=file&&file.room_id===material.room_id&&file.message_id===material.message_id&&this.chat.attachments.status(file)==='available'&&!await this.chat.attachments.authorPending(db,file);
    attachments.push(readable?{...selected,state:'available',contentAvailable:true}:{attachmentId:selected.attachmentId,state:'unavailable',contentAvailable:false});
   }
   result.push({eventId:material.event_id,messageId:material.message_id,revision:material.revision,roomId:material.room_id,authorRef:material.author_ref,...(available?await this.authorWithin(db,material.author_ref):{authorDisplayName:null,authorUid:null}),sentAt:iso(material.sent_at),sourceExpiresAt:iso(material.source_expires_at),
    state:available?'available':'unavailable',text:available?material.text:null,attachments,sourcePath:'/app/rooms/'+material.room_id+'?message='+material.message_id});
  }
  return result;
 }
 async viewWithin(db,row,actor,{operator=false,detail=true}={}){
  const context=await this.contextWithin(db,row,actor,{operator}),expired=this.expired(row),target=await this.currentTargetWithin(db,row);
  const effective=row.restriction_until&&Date.parse(row.restriction_until)>this.now()*1000;
  const materialCount=Number((await db.query('SELECT count(*) AS n FROM account_chat_governance_materials_v1 WHERE report_id=$1 AND erased_at IS NULL',[row.id])).rows[0].n);
  const base={reportId:row.id,target:{type:'room',id:row.room_id,version:row.target_version},currentTarget:target,category:row.category,materialCount,additionalMaterialCapacity:Math.max(0,20-materialCount),
   version:row.version,state:row.state,reporterAccountId:context.reporter||context.operator&&context.independent?row.reporter_account_id:null,
   createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),closedAt:iso(row.closed_at),handling:row.state==='received'?'awaiting-handler':'recorded',
   ownRestriction:effective?{scopes:row.restriction_scopes,until:iso(row.restriction_until),eventId:row.restriction_event_id}:null,
   canModerate:context.canModerate&&!expired,canRespond:!context.operator&&context.party&&row.state!=='withdrawn'&&!expired,
   canWithdraw:context.reporter&&row.state!=='withdrawn'&&!expired,
   canAppeal:!context.operator&&context.party&&(row.state==='resolved'||effective)&&row.appeal_count<3&&!expired,
   materialsExpired:expired,roomHistoryGranted:false,readExpiresAt:this.now()+60};
  if(!detail)return base;
  const events=(await db.query('SELECT * FROM account_chat_governance_events_v1 WHERE report_id=$1 ORDER BY version',[row.id])).rows;
  base.events=events.map(event=>{
   const visible=!expired&&!event.erased_at&&(context.reporter||context.operator&&context.independent||decisions.has(event.kind)||event.account_id===actor.accountId);
   return{eventId:event.id,kind:event.kind,version:event.version,at:iso(event.created_at),actorKind:event.actor_kind,
    accountId:visible?event.account_id:null,operatorId:visible?event.operator_id:null,summary:visible?event.summary:null,
    ...(visible&&['pause','resolve'].includes(event.kind)?{decision:{rule:event.input.rule,verdict:event.input.verdict??null,scopes:event.input.scopes??event.input.restriction?.scopes??[],until:event.input.until??event.input.restriction?.until??null}}:{})};
  });
  base.materials=await this.materialsWithin(db,row,context);
  if(base.materials.length)base.readExpiresAt=Math.min(base.readExpiresAt,...base.materials.filter(item=>item.state==='available').flatMap(item=>[Math.floor(Date.parse(item.sourceExpiresAt)/1000),...item.attachments.filter(file=>file.state==='available').map(file=>Math.floor(Date.parse(file.expiresAt)/1000))]));
  return base;
 }
 async priorWithin(db,actor,input,{operator=false}={}){
  const event=(await db.query('SELECT * FROM account_chat_governance_events_v1 WHERE id=$1 FOR SHARE',[input.operationId])).rows[0];
  if(!event)return null;
  if(event.actor_kind!==(operator?'business-operator':'official-account')||(operator?event.operator_id!==actor.operatorId:event.account_id!==actor.accountId)||!isDeepStrictEqual(event.input,input))fail('chat_report_operation_conflict',409);
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
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[input.operationId,row.id,operator?'business-operator':'official-account',operator?null:actor.accountId,operator?actor.operatorId:null,actor.httpRequestId??null,version,kind,JSON.stringify(input),input.summary,stamp(this.now())]);
 }
 restriction(input,maximum){if(!input.scopes.length||input.until<=this.now()||input.until>this.now()+maximum)fail('chat_report_restriction_invalid',400);}
 async applyEventWithin(db,actor,x,{operator=false}={}){
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
  let state=row.state,scopes=row.restriction_scopes,until=row.restriction_until,restrictionEvent=row.restriction_event_id,decision=row.decision_event_id,closed=row.closed_at,appeals=row.appeal_count;
  if(x.kind==='supplement'){if(state==='withdrawn')fail('chat_report_state',409);}
  else if(x.kind==='withdraw-report'){if(!context.reporter||state==='withdrawn')fail('chat_report_state',409);state='withdrawn';closed=stamp(this.now());}
  else if(x.kind==='appeal'){if(!(state==='resolved'||restricted)||appeals>=3)fail('chat_report_state',409);state='appealed';closed=null;appeals++;}
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
 async operatorQuery(operator,input={}){const actor=this.operator(operator),x=parse(accountChatReportQuerySchema,input);return transaction(this.db,async db=>{
  const rows=(await db.query(`SELECT * FROM account_chat_reports_v1 WHERE endpoint=$1 AND ($2::uuid IS NULL OR room_id=$2) AND ($3::text IS NULL OR state=$3) AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT $5`,[this.endpoint,x.roomId??null,x.state??null,x.after??null,x.limit+1])).rows;
  const selected=rows.slice(0,x.limit),items=[];for(const row of selected)items.push(await this.viewWithin(db,row,actor,{operator:true,detail:false}));
  await this.businessAdmin.recordWithin(db,actor,'chat-reports-query',{selection:{state:x.state??null,after:x.after??null,limit:x.limit},result:{reportIds:items.map(item=>item.reportId)}});
  return{items,nextAfter:rows.length>x.limit?selected.at(-1).id:null,readExpiresAt:this.now()+60};
 });}
 async operatorGet(operator,input){const actor=this.operator(operator),x=parse(accountChatReportReadSchema,input);return transaction(this.db,async db=>{
  const row=await this.row(db,x.reportId),result=await this.viewWithin(db,row,actor,{operator:true});
  await this.businessAdmin.recordWithin(db,actor,'chat-report-read',{selection:{reportId:row.id},result:{materials:result.materials.length,canModerate:result.canModerate}});return result;
 });}
 operatorEvent(operator,input){const actor=this.operator(operator,{write:true}),x=parse(accountChatReportEventSchema,input);if(!decisions.has(x.kind))fail('chat_report_moderation_denied',403);return transaction(this.db,db=>this.applyEventWithin(db,actor,x,{operator:true}));}
 async operatorAttachment(operator,input){const actor=this.operator(operator),x=parse(accountChatReportAttachmentSchema,input);return transaction(this.db,async db=>{
  const authorize=async()=>{
   const row=await this.row(db,x.reportId),context=await this.contextWithin(db,row,actor,{operator:true});
   if(!context.independent||this.expired(row))fail('chat_report_attachment_unavailable',404);
   const materials=(await db.query('SELECT * FROM account_chat_governance_materials_v1 WHERE report_id=$1 AND attachments @> $2::jsonb ORDER BY event_id FOR SHARE',[row.id,JSON.stringify([{attachmentId:x.attachmentId}])])).rows;
   for(const material of materials)if(await this.sourceStillAvailableWithin(db,material))return{roomId:material.room_id,messageId:material.message_id,revision:material.revision};
   fail('chat_report_attachment_unavailable',404);
  };
  const selected=await authorize();if(!this.chat.attachments)fail('attachment_service_unavailable',503);
  const result=await this.chat.attachments.selectedCaseContentWithin(db,{attachmentId:x.attachmentId,...selected,assertCase:authorize});
  await this.businessAdmin.recordWithin(db,actor,'chat-report-attachment',{selection:{reportId:x.reportId,attachmentId:x.attachmentId},result:{bytes:result.bytes.length}});return result;
 });}
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
