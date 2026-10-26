import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {chatFixture,invite} from './chat-workflow.mjs';
import {attachmentContractFixture} from './chat-attachments-workflow.mjs';
import {ChatAttachmentsService} from '../src/chat-attachments.mjs';
import {PersonalSummaryService,createSummarySourceReader} from '../src/personal-summaries.mjs';
import {ChatSharedSummaryService} from '../src/chat-shared-summaries.mjs';
import {NotificationService} from '../src/notifications.mjs';
import {NotificationInboxService} from '../src/notification-inbox.mjs';
import {serviceFixture} from './service-fixture.mjs';
import {ChatService} from '../src/chat.mjs';
import {OutcomeMaterialServiceV2} from '../src/outcome-material-v2.mjs';
import {createAccountUid} from '../src/official-account-uid.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
function messageTransport(){
 const messages=new Map();
 return{available:true,project:async()=>{},send:async value=>{messages.set(value.messageId,{archiveId:value.messageId,text:value.text,revision:1});return{archiveId:value.messageId};},
  read:async input=>input.ids.flatMap(id=>messages.has(id)?[structuredClone(messages.get(id))]:[]),
  erase:async value=>{messages.delete(value.archiveId??value.messageId);return{archiveDeleted:true};}};
}
// The authenticated operator command is tested by the core suite. These explicit
// SQL heads isolate consumer behavior; they do not prove command authorization.
async function seedBlock(db,{endpoint,roomId,messageId,parties,now}){
 const accountId=randomUUID(),reportId=randomUUID(),eventId=randomUUID(),at=new Date(now*1000).toISOString();
 await db.query("INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at,uid) VALUES($1,$2,'https://fixture.invalid',$3,'email',$4,$4,$5)",
  [accountId,endpoint,randomUUID(),at,createAccountUid()]);
 await db.query("INSERT INTO account_chat_reports_v1(id,endpoint,room_id,reporter_account_id,target_version,category,party_refs,state,created_at,updated_at) VALUES($1,$2,$3,$4,1,'other',$5,'reviewing',$6,$6)",
  [reportId,endpoint,roomId,accountId,JSON.stringify(parties),at]);
 await db.query("INSERT INTO account_chat_governance_events_v1(id,report_id,actor_kind,operator_id,version,kind,input,summary,created_at) VALUES($1,$2,'business-operator','synthetic-consumer-head',1,'message-hide','{}','Synthetic consumer coverage',$3)",[eventId,reportId,at]);
 await db.query('INSERT INTO operations_chat_message_visibility_v1(endpoint,report_id,message_id,message_revision,revision,hidden,initial_event_id,current_event_id,updated_at) VALUES($1,$2,$3,1,1,true,$4,$4,$5)',[endpoint,reportId,messageId,eventId,at]);
 return{reportId,setHidden:(hidden,tx=db)=>tx.query('UPDATE operations_chat_message_visibility_v1 SET hidden=$3 WHERE endpoint=$1 AND report_id=$2',[endpoint,reportId,hidden])};
}

