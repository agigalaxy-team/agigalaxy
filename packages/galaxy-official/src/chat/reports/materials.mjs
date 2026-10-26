import {transaction} from "../../infrastructure/database.mjs";
import {accountChatReportSourceSchema,accountChatReportAttachmentSchema} from "../../shared/account-chat-governance-schema.mjs";
import {iso,fail,parse,deletionStates} from './helpers.mjs';
import {ChatReportAuthority} from './authority.mjs';
import {fileAccessWithin} from '../../operations/files/access-gate.mjs';

// Exact selected revisions and attachment qualification. The mandatory current request verifier and storage-before/after checks remain unchanged.
export class ChatReportMaterials extends ChatReportAuthority{
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
  if(!ref.startsWith('account:'))return{authorAccountId:null,authorDisplayName:null,authorUid:null};
  const account=(await db.query('SELECT a.id,a.uid,p.display_name FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=$1 AND a.endpoint=$2',[ref.slice(8),this.endpoint])).rows[0];
  return{authorAccountId:account?.id??null,authorDisplayName:account?.display_name??null,authorUid:account?.uid??null};
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
  if(this.expired(row)||!(context.reporter||context.operator&&context.independent&&context.canReadMaterials))return[];
  const materials=(await db.query('SELECT * FROM account_chat_governance_materials_v1 WHERE report_id=$1 ORDER BY event_id,sent_at,message_id',[row.id])).rows,result=[];
  for(const material of materials){
   const available=await this.sourceStillAvailableWithin(db,material),attachments=[];
   if(available)for(const selected of material.attachments){
    const file=await this.chat.attachments?.row(db,selected.attachmentId);
    const readable=(!context.operator||context.canReadAttachments)&&file&&file.room_id===material.room_id&&file.message_id===material.message_id&&this.chat.attachments.status(file)==='available'&&!await this.chat.attachments.authorPending(db,file)
     &&!(await fileAccessWithin(db,{endpoint:this.endpoint,kind:'chat',id:file.id,now:this.now()})).stopped;
    attachments.push(readable?{...selected,state:'available',contentAvailable:true}:{attachmentId:selected.attachmentId,state:'unavailable',contentAvailable:false});
   }
   result.push({eventId:material.event_id,messageId:material.message_id,revision:material.revision,roomId:material.room_id,authorRef:material.author_ref,...(available?await this.authorWithin(db,material.author_ref):{authorAccountId:null,authorDisplayName:null,authorUid:null}),sentAt:iso(material.sent_at),sourceExpiresAt:iso(material.source_expires_at),
    state:available?'available':'unavailable',text:available?material.text:null,attachments,sourcePath:'/app/rooms/'+material.room_id+'?message='+material.message_id,
    moderation:await this.messageVisibility.viewWithin(db,row,context,material,{available})});
  }
  return result;
 }
 async operatorAttachment(operator,input,{authorize=null}={}){const actor=this.operator(operator),x=parse(accountChatReportAttachmentSchema,input);
  // A stored role lookup cannot replace the current HTTP session on this
  // sensitive read. Omitting the request-bound verifier must fail closed.
  if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);
  return transaction(this.db,async db=>{
  const authorizeCurrent=async()=>{
   const fresh=await this.businessAdmin.authorizeAction(await authorize(),'chat-reports.attachments.read',{db});
   if(fresh.operatorId!==actor.operatorId||fresh.endpoint!==actor.endpoint)fail('business_admin_denied',403);
   return fresh;
  };
  const assertCase=async()=>{
   const fresh=await authorizeCurrent(),row=await this.row(db,x.reportId),context=await this.contextWithin(db,row,fresh,{operator:true});
   if(!context.independent||this.expired(row))fail('chat_report_attachment_unavailable',404);
   const materials=(await db.query('SELECT * FROM account_chat_governance_materials_v1 WHERE report_id=$1 AND attachments @> $2::jsonb ORDER BY event_id FOR SHARE',[row.id,JSON.stringify([{attachmentId:x.attachmentId}])])).rows;
   for(const material of materials)if(await this.sourceStillAvailableWithin(db,material))return{roomId:material.room_id,messageId:material.message_id,revision:material.revision};
   fail('chat_report_attachment_unavailable',404);
  };
  const selected=await assertCase();if(!this.chat.attachments)fail('attachment_service_unavailable',503);
  const result=await this.chat.attachments.selectedCaseContentWithin(db,{attachmentId:x.attachmentId,...selected,assertCase});
  await authorizeCurrent();
  await this.businessAdmin.recordWithin(db,actor,'chat-report-attachment',{selection:{reportId:x.reportId,attachmentId:x.attachmentId},result:{bytes:result.bytes.length}});return result;
 });}
}
