import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chatFixture,invite} from './chat-workflow.mjs';
import {PersonalSummaryService,createSummarySourceReader} from '../src/personal-summaries.mjs';
import {NotificationService} from '../src/notifications.mjs';
import {NotificationInboxService} from '../src/notification-inbox.mjs';
import {subjectResourceUsage,defaultResourceBudgetPolicy} from '../src/infrastructure/resource-budgets.mjs';
export async function summaryFixture(options={}){
 const transport={available:true,project:async()=>{},send:async x=>({archiveId:x.messageId}),erase:async()=>({deleted:true})};
 const f=await chatFixture({...options,transport,scopes:['binding','notifications']}),{chat,people:[a,b]}=f;
 const roomId=randomUUID();await chat.create(a,{roomId,operationId:randomUUID(),title:'Personal ordinary discussion'});await invite(chat,a,roomId,b);
 const message=await chat.send(a,roomId,{clientMessageId:randomUUID(),text:'Compare two valid approaches'});
 message.sequence=String((await f.db.query('SELECT sequence FROM chat_message_refs WHERE message_id=$1',[message.messageId])).rows[0].sequence);
 const legacy=new NotificationService(chat.access,null,null,null),inbox=new NotificationInboxService({access:chat.access,notifications:legacy,chat});
 const summaries=new PersonalSummaryService({db:options.runtimeDb??f.db,access:chat.access,sourceReader:createSummarySourceReader(chat)});
 const content=(text='The alternatives remain undecided')=>({generator:{kind:'user-model',label:'explicit test model output; no model call'},
  coverage:{fromSequence:'0',throughSequence:message.sequence,complete:false},
  fragments:[{id:randomUUID(),kind:'derived',text,sourceRefs:[{messageId:message.messageId,revision:1}]}],keyMessageRefs:[{messageId:message.messageId,revision:1}]});
 return{...f,inbox,legacy,summaries,roomId,message,content};
}
export async function verifySummaryWorkflow(options={}){
 const f=await summaryFixture(options);try{const {summaries,inbox,people:[a,b,c],roomId,message,content}=f;
  const p0=await summaries.preferences(b);assert.equal(p0.enabled,false);assert.equal(p0.revision,0);
  const first={versionId:randomUUID(),summaryId:randomUUID(),roomId,baseRevision:0,preferenceRevision:0,content:content()};
  await assert.rejects(async()=>summaries.put(b,first),/sync_not_authorized/);
  await assert.rejects(async()=>summaries.savePreference(b,{expectedRevision:0,endpoint:'https://different.example.org',enabled:true}),/target_mismatch/);
  const pref=await summaries.savePreference(b,{expectedRevision:0,endpoint:summaries.endpoint,enabled:true});first.preferenceRevision=pref.revision;
  const result=await summaries.put(b,first);assert.equal(result.syncState,'synced');assert.equal(result.sharedToRoom,false);assert.equal(result.audience,'owner-only');
  assert.equal(result.current.expiresAt,new Date((f.now()+30*86400)*1000).toISOString());
  assert.equal((await summaries.get(c,{summaryId:first.summaryId})).current,null,'Private replica never leaks across subjects');
  const deletionId=randomUUID();await f.db.query(`INSERT INTO deletion_requests(id,subject_id,binding_id,requester_public_key,payload_text,payload_hash,signature,state,revision)
   VALUES($1,$2,$3,'fixture-public-key','{}','fixture-hash','fixture-signature','requested',1)`,[deletionId,a.subjectId,a.bindingId]);
  const withheld=await summaries.get(b,{summaryId:first.summaryId});assert.equal(withheld.current.content.fragments.length,0);assert.equal(withheld.current.sourcesTemporarilyUnavailable,true);
  await summaries.purgeInvalidSources();assert.equal((await f.db.query('SELECT content FROM personal_summary_versions WHERE version_id=$1',[first.versionId])).rows[0].content.fragments.length,1,'Temporary source restriction does not permanently erase the retained replica');
  await f.db.query("UPDATE deletion_requests SET state='cancelled' WHERE id=$1",[deletionId]);assert.equal((await summaries.get(b,{summaryId:first.summaryId})).current.content.fragments.length,1);
  const expires=result.current.expiresAt;f.advance(2);assert.equal((await summaries.put(b,first)).current.expiresAt,expires,'Retry is not effective update');
  const second={...first,versionId:randomUUID(),baseRevision:1,content:content('First device proposal')};
  const third={...second,versionId:randomUUID(),content:content('Second device competing proposal')};
  const writes=await Promise.all([summaries.put(b,second),summaries.put(b,third)]);assert.equal(writes.filter(r=>r.syncState==='conflict').length,1);
  const dual=await summaries.get(b,{summaryId:first.summaryId});assert.equal(dual.conflicts.length,1);assert.equal(dual.current.revision,2);
  const budget=await subjectResourceUsage(f.db,b.subjectId,f.now());f.chat.access.resourceBudgetPolicy={...defaultResourceBudgetPolicy,maxPayloadBytesPerSubject:Number(budget.payloadBytes)};
  await assert.rejects(async()=>summaries.put(b,{...first,summaryId:randomUUID(),versionId:randomUUID(),content:content('增大'.repeat(1000))}),/storage_quota_exceeded/);
  f.chat.access.resourceBudgetPolicy=null;
  await summaries.put(b,{...second,versionId:randomUUID(),baseRevision:2,resolveVersionIds:dual.conflicts.map(v=>v.versionId),content:content('Explicit selected merge')});
  assert.equal((await summaries.get(b,{summaryId:first.summaryId})).conflicts.length,0);
  const items=(await inbox.query(b)).items;assert(items.some(i=>i.id==='room-message:'+message.messageId));
  const id='room-message:'+message.messageId,claim1={id,deliveryClientId:randomUUID(),claimId:randomUUID()},claim2={id,deliveryClientId:randomUUID(),claimId:randomUUID()};
  const claims=await Promise.all([inbox.claim(b,claim1),inbox.claim(b,claim2)]);assert.equal(claims.filter(c=>c.claimed).length,1);
  f.advance(31);const retry=await inbox.claim(b,claim2);assert.equal(retry.claimed,true,'Crashed client does not swallow prompt');
  assert.equal((await inbox.presented(b,claim1)).presented,false);assert.equal((await inbox.presented(b,claim2)).presented,true);
  assert.equal((await inbox.claim(b,claim1)).claimed,false);assert((await inbox.query(b,{unreadOnly:true})).items.some(i=>i.id===id),'Display and Agent query never mark human read');
  await assert.rejects(async()=>inbox.markRead(b,{id,reader:'agent'}),/invalid_inbox/);await inbox.markRead(b,{id,reader:'human'});assert(!(await inbox.query(b,{unreadOnly:true})).items.some(i=>i.id===id));
  const another=await f.chat.send(a,roomId,{clientMessageId:randomUUID(),text:'Not an interrupt while muted'});
  await inbox.saveOptions(b,{expectedRevision:0,settings:{mutedRoomIds:[roomId]}});
  assert.equal((await inbox.claim(b,{...claim1,id:'room-message:'+another.messageId})).claimed,false);
  await inbox.saveOptions(b,{expectedRevision:1,settings:{blockedSubjectIds:[a.subjectId]}});
  assert.equal(await f.chat.access.runAuthorized(b,'notifications',db=>inbox.isBlockedWithin(db,a.subjectId,b.subjectId)),true);
  assert(!(await inbox.query(b)).items.some(i=>i.object.messageId===another.messageId));
  await f.chat.retract(a,roomId,message.messageId);assert((await summaries.purgeInvalidSources()).changed>0);
  const invalid=await summaries.get(b,{summaryId:first.summaryId});assert.equal(invalid.current.content.fragments.length,0);assert.equal(invalid.current.content.keyMessageRefs.length,0);
  const expiring={...first,summaryId:randomUUID(),versionId:randomUUID(),content:{...content(),generator:{kind:'manual'},fragments:[{id:randomUUID(),kind:'personal-note',text:'Expiry fixture note',sourceRefs:[]}],keyMessageRefs:[]}};
  await summaries.put(b,expiring);
  await f.db.query('UPDATE personal_summary_versions SET expires_at=$3 WHERE subject_id=$1 AND version_id=$2',[b.subjectId,expiring.versionId,new Date((f.now()-1)*1000).toISOString()]);
  const expired=await summaries.get(b,{summaryId:expiring.summaryId});assert.equal(expired.current.state,'expired');assert.deepEqual(expired.current.content,{});
  const p=await summaries.savePreference(b,{expectedRevision:1,endpoint:summaries.endpoint,enabled:false});assert.equal(p.enabled,false);
  await assert.rejects(async()=>summaries.put(b,{...first,versionId:randomUUID(),preferenceRevision:p.revision}),/sync_not_authorized/);
  const old=await summaries.get(b,{summaryId:first.summaryId});assert.equal((await summaries.delete(b,{summaryId:first.summaryId,expectedRevision:old.revision})).localDeleted,false);
  assert.equal((await summaries.get(b,{summaryId:first.summaryId})).current.state,'deleted');
  return{ownerOnly:true,conflictsRetained:true,sourceRevocation:true,quota:true,presentationLease:true,readSeparate:true};
 }finally{await f.close();}}