test('operations block gates own attachment bytes, reversible derived summaries, shared notice and current message notifications', {timeout:60000}, async()=>{
 const f=await chatFixture({transport:messageTransport(),scopes:['binding','notifications']});
 try{
  const{db,chat,people:[a,b]}=f,roomId=randomUUID(),contract=attachmentContractFixture(),files=new ChatAttachmentsService({chat,store:contract.store,scanner:contract.scanner});
  chat.attachments=files;
  await chat.create(a,{roomId,operationId:randomUUID(),title:'Synthetic consumer room'});await invite(chat,a,roomId,b);
  const bytes=Buffer.from('Synthetic operations-gated attachment.\n'),attachment={attachmentId:randomUUID(),roomId,name:'consumer.txt',mediaType:'text/plain',size:bytes.length,sha256:hash(bytes),purpose:'temporary-room-attachment',confirmed:true};
  await files.prepare(a,attachment);await files.upload(a,attachment.attachmentId,Readable.from([bytes]),{contentLength:bytes.length});await files.scanPending();
  const sent=await chat.send(a,roomId,{clientMessageId:randomUUID(),text:'Synthetic source text',attachments:[{id:attachment.attachmentId,sha256:attachment.sha256}]}),
   reference={messageId:sent.messageId,revision:1},
   content={generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'1',complete:false},fragments:[{id:randomUUID(),kind:'derived',text:'Synthetic derived text',sourceRefs:[reference]}],keyMessageRefs:[reference]};
  const summaries=new PersonalSummaryService({db,access:chat.access,sourceReader:createSummarySourceReader(chat),now:f.now}),
   preference=await summaries.savePreference(b,{expectedRevision:0,endpoint:chat.access.endpoint,enabled:true}),
   own={summaryId:randomUUID(),versionId:randomUUID(),roomId,baseRevision:0,preferenceRevision:preference.revision,content};
  await summaries.put(b,own);
  const shared=new ChatSharedSummaryService({db,access:chat.access,chat,now:f.now}),
   published=await shared.publish(b,{shareId:randomUUID(),roomId,expectedMemberRevision:(await chat.get(b,roomId)).memberRevision,audience:'room-authorized-members',content}),
   inbox=new NotificationInboxService({access:chat.access,notifications:new NotificationService(chat.access,null,null,null),chat});
  assert((await inbox.query(b)).items.some(item=>item.object?.messageId===sent.messageId));
  const initialFile=await files.get(a,{attachmentId:attachment.attachmentId}),
   blocked=await seedBlock(db,{endpoint:chat.access.endpoint,roomId,messageId:sent.messageId,parties:[a.subjectId,b.subjectId],now:f.now()});
  await assert.rejects(files.content(b,{attachmentId:attachment.attachmentId}),error=>error.code==='attachment_message_unavailable');
  await assert.rejects(files.content(a,{attachmentId:attachment.attachmentId},{ownExport:true}),error=>error.code==='attachment_message_unavailable');
  const withheld=await summaries.get(b,{summaryId:own.summaryId});
  assert.deepEqual(withheld.current.content.fragments,[]);assert.equal(withheld.current.sourcesTemporarilyUnavailable,true);
  const sharedWithheld=await shared.get(b,{roomId,shareId:published.shareId});
  assert.deepEqual(sharedWithheld.content.fragments,[]);assert.equal(sharedWithheld.sourcesTemporarilyUnavailable,true);
  assert(!(await inbox.query(b)).items.some(item=>item.object?.messageId===sent.messageId));
  await assert.rejects(inbox.claim(b,{id:'room-message:'+sent.messageId,deliveryClientId:randomUUID(),claimId:randomUUID()}),error=>error.code==='notification_not_found');
  await summaries.purgeInvalidSources();await shared.purgeInvalidSources();
  assert.equal((await db.query('SELECT content FROM personal_summary_versions WHERE version_id=$1',[own.versionId])).rows[0].content.fragments.length,1);
  assert.equal((await db.query('SELECT content FROM room_shared_summaries WHERE share_id=$1',[published.shareId])).rows[0].content.fragments.length,1);
  await blocked.setHidden(false);
  assert.equal((await summaries.get(b,{summaryId:own.summaryId})).current.content.fragments.length,1);
  assert.equal((await shared.get(a,{roomId,shareId:published.shareId})).content.fragments.length,1);
  assert((await inbox.query(b)).items.some(item=>item.object?.messageId===sent.messageId));
  assert.deepEqual((await files.content(a,{attachmentId:attachment.attachmentId},{ownExport:true})).bytes,bytes);
  const notice=await seedBlock(db,{endpoint:chat.access.endpoint,roomId,messageId:published.messageId,parties:[a.subjectId,b.subjectId],now:f.now()});
  const noticeWithheld=await shared.get(a,{roomId,shareId:published.shareId});
  assert.deepEqual(noticeWithheld.content,{});assert.deepEqual(noticeWithheld.sourceFacts,[]);assert.equal(noticeWithheld.sourcesTemporarilyUnavailable,true);
  assert.deepEqual((await shared.exportOwnedWithin(db,b)).items.find(item=>item.shareId===published.shareId).content,{});
  assert(!(await inbox.query(a)).items.some(item=>item.object?.messageId===published.messageId));
  assert.equal((await db.query('SELECT state FROM chat_message_refs WHERE message_id=$1',[published.messageId])).rows[0].state,'accepted');
  await notice.setHidden(false);
  assert.equal((await shared.get(a,{roomId,shareId:published.shareId})).content.fragments.length,1);
  const sourceReader=shared.filter.sourceReader;let blockDuringSource=true;
  shared.filter.sourceReader=async(tx,who,ref)=>{const value=await sourceReader(tx,who,ref);if(blockDuringSource){blockDuringSource=false;await notice.setHidden(true,tx);}return value;};
  const lateNotice=await shared.get(a,{roomId,shareId:published.shareId});
  assert.deepEqual(lateNotice.content,{});assert.deepEqual(lateNotice.sourceFacts,[]);assert.equal(lateNotice.sourcesTemporarilyUnavailable,true);
  assert.equal((await db.query('SELECT content FROM room_shared_summaries WHERE share_id=$1',[published.shareId])).rows[0].content.fragments.length,1,'A late notice block hides the projection without erasing the retained copy');
  shared.filter.sourceReader=sourceReader;await notice.setHidden(false);
  const get=contract.store.get.bind(contract.store),run=chat.run.bind(chat);let blockDuringBytes=true,authorizedDb=null;
  // PGlite serializes transactions. Schedule this fixture transition in the
  // existing authorized transaction rather than pretending it is another DB.
  chat.run=(actor,write,operation,options)=>run(actor,write,db=>{authorizedDb=db;return operation(db);},options);
  contract.store.get=async input=>{const value=await get(input);if(blockDuringBytes){blockDuringBytes=false;await blocked.setHidden(true,authorizedDb);}return value;};
  await assert.rejects(files.content(a,{attachmentId:attachment.attachmentId},{ownExport:true}),error=>error.code==='attachment_message_unavailable');
  chat.run=run;
  await blocked.setHidden(false);
  assert.equal(new Date((await files.get(a,{attachmentId:attachment.attachmentId})).expiresAt).getTime(),new Date(initialFile.expiresAt).getTime());
  await db.query('UPDATE chat_message_refs SET expires_at=$2 WHERE message_id=$1',[sent.messageId,new Date((f.now()-1)*1000).toISOString()]);
  assert.deepEqual((await summaries.get(b,{summaryId:own.summaryId})).current.content.fragments,[]);
  assert.equal((await db.query('SELECT content FROM personal_summary_versions WHERE version_id=$1',[own.versionId])).rows[0].content.fragments.length,0,'Removing operations block never restores an expired source');
 }finally{await f.close();}
});

test('original outcome preview rechecks operations block after the final consent await without creating or restoring a source copy', {timeout:60000}, async()=>{
 const scopes=['binding','consent','case-teaser','evidence'],now=Math.floor(Date.now()/1000),
  a=await serviceFixture(scopes,null,{now}),b=await serviceFixture(scopes,a.db,{now,migrateDatabase:false});
 try{
  const chat=new ChatService({db:a.db,access:a.access,transport:messageTransport(),now:()=>a.now,requireAccountWithin:async()=>{},consumeInviteWithin:async()=>{},markInviteRespondedWithin:async()=>{}}),
   materials=new OutcomeMaterialServiceV2(a.access,{consents:a.consents,chat,records:a.verificationRecords}),caseId=randomUUID(),
   root={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:a.actor.subjectId,localRef:randomUUID(),title:'Synthetic source preview',summary:'Consumer gate only',synthetic:true,source:{kind:'local',reference:randomUUID()}};
  await a.cases.submitV2(a.actor,await a.authorize(root,'case.teaser.publish',{objectId:caseId}));
  const roomId=randomUUID();await chat.create(a.actor,{roomId,operationId:randomUUID(),title:'Synthetic outcome source'});await invite(chat,a.actor,roomId,b.actor);
  const sent=await chat.send(b.actor,roomId,{clientMessageId:randomUUID(),text:'Synthetic exact original source'}),
   selected=await chat.readSelectedWithin(a.db,a.actor,{messageId:sent.messageId,revision:1}),
   request={id:randomUUID(),materialId:randomUUID(),kind:'request',source:{kind:'message',id:sent.messageId,version:1,sha256:selected.contentHash,roomId},caseId,
    purpose:'Current source inspection',title:'Synthetic source',audience:{visibility:'Private',viewers:[b.actor.subjectId]},uses:['evidence'],
    retention:'with-related-result; independently-authorized-copy',requestExpiresAt:new Date((a.now+3600)*1000).toISOString()};
  await materials.request(a.actor,await a.authorize(request,'outcome.material',{objectId:request.id,viewers:[b.actor.subjectId]}));
  assert.equal((await materials.inspect(b.actor,{id:request.materialId,version:1})).sourceContent.content,'Synthetic exact original source');
  const head=await seedBlock(a.db,{endpoint:a.access.endpoint,roomId,messageId:sent.messageId,parties:[a.actor.subjectId,b.actor.subjectId],now:a.now});await head.setHidden(false);
  const requireConsent=materials.requireConsent.bind(materials);let calls=0;
  materials.requireConsent=async(db,event)=>{const value=await requireConsent(db,event);if(++calls===2)await head.setHidden(true,db);return value;};
  const withheld=await materials.inspect(b.actor,{id:request.materialId,version:1});
  assert.equal(withheld.sourceContent,null);assert.equal(withheld.sourceContentReason,'chat_message_version_unavailable');assert.equal(withheld.request.id,request.id);
  assert.equal((await a.db.query('SELECT body_text FROM outcome_materials_v2 WHERE id=$1',[request.materialId])).rows[0].body_text,'');
  materials.requireConsent=requireConsent;await head.setHidden(false);
  assert.equal((await materials.inspect(b.actor,{id:request.materialId,version:1})).sourceContent.content,'Synthetic exact original source');
  await a.db.query('UPDATE chat_message_refs SET expires_at=$2 WHERE message_id=$1',[sent.messageId,new Date((a.now-1)*1000).toISOString()]);
  assert.equal((await materials.inspect(b.actor,{id:request.materialId,version:1})).sourceContent,null);
 }finally{await a.db.close();}
});

